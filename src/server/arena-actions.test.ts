import { beforeEach, describe, expect, it, vi } from "vitest";
import { ownerCookie, rows } from "../../test/helpers";
import { listAgents, removeAgent, reportStatus } from "./agents";
import { createArena, deleteArena, findArena, getArena } from "./arenas";
import { listKeys } from "./keys";
import { agents, arenas } from "./db/schema";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

const actions = await import("./arena-actions");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function loginAsOwner() {
  const [name, value] = (await ownerCookie()).split("=");
  jar.set(name, value);
}

beforeEach(async () => {
  jar.clear();
  await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
  await reportStatus(await getArena("career"), "writer", { status: "working" }, Date.now());
});

describe("settings actions without the owner session", () => {
  it("change nothing, even with anonymous reading on", async () => {
    process.env.ARENA_ALLOW_ANONYMOUS_READ = "1";
    const before = (await rows(arenas));
    const results = await Promise.all([
      actions.createArenaAction({}, form({ slug: "x", name: "X", theme: "office" })),
      actions.createKeyAction({}, form({ slug: "career", name: "laptop" })),
      actions.revealKeyAction({ slug: "career", id: (await listKeys(await getArena("career")))[0].id }),
      actions.revokeKeyAction({}, form({ slug: "career", id: (await listKeys(await getArena("career")))[0].id })),
      actions.updateArenaAction({}, form({ slug: "career", name: "Hacked" })),
      actions.removeAgentAction({}, form({ slug: "career", key: "writer", agentId: "x" })),
      actions.deleteArenaAction({}, form({ slug: "career", arenaId: "x", confirm: "career" })),
    ]);
    for (const result of results) expect(result.error).toMatch(/log in/i);
    expect((await rows(arenas))).toEqual(before);
    expect((await listKeys(await getArena("career"))).map((k) => k.name)).toEqual(["default"]);
    expect((await rows(agents))).toHaveLength(1);
  });
});

describe("settings actions as the owner", () => {
  beforeEach(loginAsOwner);

  it("creates an arena and returns its token once", async () => {
    const result = await actions.createArenaAction({}, form({ slug: "personal", name: "Personal", theme: "kitchen" }));
    expect(result).toMatchObject({ ok: true, slug: "personal", keyName: "default" });
    expect(result.token).toMatch(/^arena_/);
    expect((await findArena("personal"))?.theme).toBe("kitchen");
  });

  it("rejects a reserved or duplicate slug", async () => {
    expect((await actions.createArenaAction({}, form({ slug: "new", name: "N" }))).error).toMatch(/reserved/);
    expect((await actions.createArenaAction({}, form({ slug: "career", name: "C" }))).error).toMatch(/already exists/);
  });

  it("creates, copies and revokes keys", async () => {
    const created = await actions.createKeyAction({}, form({ slug: "career", name: "laptop" }));
    expect(created).toMatchObject({ ok: true, keyName: "laptop" });
    const laptop = (await listKeys(await getArena("career"))).find((k) => k.name === "laptop")!;
    expect((await actions.revealKeyAction({ slug: "career", id: laptop.id })).token).toBe(created.token);
    expect((await actions.revealKeyAction({ slug: "career", id: "not-a-uuid" })).error).toBeTruthy();
    expect(await actions.revokeKeyAction({}, form({ slug: "career", id: laptop.id }))).toMatchObject({ ok: true });
    expect((await listKeys(await getArena("career"))).map((k) => k.name)).toEqual(["default"]);
  });

  it("renames, re-themes and removes agents", async () => {
    expect(await actions.updateArenaAction({}, form({ slug: "career", name: "Career HQ", theme: "kitchen" }))).toMatchObject({ ok: true });
    expect(await findArena("career")).toMatchObject({ name: "Career HQ", theme: "kitchen" });
    const writer = (await listAgents(await getArena("career")))[0];
    expect(await actions.removeAgentAction({}, form({ slug: "career", key: "writer", agentId: writer.id }))).toMatchObject({ ok: true });
    expect((await rows(agents))).toHaveLength(0);
  });

  it("deletes only when the slug is typed again", async () => {
    const id = (await findArena("career"))!.id;
    expect((await actions.deleteArenaAction({}, form({ slug: "career", arenaId: id, confirm: "carer" }))).error).toMatch(/to confirm/);
    expect(await findArena("career")).toBeDefined();
    await expect(actions.deleteArenaAction({}, form({ slug: "career", arenaId: id, confirm: "career" }))).rejects.toMatchObject({ to: "/" });
    expect(await findArena("career")).toBeUndefined();
  });

  it("won't remove or delete a newer record that replaced the one on the page", async () => {
    const arena = await getArena("career");
    const shownAgent = (await listAgents(arena))[0];
    await removeAgent(arena, "writer", Date.now());
    await reportStatus(arena, "writer", { status: "idle" }, Date.now()); // re-registered: new id
    const removed = await actions.removeAgentAction({}, form({ slug: "career", key: "writer", agentId: shownAgent.id }));
    expect(removed.error).toMatch(/changed since the page loaded/);
    expect((await rows(agents))).toHaveLength(1);

    const shownArenaId = arena.id;
    await deleteArena("career");
    await createArena({ slug: "career", name: "Career again", theme: "office" }, Date.now());
    const deleted = await actions.deleteArenaAction({}, form({ slug: "career", arenaId: shownArenaId, confirm: "career" }));
    expect(deleted.error).toMatch(/changed since the page loaded/);
    expect((await findArena("career"))?.name).toBe("Career again");
  });

});

describe("issuing keys needs a sealing secret", () => {
  beforeEach(loginAsOwner);

  it("refuses to create an arena or a key that could never be copied again, and writes nothing", async () => {
    delete process.env.ARENA_ENCRYPTION_KEY;
    // The owner login needs the session secret, so this case uses the admin path directly.
    delete process.env.ARENA_SESSION_SECRET;
    delete process.env.ARENA_OWNER_PASSWORD;
    await expect(createArena({ slug: "nokeys", name: "No keys", theme: "office" }, Date.now())).rejects.toThrow(/ARENA_ENCRYPTION_KEY/);
    expect(await findArena("nokeys")).toBeUndefined();
    process.env.ARENA_ENCRYPTION_KEY = "an-encryption-key-of-at-least-32-chars!!";
    expect((await createArena({ slug: "nokeys", name: "No keys", theme: "office" }, Date.now())).apiKey.copyable).toBe(true);
  });
});
