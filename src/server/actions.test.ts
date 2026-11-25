import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getArenaList, POST as createAdminArena } from "@/app/api/arenas/route";
import { GET as getArenaDetail } from "@/app/api/arenas/[slug]/route";
import { GET as openStream } from "@/app/api/stream/route";
import { ADMIN_TOKEN, OWNER_PASSWORD } from "../../test/constants";
import { ownerCookie, params, read, req } from "../../test/helpers";
import { reportStatus } from "./agents";
import { createArena, getArena } from "./arenas";
import { getDb } from "./db/client";
import { agents } from "./db/schema";

// Server Actions read cookies() and headers() from the request; here we hand them in directly.
const jar = new Map<string, string>();
let requestHeaders = new Headers();
const cookieOptions = new Map<string, Record<string, unknown>>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set(name, value);
      cookieOptions.set(name, options);
    },
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => requestHeaders,
}));
vi.mock("next/navigation", () => ({
  unstable_rethrow: () => undefined,
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

const { acknowledgeAction, loginAction } = await import("./actions");
const { createArenaAction, deleteArenaAction, revealKeyAction, updateArenaAction } = await import("./arena-actions");
const { getOwnerSession } = await import("./auth");
const requestArenaList = (cookie?: string) => getArenaList(req("GET", "/api/arenas", { cookie }), undefined);

async function loginAsOwner() {
  const [name, value] = (await ownerCookie()).split("=");
  jar.set(name, value);
}

async function seedDone() {
  await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
  const arena = await getArena("career");
  const { agent } = await reportStatus(arena, "writer", { status: "done", result: "answer A" }, Date.now());
  return { arena, agent };
}

const statusOf = async () => (await (await getDb()).select({ status: agents.status, result: agents.result }).from(agents))[0];

beforeEach(async () => {
  jar.clear();
  requestHeaders = new Headers({ "x-forwarded-for": "10.0.0.1" });
});

describe("acknowledgeAction", () => {
  it("changes nothing without an owner session", async () => {
    const { agent } = await seedDone();
    const result = await acknowledgeAction({ slug: "career", key: "writer", version: agent.version });
    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    expect((await statusOf())).toEqual({ status: "done", result: "answer A" });
  });

  it("changes nothing without a session even when anonymous reading is on", async () => {
    process.env.ARENA_ALLOW_ANONYMOUS_READ = "1";
    const { agent } = await seedDone();
    const result = await acknowledgeAction({ slug: "career", key: "writer", version: agent.version });
    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    expect((await statusOf())?.status).toBe("done");
  });

  it("leaves a newer answer in place when the acknowledged version is stale", async () => {
    const { arena, agent } = await seedDone();
    await reportStatus(arena, "writer", { status: "done", result: "answer B" }, Date.now());
    await loginAsOwner();
    const result = await acknowledgeAction({ slug: "career", key: "writer", version: agent.version });
    expect(result).toEqual({ ok: true, status: "stale" });
    expect((await statusOf())).toEqual({ status: "done", result: "answer B" });
  });

  it("sets done back to idle at the matching version", async () => {
    const { agent } = await seedDone();
    await loginAsOwner();
    const result = await acknowledgeAction({ slug: "career", key: "writer", version: agent.version });
    expect(result).toEqual({ ok: true, status: "acknowledged" });
    expect((await statusOf())).toEqual({ status: "idle", result: null });
  });

  it("validates its input", async () => {
    await seedDone();
    await loginAsOwner();
    const result = await acknowledgeAction({ slug: "career", key: "../x", version: 1 });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("loginAction", () => {
  const form = (password: string, next = "/") => {
    const f = new FormData();
    f.set("password", password);
    f.set("next", next);
    return f;
  };

  it("sets the session cookie and redirects on the right password", async () => {
    await expect(loginAction({}, form(OWNER_PASSWORD, "/arenas/career"))).rejects.toMatchObject({ to: "/arenas/career" });
    expect(jar.get("arena_session")).toBeTruthy();
  });

  it("refuses an off-site redirect target", async () => {
    await expect(loginAction({}, form(OWNER_PASSWORD, "//evil.example"))).rejects.toMatchObject({ to: "/" });
  });

  it("throttles repeated wrong passwords", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await loginAction({}, form("wrong"))).toEqual({ error: "Wrong password." });
    }
    const blocked = await loginAction({}, form(OWNER_PASSWORD));
    expect(blocked.error).toMatch(/Too many attempts/);
    expect(jar.has("arena_session")).toBe(false);
  });

  it("sets a Secure cookie in production unless plain HTTP is allowed", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    await expect(loginAction({}, form(OWNER_PASSWORD))).rejects.toMatchObject({ to: "/" });
    expect(cookieOptions.get("arena_session")).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
    process.env.ARENA_INSECURE_COOKIE = "1";
    await expect(loginAction({}, form(OWNER_PASSWORD))).rejects.toMatchObject({ to: "/" });
    expect(cookieOptions.get("arena_session")).toMatchObject({ secure: false });
  });

  it("doesn't let a forged X-Forwarded-For dodge the throttle", async () => {
    for (let i = 0; i < 5; i += 1) {
      requestHeaders = new Headers({ "x-forwarded-for": `203.0.113.${i}` });
      await loginAction({}, form("wrong"));
    }
    requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.99" });
    expect((await loginAction({}, form(OWNER_PASSWORD))).error).toMatch(/Too many attempts/);
  });
});

describe("legacy password login", () => {
  it("keeps reads private without a session unless anonymous reading is enabled", async () => {
    delete process.env.ARENA_OWNER_PASSWORD;
    expect((await requestArenaList()).status).toBe(401);
    process.env.ARENA_ALLOW_ANONYMOUS_READ = "1";
    expect((await requestArenaList()).status).toBe(200);
  });

  it("allows the password owner to list legacy arenas", async () => {
    await createArena({ slug: "legacy", name: "Legacy", theme: "office" }, Date.now());
    const cookie = await ownerCookie();
    expect(await read(await requestArenaList(cookie))).toMatchObject({
      arenas: [{ slug: "legacy" }],
    });
  });
});

describe("Supabase accounts", () => {
  const accounts = {
    "first@example.test": "c37dbef1-1cf2-4cc6-8ee4-be2a324c0001",
    "second@example.test": "c37dbef1-1cf2-4cc6-8ee4-be2a324c0002",
  };
  const sessionCookie = "arena_supabase_session";
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const formData = (values: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(values)) form.set(name, value);
    return form;
  };

  beforeEach(() => {
    process.env.ARENA_AUTH_PROVIDER = "supabase";
    process.env.SUPABASE_URL = "https://auth.example.test";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_arena-test";
    const tokens = new Map<string, string>();
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
        const { email } = JSON.parse(String(init.body));
        const id = Object.entries(accounts).find(([address]) => address === email)?.[1];
        if (!id) throw new Error("Unexpected account in test sign-in");
        const claims = { sub: id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 };
        const token = `${encode({ alg: "HS256" })}.${encode(claims)}.${encode("signature")}`;
        tokens.set(`Bearer ${token}`, id);
        return Response.json({
          access_token: token,
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          token_type: "bearer",
          user: { id },
        });
      }
      if (url.pathname === "/auth/v1/user") {
        const id = tokens.get(new Headers(init.headers).get("authorization") ?? "");
        return id ? Response.json({ id }) : Response.json({ message: "Invalid session" }, { status: 401 });
      }
      throw new Error(`Unexpected Supabase request: ${url.pathname}`);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function signIn(email: keyof typeof accounts) {
    await expect(loginAction({}, formData({ email, password: OWNER_PASSWORD, next: "/arenas/new" })))
      .rejects.toMatchObject({ to: "/arenas/new" });
    expect(cookieOptions.get(sessionCookie)).toMatchObject({ httpOnly: true, sameSite: "lax" });
  }

  const create = (slug: string) => createArenaAction({}, formData({ slug, name: slug }));
  const list = async () => read(await requestArenaList());

  it("allows eight arenas per account under concurrent creation and frees a slot on deletion", async () => {
    await signIn("first@example.test");
    const outcomes = await Promise.all(Array.from({ length: 9 }, (_, index) => create(`arena-${index}`)));
    expect(outcomes.filter((result) => result.ok)).toHaveLength(8);
    expect(outcomes.filter((result) => result.error)).toEqual([
      { error: "You can have up to 8 arenas. Delete one to create another." },
    ]);
    const { arenas: owned } = await list();
    expect(owned).toHaveLength(8);
    const [first] = owned;
    await expect(deleteArenaAction({}, formData({ slug: first.slug, arenaId: first.id, confirm: first.slug })))
      .rejects.toMatchObject({ to: "/" });
    expect(await create("replacement")).toMatchObject({ ok: true });

    await signIn("second@example.test");
    expect(await list()).toEqual({ arenas: [] });
    expect(await create("independent")).toMatchObject({ ok: true });
    expect(await list()).toMatchObject({ arenas: [{ slug: "independent" }] });
  });

  it("keeps arena details, settings changes, keys, and live updates private to the owning account", async () => {
    const created = await createAdminArena(req("POST", "/api/arenas", {
      token: ADMIN_TOKEN,
      body: { slug: "private", name: "Private", ownerUserId: accounts["first@example.test"] },
    }), undefined);
    expect(created.status).toBe(201);
    const { apiKey, arena } = await read(created);
    await createArena({ slug: "legacy", name: "Legacy", theme: "office" }, Date.now());
    await signIn("first@example.test");
    expect(await list()).toMatchObject({ arenas: [{ slug: "private" }] });
    expect(await revealKeyAction({ slug: "private", id: apiKey.id })).toMatchObject({ ok: true });
    await signIn("second@example.test");
    expect(await create("mine")).toMatchObject({ ok: true });
    const mine = await getArena("mine");
    expect((await getArenaDetail(req("GET", "/api/arenas/private"), params({ slug: "private" }))).status).toBe(404);
    expect(await revealKeyAction({ slug: "private", id: apiKey.id })).toEqual({ error: "arena 'private' not found" });
    expect(await updateArenaAction({}, formData({ slug: "private", name: "Updated" }))).toHaveProperty("error");
    expect(await deleteArenaAction({}, formData({ slug: "private", arenaId: arena.id, confirm: "private" })))
      .toHaveProperty("error");
    const res = await openStream(req("GET", "/api/stream"));
    expect(res.status).toBe(200);
    const stream = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!stream) throw new Error("Expected a live stream");
    const nextMessage = async () => {
      let frame = "";
      while (!frame.includes("data: ") || !frame.endsWith("\n\n")) {
        const { done, value } = await stream.read();
        if (done) throw new Error("Stream ended before a data message");
        frame += value;
      }
      return JSON.parse(frame.split("data: ")[1]);
    };
    try {
      expect(await nextMessage()).toMatchObject({ type: "snapshot", arenas: [{ slug: "mine" }] });
      await reportStatus(await getArena("private"), "private-agent", { status: "working" }, Date.now());
      await reportStatus(mine, "own-agent", { status: "working" }, Date.now());
      expect(await nextMessage()).toMatchObject({ type: "agent.upserted", agent: { key: "own-agent" } });
    } finally {
      await stream.cancel();
    }
    jar.clear();
    process.env.ARENA_ALLOW_ANONYMOUS_READ = "1";
    expect((await requestArenaList()).status).toBe(401);
  });

  it("denies access when the Supabase session cookie cannot be decoded", async () => {
    const value = encode({
      access_token: "eA.eA.eA",
      refresh_token: "test-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    jar.set(sessionCookie, `base64-${value}`);
    expect(await getOwnerSession()).toBeNull();
  });
});
