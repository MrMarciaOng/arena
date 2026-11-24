import { beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_PASSWORD } from "../../test/constants";
import { ownerCookie } from "../../test/helpers";
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
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set(name, value);
      cookieOptions.set(name, options);
    },
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => requestHeaders,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

const { acknowledgeAction, loginAction } = await import("./actions");

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

describe("canReadPages", () => {
  it("is false with no owner session and anonymous reading off, even with no password configured", async () => {
    const { canReadPages } = await import("./auth");
    delete process.env.ARENA_OWNER_PASSWORD;
    expect(await canReadPages()).toBe(false);
    process.env.ARENA_ALLOW_ANONYMOUS_READ = "1";
    expect(await canReadPages()).toBe(true);
  });

  it("is true for the owner", async () => {
    const { canReadPages } = await import("./auth");
    await loginAsOwner();
    expect(await canReadPages()).toBe(true);
  });
});
