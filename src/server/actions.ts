"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/safe-next";
import { slugSchema } from "@/lib/schemas";
import { acknowledgeAgent } from "./agents";
import type { ArenaOwner } from "./arena-owner";
import { findArena } from "./arenas";
import { requireOwner } from "./auth";
import { getEnv, ownerLoginEnabled, passwordSessionKeys } from "./env";
import { ApiError } from "./errors";
import { loginRetryAfter, recordLoginFailure } from "./rate-limit";
import { createSessionValue, secureSessionCookie, SESSION_COOKIE, SESSION_TTL_MS } from "./session";
import { sendSupabaseMagicLink, signOutFromSupabase } from "./supabase-auth";
import { secretsEqual } from "./tokens";

// Every action that changes data calls requireOwner() first. Next checks the Origin of action
// requests, but that only stops cross-site calls; it says nothing about who is calling.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; code: string };

async function asOwner<T>(fn: (owner: ArenaOwner) => T | Promise<T>): Promise<T | { ok: false; error: string; code: string }> {
  try {
    return await fn(await requireOwner());
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


/**
 * `sent` is the address a sign-in link went to, at `sentAt`. `retryAfter` (seconds) is when another
 * link can be requested, so the form can count down instead of failing.
 */
export type LoginState = { error?: string; email?: string; sent?: string; sentAt?: number; retryAfter?: number };

/** Supabase refuses a second link to the same address within a minute. */
const RESEND_AFTER_S = 60;

/** This site's origin as the browser sees it. Next rejects actions whose Origin isn't this host. */
function requestOrigin(h: Headers): string | null {
  const origin = h.get("origin");
  if (origin && origin !== "null") return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  return `${h.get("x-forwarded-proto") ?? "https"}://${host}`;
}

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const env = getEnv();
  if (!ownerLoginEnabled(env)) {
    return { error: "Login isn't set up. Set ARENA_OWNER_PASSWORD and ARENA_SESSION_SECRET." };
  }
  const h = await headers();
  const client = clientAddress(h, env.ARENA_TRUST_PROXY === "1");
  const now = Date.now();
  const wait = await loginRetryAfter(client, now);
  if (wait > 0) {
    const email = form.get("email");
    return { error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait, ...(typeof email === "string" && { email }) };
  }

  const secure = secureSessionCookie(env, h);
  if (env.ARENA_AUTH_PROVIDER === "supabase") {
    const email = z.email().safeParse(String(form.get("email") ?? "").trim());
    if (!email.success) return { error: "Enter a valid email address.", email: String(form.get("email") ?? "") };
    const origin = requestOrigin(h);
    if (!origin) return { error: "Couldn't send the sign-in link. Try again." };
    // Every email sent counts toward the login throttle, so the form can't be used to flood an inbox.
    await recordLoginFailure(client, now);
    const redirectTo = new URL("/auth/confirm", origin);
    redirectTo.searchParams.set("next", safeNext(form.get("next")));
    const result = await sendSupabaseMagicLink(env, {
      store: await cookies(),
      secure,
      email: email.data,
      redirectTo: redirectTo.toString(),
    });
    if (result.ok) return { sent: email.data, sentAt: now, retryAfter: RESEND_AFTER_S };
    if (result.retryAfter) {
      return {
        error: `A link was just sent to this address. You can ask for another in ${result.retryAfter}s.`,
        email: email.data,
        retryAfter: result.retryAfter,
      };
    }
    return {
      email: email.data,
      error: result.rateLimited
        ? "Too many sign-in emails were sent. Try again in a few minutes."
        : "Couldn't send the sign-in link. Check the address and try again.",
    };
  }

  const password = form.get("password");
  const keys = passwordSessionKeys(env);
  if (!keys || typeof password !== "string" || !secretsEqual(password, keys.password)) {
    await recordLoginFailure(client, now);
    return { error: "Wrong password." };
  }

  const value = await createSessionValue(keys, now);
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
  const env = getEnv();
  const store = await cookies();
  if (env.ARENA_AUTH_PROVIDER === "supabase") {
    await signOutFromSupabase(env, { store, secure: secureSessionCookie(env, await headers()) });
  }
  store.delete(SESSION_COOKIE);
  redirect("/login?signedOut=1");
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
  return asOwner(async (owner) => {
    const parsed = ackInput.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "invalid input", code: "validation_failed" };
    const arena = await findArena(parsed.data.slug, owner);
    if (!arena) return { ok: false as const, error: "arena not found", code: "not_found" };
    const result = await acknowledgeAgent(arena, parsed.data.key, parsed.data.version, Date.now());
    return { ok: true as const, status: result.ok ? ("acknowledged" as const) : result.reason };
  });
}
