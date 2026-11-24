import { describe, expect, it, vi } from "vitest";

// connection() needs a live Next request; outside one there is nothing to wait for.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
import * as agentRoute from "@/app/api/arenas/[slug]/agents/[key]/route";
import * as heartbeatRoute from "@/app/api/arenas/[slug]/agents/[key]/heartbeat/route";
import * as statusRoute from "@/app/api/arenas/[slug]/agents/[key]/status/route";
import * as agentsRoute from "@/app/api/arenas/[slug]/agents/route";
import * as eventsRoute from "@/app/api/arenas/[slug]/events/route";
import * as arenaRoute from "@/app/api/arenas/[slug]/route";
import * as keyRoute from "@/app/api/arenas/[slug]/keys/[id]/route";
import * as keysRoute from "@/app/api/arenas/[slug]/keys/route";
import * as arenasRoute from "@/app/api/arenas/route";
import * as healthRoute from "@/app/api/health/route";
import { LIMITS } from "@/lib/domain";
import { getDb } from "@/server/db/client";
import { agents, events } from "@/server/db/schema";
import { ADMIN_TOKEN, ownerCookie, params, read, req, rows, useBrokenDb } from "../../../test/helpers";

async function createArena(slug: string, theme = "office") {
  const res = await arenasRoute.POST(
    req("POST", "/api/arenas", { token: ADMIN_TOKEN, body: { slug, name: slug.toUpperCase(), theme } }),
    undefined,
  );
  expect(res.status).toBe(201);
  const body = (await read(res)) as { arena: { id: string; slug: string }; apiKey: { id: string; name: string; token: string } };
  return { arena: body.arena, apiKey: body.apiKey, ingestToken: body.apiKey.token };
}

function report(slug: string, key: string, token: string | undefined, body: unknown, cookie?: string) {
  return statusRoute.POST(
    req("POST", `/api/arenas/${slug}/agents/${key}/status`, { token, body, cookie }),
    params({ slug, key }),
  );
}

describe("auth matrix", () => {
  it("rejects a token from another arena with 403", async () => {
    const career = await createArena("career");
    await createArena("personal");
    const res = await report("personal", "bot", career.ingestToken, { status: "working" });
    expect(res.status).toBe(403);
    const readRes = await arenaRoute.GET(
      req("GET", "/api/arenas/personal", { token: career.ingestToken }),
      params({ slug: "personal" }),
    );
    expect(readRes.status).toBe(403);
  });

  it("ignores the owner cookie on writes (401)", async () => {
    await createArena("career");
    const res = await report("career", "bot", undefined, { status: "working" }, await ownerCookie());
    expect(res.status).toBe(401);
    expect((await read(res)).error.code).toBe("unauthorized");
  });

  it("rejects an unknown bearer token with 401", async () => {
    await createArena("career");
    const res = await report("career", "bot", "arena_nope", { status: "working" });
    expect(res.status).toBe(401);
  });

  it("lets an ingest token read its own arena while an owner password is set", async () => {
    const career = await createArena("career");
    const res = await arenaRoute.GET(
      req("GET", "/api/arenas/career", { token: career.ingestToken }),
      params({ slug: "career" }),
    );
    expect(res.status).toBe(200);
    expect((await read(res)).arena.slug).toBe("career");
  });

  it("does not let an ingest token list every arena", async () => {
    const career = await createArena("career");
    const res = await arenasRoute.GET(req("GET", "/api/arenas", { token: career.ingestToken }), undefined);
    expect(res.status).toBe(403);
  });

  it("reads with the owner cookie, and refuses anonymous reads when a password is set", async () => {
    await createArena("career");
    const owner = await arenasRoute.GET(req("GET", "/api/arenas", { cookie: await ownerCookie() }), undefined);
    expect(owner.status).toBe(200);
    const anon = await arenasRoute.GET(req("GET", "/api/arenas"), undefined);
    expect(anon.status).toBe(401);
    process.env.ARENA_ALLOW_ANONYMOUS_READ = "1";
    const open = await arenasRoute.GET(req("GET", "/api/arenas"), undefined);
    expect(open.status).toBe(200);
  });

  it("rejects an expired or tampered owner cookie", async () => {
    await createArena("career");
    const expired = await ownerCookie(Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect((await arenasRoute.GET(req("GET", "/api/arenas", { cookie: expired }), undefined)).status).toBe(401);
    const tampered = (await ownerCookie()).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await arenasRoute.GET(req("GET", "/api/arenas", { cookie: tampered }), undefined)).status).toBe(401);
  });

  it("needs the admin token to create, rename, delete arenas and rotate tokens", async () => {
    const career = await createArena("career");
    const create = await arenasRoute.POST(
      req("POST", "/api/arenas", { token: career.ingestToken, body: { slug: "x", name: "X" } }),
      undefined,
    );
    expect(create.status).toBe(403);
    const rename = await arenaRoute.PATCH(
      req("PATCH", "/api/arenas/career", { cookie: await ownerCookie(), body: { name: "New" } }),
      params({ slug: "career" }),
    );
    expect(rename.status).toBe(401);
    const keys = await keysRoute.POST(
      req("POST", "/api/arenas/career/keys", { token: career.ingestToken, body: { name: "sneaky" } }),
      params({ slug: "career" }),
    );
    expect(keys.status).toBe(403);
    const reveal = await keyRoute.GET(
      req("GET", `/api/arenas/career/keys/${career.apiKey.id}`, { cookie: await ownerCookie() }),
      params({ slug: "career", id: career.apiKey.id }),
    );
    expect(reveal.status).toBe(401);
  });

  it("keeps /api/health open", async () => {
    const res = await healthRoute.GET(req("GET", "/api/health"), undefined);
    expect(res.status).toBe(200);
  });

  it("reports a health failure in the JSON error envelope", async () => {
    await useBrokenDb();
    const res = await healthRoute.GET(req("GET", "/api/health"), undefined);
    expect(res.status).toBe(500);
    expect((await read(res)).error.code).toBe("internal");
  });

  it("only the admin token can delete an arena", async () => {
    const career = await createArena("career");
    const del = (init: { token?: string; cookie?: string }) =>
      arenaRoute.DELETE(req("DELETE", "/api/arenas/career", init), params({ slug: "career" }));
    expect((await del({ token: career.ingestToken })).status).toBe(403);
    expect((await del({ cookie: await ownerCookie() })).status).toBe(401);
    const still = await arenaRoute.GET(req("GET", "/api/arenas/career", { token: ADMIN_TOKEN }), params({ slug: "career" }));
    expect(still.status).toBe(200);
  });

  it("treats a malformed session cookie as no session, not a 500", async () => {
    await createArena("career");
    const res = await arenasRoute.GET(req("GET", "/api/arenas", { cookie: "arena_session=%E0%A4%A" }), undefined);
    expect(res.status).toBe(401);
  });

  it("charges a recognized token's rate limit even when the scope check fails", async () => {
    process.env.ARENA_RATE_LIMIT_PER_10S = "20";
    const career = await createArena("career");
    let last = 0;
    for (let i = 0; i < 60 && last !== 429; i += 1) {
      last = (await arenasRoute.POST(req("POST", "/api/arenas", { token: career.ingestToken, body: { slug: "x", name: "X" } }), undefined)).status;
    }
    expect(last).toBe(429);
  });
});

describe("arenas", () => {
  it("rejects a duplicate or reserved slug", async () => {
    await createArena("career");
    const dup = await arenasRoute.POST(
      req("POST", "/api/arenas", { token: ADMIN_TOKEN, body: { slug: "career", name: "Again" } }),
      undefined,
    );
    expect(dup.status).toBe(409);
    const reserved = await arenasRoute.POST(
      req("POST", "/api/arenas", { token: ADMIN_TOKEN, body: { slug: "new", name: "New" } }),
      undefined,
    );
    expect(reserved.status).toBe(400);
  });

  it("enforces the body limit on bodyless mutations before acting", async () => {
    const career = await createArena("career");
    const big = "x".repeat(300_000);
    const revoke = await keyRoute.DELETE(
      req("DELETE", `/api/arenas/career/keys/${career.apiKey.id}`, { token: ADMIN_TOKEN, raw: big }),
      params({ slug: "career", id: career.apiKey.id }),
    );
    expect(revoke.status).toBe(413);
    // The key still works, so nothing was revoked.
    expect((await report("career", "bot", career.ingestToken, { status: "idle" })).status).toBe(201);
    const del = await agentRoute.DELETE(
      req("DELETE", "/api/arenas/career/agents/bot", { token: career.ingestToken, raw: big }),
      params({ slug: "career", key: "bot" }),
    );
    expect(del.status).toBe(413);
    expect((await rows(agents))).toHaveLength(1);
  });

  it("re-checks the arena after the body arrives: deleting it mid-upload gives 4xx, not 500", async () => {
    const career = await createArena("career");
    let push!: (chunk: string) => void;
    let end!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
        end = () => controller.close();
      },
    });
    const pending = statusRoute.POST(
      new Request("http://localhost/api/arenas/career/agents/bot/status", {
        method: "POST",
        headers: { authorization: `Bearer ${career.ingestToken}`, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      params({ slug: "career", key: "bot" }),
    );
    push('{"status":');
    await new Promise((r) => setTimeout(r, 10));
    await arenaRoute.DELETE(req("DELETE", "/api/arenas/career", { token: ADMIN_TOKEN }), params({ slug: "career" }));
    push('"working"}');
    end();
    const res = await pending;
    // The key died with the arena, so the re-check rejects it.
    expect(res.status).toBe(401);
  });

  it("manages named API keys: create, list, copy again, revoke one without breaking the others", async () => {
    const career = await createArena("career");
    expect(career.apiKey.name).toBe("default");
    const created = await keysRoute.POST(
      req("POST", "/api/arenas/career/keys", { token: ADMIN_TOKEN, body: { name: "laptop" } }),
      params({ slug: "career" }),
    );
    expect(created.status).toBe(201);
    const laptop = await read(created);
    expect(laptop.token).toMatch(/^arena_/);
    expect((await report("career", "bot", laptop.token, { status: "idle" })).status).toBe(201);

    const dup = await keysRoute.POST(
      req("POST", "/api/arenas/career/keys", { token: ADMIN_TOKEN, body: { name: "laptop" } }),
      params({ slug: "career" }),
    );
    expect(dup.status).toBe(409);

    const list = await read(await keysRoute.GET(req("GET", "/api/arenas/career/keys", { token: ADMIN_TOKEN }), params({ slug: "career" })));
    expect(list.keys.map((k: { name: string }) => k.name)).toEqual(["default", "laptop"]);
    expect(JSON.stringify(list)).not.toContain(laptop.token);
    expect(list.keys.find((k: { name: string }) => k.name === "laptop")).toMatchObject({ copyable: true, prefix: `${laptop.token.slice(0, 10)}…` });
    // The key was just used, so its last use is recorded.
    expect(list.keys.find((k: { name: string }) => k.name === "laptop").lastUsedAt).not.toBeNull();

    const revealed = await read(
      await keyRoute.GET(req("GET", `/api/arenas/career/keys/${laptop.key.id}`, { token: ADMIN_TOKEN }), params({ slug: "career", id: laptop.key.id })),
    );
    expect(revealed.token).toBe(laptop.token);

    const revoke = await keyRoute.DELETE(
      req("DELETE", `/api/arenas/career/keys/${laptop.key.id}`, { token: ADMIN_TOKEN }),
      params({ slug: "career", id: laptop.key.id }),
    );
    expect(revoke.status).toBe(204);
    expect((await report("career", "bot", laptop.token, { status: "working" })).status).toBe(401);
    expect((await report("career", "bot", career.ingestToken, { status: "working" })).status).toBe(200);
  });

  it("a changed encryption secret leaves keys working but no longer copyable", async () => {
    const career = await createArena("career");
    process.env.ARENA_ENCRYPTION_KEY = "a-completely-different-secret-0123456789";
    const list = await read(await keysRoute.GET(req("GET", "/api/arenas/career/keys", { token: ADMIN_TOKEN }), params({ slug: "career" })));
    expect(list.keys[0].copyable).toBe(false);
    const reveal = await keyRoute.GET(
      req("GET", `/api/arenas/career/keys/${career.apiKey.id}`, { token: ADMIN_TOKEN }),
      params({ slug: "career", id: career.apiKey.id }),
    );
    expect(reveal.status).toBe(409);
    expect((await report("career", "bot", career.ingestToken, { status: "idle" })).status).toBe(201);
  });

  it("renames and changes theme", async () => {
    await createArena("career");
    const res = await arenaRoute.PATCH(
      req("PATCH", "/api/arenas/career", { token: ADMIN_TOKEN, body: { name: "Career HQ", theme: "kitchen" } }),
      params({ slug: "career" }),
    );
    expect(res.status).toBe(200);
    expect((await read(res)).arena).toMatchObject({ name: "Career HQ", theme: "kitchen" });
  });

  it("deleting an arena cascades to its agents and events", async () => {
    const career = await createArena("career");
    await report("career", "bot", career.ingestToken, { status: "working" });
    expect((await rows(agents))).toHaveLength(1);
    const res = await arenaRoute.DELETE(
      req("DELETE", "/api/arenas/career", { token: ADMIN_TOKEN }),
      params({ slug: "career" }),
    );
    expect(res.status).toBe(204);
    expect((await rows(agents))).toHaveLength(0);
    expect((await rows(events))).toHaveLength(0);
  });

  it("lists arenas with counts", async () => {
    const career = await createArena("career");
    await report("career", "a", career.ingestToken, { status: "working" });
    await report("career", "b", career.ingestToken, { status: "waiting", waitingOn: "human" });
    await report("career", "c", career.ingestToken, { status: "done", result: "hi" });
    const res = await arenasRoute.GET(req("GET", "/api/arenas", { token: ADMIN_TOKEN }), undefined);
    const [arena] = (await read(res)).arenas;
    expect(arena.counts).toMatchObject({ working: 1, needsYou: 1, waiting: 0, done: 1, total: 3, away: 0 });
  });
});

describe("agents", () => {
  it("auto-registers on the first status report and replaces state on the next", async () => {
    const career = await createArena("career");
    const first = await report("career", "resume-writer", career.ingestToken, {
      status: "working",
      activity: "Tailoring resume",
      progress: 0.5,
      displayName: "Resume Writer",
    });
    expect(first.status).toBe(201);
    const a = (await read(first)).agent;
    expect(a).toMatchObject({ displayName: "Resume Writer", status: "working", activity: "Tailoring resume", progress: 0.5, seat: 0 });

    const second = await report("career", "resume-writer", career.ingestToken, { status: "done", result: "## Done" });
    expect(second.status).toBe(200);
    const b = (await read(second)).agent;
    expect(b).toMatchObject({ status: "done", activity: null, progress: null, hasResult: true, resultPreview: "## Done" });
    expect(b.version).toBeGreaterThan(a.version);
  });

  it("rejects fields that don't fit the status", async () => {
    const career = await createArena("career");
    const res = await report("career", "bot", career.ingestToken, { status: "working", result: "nope" });
    expect(res.status).toBe(400);
    expect((await read(res)).error.code).toBe("validation_failed");
    const bad = await report("career", "bot", career.ingestToken, { status: "sleeping" });
    expect(bad.status).toBe(400);
  });

  it("leaves waitingOn unset when the report omits it", async () => {
    const career = await createArena("career");
    await report("career", "bot", career.ingestToken, { status: "waiting", waitingOn: "human" });
    const { agent } = await read(await report("career", "bot", career.ingestToken, { status: "waiting" }));
    expect(agent.waitingOn).toBeNull();
  });

  it("limits error by UTF-8 bytes and activity by characters", async () => {
    const career = await createArena("career");
    expect((await report("career", "bot", career.ingestToken, { status: "error", error: "€".repeat(682) })).status).toBe(201);
    expect((await report("career", "bot", career.ingestToken, { status: "error", error: "€".repeat(683) })).status).toBe(400);
    expect((await report("career", "bot", career.ingestToken, { status: "working", activity: "😀".repeat(200) })).status).toBe(200);
    expect((await report("career", "bot", career.ingestToken, { status: "working", activity: "😀".repeat(201) })).status).toBe(400);
  });

  it("accepts any JSON value as metadata and any string as session", async () => {
    const career = await createArena("career");
    const put = await agentRoute.PUT(
      req("PUT", "/api/arenas/career/agents/bot", { token: career.ingestToken, body: { metadata: ["research", "draft"] } }),
      params({ slug: "career", key: "bot" }),
    );
    expect(put.status).toBe(201);
    expect((await read(put)).agent.metadata).toEqual(["research", "draft"]);
    const long = await report("career", "bot", career.ingestToken, { status: "idle", session: "r".repeat(500), seq: 1 });
    expect(long.status).toBe(200);
  });

  it("records the submitted body verbatim, while the agent row gets the trimmed value", async () => {
    const career = await createArena("career");
    const put = await agentRoute.PUT(
      req("PUT", "/api/arenas/career/agents/bot", { token: career.ingestToken, body: { displayName: "  Bot  " } }),
      params({ slug: "career", key: "bot" }),
    );
    expect((await read(put)).agent.displayName).toBe("Bot");
    const registered = (await rows(events)).find((e) => e.type === "agent.registered");
    expect(registered?.report).toEqual({ displayName: "  Bot  " });
    await report("career", "bot", career.ingestToken, { status: "idle", displayName: " Spaced " });
    const status = (await rows(events)).find((e) => e.type === "agent.status");
    expect(status?.report).toEqual({ status: "idle", displayName: " Spaced " });
  });

  it("rejects an invalid agent key", async () => {
    const career = await createArena("career");
    const res = await report("career", "Not Valid", career.ingestToken, { status: "idle" });
    expect(res.status).toBe(400);
  });

  it("truncates a long answer and still applies done", async () => {
    const career = await createArena("career");
    const result = "é".repeat(50_000); // 100,000 bytes of UTF-8
    const res = await report("career", "bot", career.ingestToken, { status: "done", result });
    expect(res.status).toBe(201);
    const { agent } = await read(res);
    expect(agent).toMatchObject({ status: "done", resultTruncated: true });
    const detail = await read(
      await agentRoute.GET(req("GET", "/api/arenas/career/agents/bot", { token: ADMIN_TOKEN }), params({ slug: "career", key: "bot" })),
    );
    expect(Buffer.byteLength(detail.agent.result, "utf8")).toBeLessThanOrEqual(LIMITS.resultBytes);
    expect(detail.agent.result).not.toContain("�");
    // History keeps the report exactly as submitted, untruncated.
    const event = (await rows(events)).find((e) => e.type === "agent.status");
    expect(event?.report).toEqual({ status: "done", result });
  });

  it("returns 413 for a body over 256 KB", async () => {
    const career = await createArena("career");
    const res = await report("career", "bot", career.ingestToken, { status: "done", result: "x".repeat(300_000) });
    expect(res.status).toBe(413);
  });

  it("returns 400 for invalid JSON", async () => {
    const career = await createArena("career");
    const res = await statusRoute.POST(
      req("POST", "/api/arenas/career/agents/bot/status", { token: career.ingestToken, raw: "{not json" }),
      params({ slug: "career", key: "bot" }),
    );
    expect(res.status).toBe(400);
    expect((await read(res)).error.code).toBe("invalid_json");
  });

  it("PUT is idempotent and keeps the seat", async () => {
    const career = await createArena("career");
    const put = (body: unknown) =>
      agentRoute.PUT(
        req("PUT", "/api/arenas/career/agents/bot", { token: career.ingestToken, body }),
        params({ slug: "career", key: "bot" }),
      );
    const first = await read(await put({ displayName: "Bot", role: "helper" }));
    const second = await put({ displayName: "Bot", role: "helper" });
    expect(second.status).toBe(200);
    const again = (await read(second)).agent;
    expect(again.version).toBe(first.agent.version);
    expect(again.seat).toBe(first.agent.seat);
    const registered = (await rows(events)).filter((e) => e.agentKey === "bot");
    expect(registered).toHaveLength(1);
    const changed = (await read(await put({ displayName: "Bot 2" }))).agent;
    expect(changed.version).toBeGreaterThan(first.agent.version);
    expect(changed.role).toBeNull();
  });

  it("gives out the lowest free seat and keeps seats stable when others leave", async () => {
    const career = await createArena("career");
    for (const key of ["a", "b", "c"]) await report("career", key, career.ingestToken, { status: "idle" });
    await agentRoute.DELETE(
      req("DELETE", "/api/arenas/career/agents/b", { token: career.ingestToken }),
      params({ slug: "career", key: "b" }),
    );
    const d = (await read(await report("career", "d", career.ingestToken, { status: "idle" }))).agent;
    expect(d.seat).toBe(1);
    const list = (await read(await agentsRoute.GET(req("GET", "/api/arenas/career/agents", { token: ADMIN_TOKEN }), params({ slug: "career" })))).agents;
    expect(list.map((x: { key: string; seat: number }) => [x.key, x.seat])).toEqual([
      ["a", 0],
      ["d", 1],
      ["c", 2],
    ]);
  });

  it("concurrent first reports never share a seat or pass the cap", async () => {
    // This test is about seats, not rate limits.
    process.env.ARENA_RATE_LIMIT_PER_10S = "100000";
    const career = await createArena("career");
    const keys = Array.from({ length: LIMITS.agentsPerArena + 5 }, (_, i) => `agent-${i}`);
    const responses = await Promise.all(keys.map((key) => report("career", key, career.ingestToken, { status: "working" })));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMITS.agentsPerArena);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    const seats = (await (await getDb()).select({ seat: agents.seat }).from(agents)).map((r) => r.seat);
    expect(new Set(seats).size).toBe(LIMITS.agentsPerArena);
  });

  it("heartbeat with leaving marks the agent away but keeps status and answer", async () => {
    const career = await createArena("career");
    await report("career", "bot", career.ingestToken, { status: "done", result: "answer" });
    const hb = await heartbeatRoute.POST(
      req("POST", "/api/arenas/career/agents/bot/heartbeat", { token: career.ingestToken, body: { leaving: true } }),
      params({ slug: "career", key: "bot" }),
    );
    expect(hb.status).toBe(204);
    const { agent } = await read(
      await agentRoute.GET(req("GET", "/api/arenas/career/agents/bot", { token: ADMIN_TOKEN }), params({ slug: "career", key: "bot" })),
    );
    expect(agent).toMatchObject({ status: "done", result: "answer" });
    expect(agent.awaySince).not.toBeNull();
    // Any later contact clears it.
    await heartbeatRoute.POST(
      req("POST", "/api/arenas/career/agents/bot/heartbeat", { token: career.ingestToken }),
      params({ slug: "career", key: "bot" }),
    );
    const after = await read(
      await agentRoute.GET(req("GET", "/api/arenas/career/agents/bot", { token: ADMIN_TOKEN }), params({ slug: "career", key: "bot" })),
    );
    expect(after.agent.awaySince).toBeNull();
  });

  it("heartbeat for an unknown agent is 404", async () => {
    const career = await createArena("career");
    const res = await heartbeatRoute.POST(
      req("POST", "/api/arenas/career/agents/ghost/heartbeat", { token: career.ingestToken }),
      params({ slug: "career", key: "ghost" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("ordering guard", () => {
  async function setup() {
    const career = await createArena("career");
    const send = async (body: Record<string, unknown>) => (await read(await report("career", "bot", career.ingestToken, body))) as { applied: boolean; agent: { status: string } };
    return send;
  }

  it("drops an older report in the same session and stores what was submitted", async () => {
    const send = await setup();
    expect((await send({ status: "done", result: "final", session: "s1", seq: 200 })).applied).toBe(true);
    const late = await send({ status: "working", activity: "late", session: "s1", seq: 100 });
    expect(late.applied).toBe(false);
    expect(late.agent.status).toBe("done");
    const superseded = (await rows(events)).find((e) => e.applied === false);
    expect(superseded?.report).toEqual({ status: "working", activity: "late", session: "s1", seq: 100 });
    expect(superseded?.agentVersion).toBeNull();
  });

  it("treats a tie as superseded", async () => {
    const send = await setup();
    await send({ status: "working", session: "s1", seq: 5 });
    expect((await send({ status: "done", session: "s1", seq: 5 })).applied).toBe(false);
  });

  it("a new session resets the watermark", async () => {
    const send = await setup();
    await send({ status: "working", session: "old-host", seq: 9_999_999_999_999 });
    expect((await send({ status: "done", session: "new-host", seq: 1 })).applied).toBe(true);
  });

  it("a report without seq always applies and leaves the watermark alone", async () => {
    const send = await setup();
    await send({ status: "working", session: "s1", seq: 10 });
    expect((await send({ status: "waiting" })).applied).toBe(true);
    expect((await send({ status: "done", session: "s1", seq: 10 })).applied).toBe(false);
    expect((await send({ status: "done", session: "s1", seq: 11 })).applied).toBe(true);
  });
});

describe("events", () => {
  it("lists history newest first with a cursor", async () => {
    const career = await createArena("career");
    for (let i = 0; i < 5; i += 1) await report("career", "bot", career.ingestToken, { status: "working", activity: `step ${i}` });
    const res = await eventsRoute.GET(
      req("GET", "/api/arenas/career/events?agent=bot&limit=3", { token: ADMIN_TOKEN }),
      params({ slug: "career" }),
    );
    const page = await read(res);
    expect(page.events).toHaveLength(3);
    expect(page.events[0].report.activity).toBe("step 4");
    const next = await read(
      await eventsRoute.GET(
        req("GET", `/api/arenas/career/events?agent=bot&limit=3&before=${page.nextBefore}`, { token: ADMIN_TOKEN }),
        params({ slug: "career" }),
      ),
    );
    expect(next.events.map((e: { type: string }) => e.type)).toEqual(["agent.status", "agent.status", "agent.registered"]);
  });
});

describe("rate limit", () => {
  it("returns 429 with Retry-After after a burst, counted in the shared database", async () => {
    process.env.ARENA_RATE_LIMIT_PER_10S = "20";
    const career = await createArena("career");
    let last: Response | undefined;
    for (let i = 0; i < 60; i += 1) {
      last = await report("career", "bot", career.ingestToken, { status: "idle" });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
  });
});
