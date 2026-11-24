"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/safe-next";
import { slugSchema } from "@/lib/schemas";
import { acknowledgeAgent } from "./agents";
import { findArena } from "./arenas";
import { requireOwner } from "./auth";
import { getEnv, ownerLoginEnabled } from "./env";
import { ApiError } from "./errors";
import { loginRetryAfter, recordLoginFailure } from "./rate-limit";
import { createSessionValue, SESSION_COOKIE, SESSION_TTL_MS } from "./session";
import { secretsEqual } from "./tokens";

// Every action that changes data calls requireOwner() first. Next checks the Origin of action
// requests, but that only stops cross-site calls; it says nothing about who is calling.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; code: string };

async function asOwner<T>(fn: () => T | Promise<T>): Promise<T | { ok: false; error: string; code: string }> {
  try {
    await requireOwner();
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
}

/**
 * Who is trying to log in, for the per-client throttle. X-Forwarded-For is only trusted behind a
 * proxy that overwrites it (ARENA_TRUST_PROXY=1); a direct client could otherwise forge a new
 * address for every attempt. Without that, every client shares one bucket.
 */
function clientAddress(h: Headers, trustProxy: boolean): string {
  if (!trustProxy) return "direct";
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}


export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const env = getEnv();
  if (!ownerLoginEnabled(env)) {
    return { error: "Login isn't set up. Set ARENA_OWNER_PASSWORD and ARENA_SESSION_SECRET." };
  }
  const h = await headers();
  const client = clientAddress(h, env.ARENA_TRUST_PROXY === "1");
  const now = Date.now();
  const wait = await loginRetryAfter(client, now);
  if (wait > 0) return { error: `Too many attempts. Try again in ${wait}s.` };

  const password = form.get("password");
  if (typeof password !== "string" || !secretsEqual(password, env.ARENA_OWNER_PASSWORD!)) {
    await recordLoginFailure(client, now);
    return { error: "Wrong password." };
  }

  const value = await createSessionValue(
    { secret: env.ARENA_SESSION_SECRET!, password: env.ARENA_OWNER_PASSWORD! },
    now,
  );
  // Secure whenever the login itself came over HTTPS, and always in production unless plain HTTP
  // is explicitly allowed (ARENA_INSECURE_COOKIE=1). Browsers accept Secure cookies on
  // http://localhost, so local production builds still work.
  const overHttps = (h.get("origin") ?? "").startsWith("https:") || h.get("x-forwarded-proto") === "https";
  const secure = overHttps || (env.NODE_ENV === "production" && env.ARENA_INSECURE_COOKIE !== "1");
  (await cookies()).set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect(safeNext(form.get("next")));
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

const ackInput = z.strictObject({
  slug: slugSchema,
  key: slugSchema,
  version: z.number().int().positive(),
});

export async function acknowledgeAction(input: {
  slug: string;
  key: string;
  version: number;
}): Promise<ActionResult<{ status: "acknowledged" | "stale" | "not_done" }>> {
  return asOwner(async () => {
    const parsed = ackInput.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "invalid input", code: "validation_failed" };
    const arena = await findArena(parsed.data.slug);
    if (!arena) return { ok: false as const, error: "arena not found", code: "not_found" };
    const result = await acknowledgeAgent(arena, parsed.data.key, parsed.data.version, Date.now());
    return { ok: true as const, status: result.ok ? ("acknowledged" as const) : result.reason };
  });
}
