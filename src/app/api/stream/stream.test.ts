import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { StreamMessage } from "@/lib/domain";
import { heartbeat, registerAgent, removeAgent, reportStatus } from "@/server/agents";
import { createArena, deleteArena, getArena } from "@/server/arenas";
import { getDb } from "@/server/db/client";
import { changes, counters } from "@/server/db/schema";
import { pruneChanges } from "@/server/feed";
import { drainStreams, resetDraining } from "@/server/shutdown";
import { readSnapshot } from "@/server/snapshot";
import { ownerCookie, read, req, useBrokenDb } from "../../../../test/helpers";
import { GET, HEAD } from "./route";

type Conn = { next: (timeoutMs?: number) => Promise<StreamMessage>; close: () => void; res: Response };

async function connect(query = "", cookie?: string): Promise<Conn> {
  const controller = new AbortController();
  const base = req("GET", `/api/stream${query}`, { cookie: cookie ?? (await ownerCookie()) });
  const res = await GET(new Request(base, { signal: controller.signal }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: StreamMessage[] = [];
  const next = async (timeoutMs = 2000): Promise<StreamMessage> => {
    for (;;) {
      if (queue.length) return queue.shift()!;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs)),
      ]);
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data) queue.push(JSON.parse(data));
      }
    }
  };
  return { next, close: () => controller.abort(), res };
}

async function seed() {
  await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
  await createArena({ slug: "personal", name: "Personal", theme: "kitchen" }, Date.now());
  const career = await getArena("career");
  const personal = await getArena("personal");
  await reportStatus(career, "writer", { status: "working", activity: "drafting" }, Date.now());
  await reportStatus(career, "scout", { status: "done", result: "x".repeat(1000) }, Date.now());
  await reportStatus(personal, "chef", { status: "waiting", waitingOn: "human" }, Date.now());
  return { career, personal };
}

const withoutTime = (s: StreamMessage) => ({ ...s, serverTime: undefined });

describe("/api/stream", () => {
  it("starts every connection with a snapshot that matches the database, whatever changed while away", async () => {
    const { career } = await seed();
    const first = await connect();
    expect((await first.next()).type).toBe("snapshot");
    first.close();

    // While disconnected: remove an agent, delete an arena, create another, send a heartbeat.
    await removeAgent(career, "scout", Date.now());
    await deleteArena("personal");
    await createArena({ slug: "side", name: "Side", theme: "kitchen" }, Date.now());
    await heartbeat(career, "writer", { ttlSeconds: 60 }, Date.now() + 5000);

    const second = await connect();
    const snap = await second.next();
    second.close();
    expect(withoutTime(snap)).toEqual(withoutTime(await readSnapshot(null, Date.now())));
    if (snap.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snap.arenas.map((a) => a.slug).sort()).toEqual(["career", "side"]);
    expect(snap.agents.map((a) => a.key)).toEqual(["writer"]);
    expect(snap.agents[0].ttlSeconds).toBe(60);
  });

  it("sends a preview, not the full answer", async () => {
    await seed();
    const conn = await connect();
    const snap = await conn.next();
    conn.close();
    if (snap.type !== "snapshot") throw new Error("expected a snapshot");
    const scout = snap.agents.find((a) => a.key === "scout")!;
    expect(scout.hasResult).toBe(true);
    expect(scout.resultPreview!.length).toBeLessThan(300);
    expect("result" in scout).toBe(false);
  });

  it("follows the change feed after the snapshot: changes and presence, in order", async () => {
    const { career } = await seed();
    const conn = await connect();
    const snap = await conn.next();
    if (snap.type !== "snapshot") throw new Error("expected a snapshot");
    await reportStatus(career, "writer", { status: "done", result: "hi" }, Date.now());
    const upsert = await conn.next();
    if (upsert.type !== "agent.upserted") throw new Error(`expected agent.upserted, got ${upsert.type}`);
    expect(upsert.agent.status).toBe("done");
    expect(upsert.seq).toBeGreaterThan(snap.seq);
    await heartbeat(career, "writer", { leaving: true }, Date.now());
    const presence = await conn.next();
    expect(presence).toMatchObject({ type: "presence", key: "writer" });
    expect(presence.type === "presence" && presence.awaySince).toBeTruthy();
    expect(presence.type === "presence" && presence.seq).toBeGreaterThan(upsert.seq);
    conn.close();
  });

  it("sees writes made through another database connection (another server instance)", async () => {
    const { career } = await seed();
    const conn = await connect();
    await conn.next();
    // Simulate another instance: write straight into the feed table, as its writeTx would.
    const db = await getDb();
    await db.transaction(async (tx) => {
      const [{ value }] = await tx
        .update(counters)
        .set({ value: sql`${counters.value} + 1` })
        .where(sql`${counters.name} = 'seq'`)
        .returning({ value: counters.value });
      await tx.insert(changes).values({
        seq: Number(value),
        arenaId: career.id,
        message: { type: "agent.removed", seq: Number(value), arenaId: career.id, agentId: "elsewhere", key: "ghost" },
        createdAt: Date.now(),
      });
    });
    expect(await conn.next()).toMatchObject({ type: "agent.removed", key: "ghost" });
    conn.close();
  });

  it("a filtered stream only carries its arenas, including one created later with that slug", async () => {
    const { personal } = await seed();
    const conn = await connect("?arenas=career,later");
    const snap = await conn.next();
    if (snap.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snap.arenas.map((a) => a.slug)).toEqual(["career"]);
    await reportStatus(personal, "chef", { status: "working" }, Date.now()); // not ours
    await createArena({ slug: "later", name: "Later", theme: "office" }, Date.now());
    expect(await conn.next()).toMatchObject({ type: "arena.upserted", arena: { slug: "later" } });
    await reportStatus(await getArena("later"), "bot", { status: "working" }, Date.now());
    expect(await conn.next()).toMatchObject({ type: "agent.upserted", agent: { key: "bot" } });
    conn.close();
  });

  it("ends itself before the platform's time limit, telling the browser to reconnect", async () => {
    await seed();
    process.env.ARENA_STREAM_SECONDS = "0.2";
    const conn = await connect();
    await conn.next();
    expect(await conn.next()).toEqual({ type: "reconnect" });
    await expect(conn.next()).rejects.toThrow("stream ended");
  });

  it("starts over from a fresh snapshot when the feed was pruned past its cursor", async () => {
    const { career } = await seed();
    const conn = await connect();
    const first = await conn.next();
    if (first.type !== "snapshot") throw new Error("expected a snapshot");
    await reportStatus(career, "writer", { status: "done", result: "pruned away" }, Date.now() - 2 * 60 * 60 * 1000);
    // The change is older than the feed keeps; pruning removes it before the stream reads it.
    expect(await pruneChanges(Date.now())).toBeGreaterThan(0);
    const next = await conn.next();
    expect(next.type).toBe("snapshot");
    if (next.type !== "snapshot") return;
    expect(next.agents.find((a) => a.key === "writer")?.status).toBe("done");
    conn.close();
  });

  it("ends open streams when the server stops, and refuses new ones while it drains", async () => {
    await seed();
    const conn = await connect();
    await conn.next();
    try {
      drainStreams();
      await expect(conn.next()).rejects.toThrow("stream ended");
      const res = await GET(req("GET", "/api/stream", { cookie: await ownerCookie() }));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("3");
    } finally {
      resetDraining();
    }
  });

  it("refuses unauthenticated callers and arena tokens", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const anon = await GET(req("GET", "/api/stream"));
    expect(anon.status).toBe(401);
    const ingest = await GET(req("GET", "/api/stream", { token: apiKey.token }));
    expect(ingest.status).toBe(403);
    expect((await read(ingest)).error.code).toBe("forbidden");
  });

  it("HEAD runs the checks without opening a stream", async () => {
    await seed();
    const res = await HEAD(req("HEAD", "/api/stream", { cookie: await ownerCookie() }));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect((await HEAD(req("HEAD", "/api/stream"))).status).toBe(401);
  });

  it("answers with the JSON error envelope when the snapshot can't be read", async () => {
    const cookie = await ownerCookie();
    await useBrokenDb();
    const res = await GET(req("GET", "/api/stream", { cookie }));
    expect(res.status).toBe(500);
    expect((await read(res)).error.code).toBe("internal");
  });

  it("doesn't open a stream for a client that already went away", async () => {
    await seed();
    const controller = new AbortController();
    controller.abort();
    const res = await GET(new Request(req("GET", "/api/stream", { cookie: await ownerCookie() }), { signal: controller.signal }));
    expect(res.status).toBe(499);
  });

  it("ends an owner stream when the session expires", async () => {
    await seed();
    // A session that expires 300 ms from now.
    const cookie = await ownerCookie(Date.now() - 30 * 24 * 60 * 60 * 1000 + 300);
    const conn = await connect("", cookie);
    await conn.next();
    await new Promise((r) => setTimeout(r, 450));
    await expect(conn.next()).rejects.toThrow("stream ended");
  });

  it("drops a client that stops reading once its backlog is too big, discarding the backlog", async () => {
    const { career } = await seed();
    process.env.ARENA_STREAM_BACKLOG_BYTES = String(16 * 1024);
    const conn = await connect();
    await conn.next(); // read the snapshot, then stop reading
    for (let i = 0; i < 40; i += 1) {
      await registerAgent(career, `bulk-${i}`, { metadata: { pad: "y".repeat(1500) } }, Date.now());
    }
    await new Promise((r) => setTimeout(r, 300));
    // Erroring the stream discards what was queued, rather than keeping it for the reader: the
    // next read fails at once instead of returning the stale backlog.
    await expect(
      (async () => {
        for (;;) await conn.next(500);
      })(),
    ).rejects.toThrow(/client fell too far behind/);
  });
});
