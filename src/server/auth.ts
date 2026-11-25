import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { legacyArenaOwner, type ArenaOwner } from "./arena-owner";
import type { ArenaRow } from "./db/schema";
import { anonymousReadAllowed, getEnv, passwordSessionKeys, type Env } from "./env";
import { ApiError, forbidden, unauthorized } from "./errors";
import { findKeyByHash, touchKey } from "./keys";
import { takeRequest } from "./rate-limit";
import { secureSessionCookie, SESSION_COOKIE, verifySessionExpiry } from "./session";
import { createSupabaseAuthClient, readSupabaseSession, supabaseCookieStore } from "./supabase-auth";
import { hashToken, secretsEqual } from "./tokens";

type OwnerSession = ArenaOwner & { kind: "owner"; expiresAt: number };

export type Credential =
  | { kind: "admin"; rateKey: string }
  | { kind: "ingest"; arenaId: string; keyId: string; rateKey: string }
  | OwnerSession
  | { kind: "anonymous" }
  | { kind: "none" };

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) throw unauthorized("Authorization must be 'Bearer <token>'");
  return match[1];
}

/**
 * Credentials for writes: Bearer tokens only. Cookies are ignored, so a write can't be
 * triggered cross-site with the owner's cookie.
 *
 * A recognized token is charged against its rate limit here, before any scope check, so a
 * token hammering an endpoint it may not use still runs into 429. Pass `charge: false` when
 * re-checking a credential within the same request.
 */
export async function resolveBearer(req: Request, { charge = true }: { charge?: boolean } = {}): Promise<Credential> {
  const token = bearerToken(req);
  if (!token) return { kind: "none" };
  const adminToken = getEnv().ARENA_ADMIN_TOKEN;
  let cred: Credential | null = null;
  if (adminToken && secretsEqual(token, adminToken)) {
    cred = { kind: "admin", rateKey: "admin" };
  } else {
    const hash = hashToken(token);
    const key = await findKeyByHash(hash);
    if (key) {
      cred = { kind: "ingest", arenaId: key.arenaId, keyId: key.id, rateKey: hash };
      if (charge) await touchKey(key, Date.now());
    }
  }
  if (!cred) throw unauthorized("unknown token");
  if (charge) await rateLimit(cred);
  return cred;
}

/** Credentials for reads: a Bearer token if present, else the owner cookie, else anonymous if allowed. */
export async function resolveReader(req: Request): Promise<Credential> {
  const bearer = await resolveBearer(req);
  if (bearer.kind !== "none") return bearer;
  const env = getEnv();
  if (env.ARENA_AUTH_PROVIDER === "supabase") {
    const client = createSupabaseAuthClient(env, {
      cookies: supabaseCookieStore(await cookies(), true),
      secure: secureSessionCookie(env, req.headers, new URL(req.url).protocol),
    });
    const session = await readSupabaseSession(client);
    return session ? { kind: "owner", ...session } : { kind: "none" };
  }
  const session = await readPasswordSession(env, readCookie(req, SESSION_COOKIE));
  return session ?? { kind: anonymousReadAllowed(env) ? "anonymous" : "none" };
}

async function readPasswordSession(env: Env, value: string | undefined): Promise<OwnerSession | null> {
  const keys = passwordSessionKeys(env);
  if (!keys) return null;
  const expiresAt = await verifySessionExpiry(value, keys, Date.now());
  return expiresAt === null ? null : { kind: "owner", ...legacyArenaOwner, expiresAt };
}

/** A malformed cookie reads as no cookie: it must fall through to 401 or anonymous, never a 500. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function assertCanReadArena(cred: Credential, arena: ArenaRow) {
  if (cred.kind === "none") throw unauthorized();
  if (cred.kind === "ingest" && cred.arenaId !== arena.id) throw forbidden("this token belongs to another arena");
}

export function assertCanReadAll(cred: Credential) {
  if (cred.kind === "none") throw unauthorized();
  if (cred.kind === "ingest") throw forbidden("an arena token can only read its own arena");
}

/** Ownership scope for reads once the caller has passed the endpoint's credential check. */
export function readerArenaOwner(cred: Credential): ArenaOwner | undefined {
  if (cred.kind === "owner") return cred;
  if (cred.kind === "anonymous") return legacyArenaOwner;
  return undefined;
}

export function assertCanIngest(cred: Credential, arena: ArenaRow) {
  if (cred.kind === "admin") return;
  if (cred.kind === "ingest") {
    if (cred.arenaId !== arena.id) throw forbidden("this token belongs to another arena");
    return;
  }
  throw unauthorized("send this arena's token as 'Authorization: Bearer <token>'");
}

export function assertAdmin(cred: Credential) {
  if (cred.kind === "admin") return;
  if (cred.kind === "ingest") throw forbidden("this needs the admin token");
  throw unauthorized("send the admin token as 'Authorization: Bearer <token>'");
}

/** Applies the per-token rate limit. Only Bearer credentials are limited. */
async function rateLimit(cred: Credential, nowMs = Date.now()) {
  if (cred.kind !== "admin" && cred.kind !== "ingest") return;
  const wait = await takeRequest(cred.rateKey, nowMs);
  if (wait > 0) {
    throw new ApiError(429, "rate_limited", "too many requests", undefined, {
      "Retry-After": String(wait),
    });
  }
}

/** Server Actions use the authenticated account to scope all changes. */
export async function requireOwner(): Promise<ArenaOwner> {
  const session = await getOwnerSession();
  if (!session) {
    throw new ApiError(401, "unauthorized", "log in as the owner to do that");
  }
  return session;
}

export const getOwnerSession = cache(async function getOwnerSession(): Promise<OwnerSession | null> {
  const env = getEnv();
  const store = await cookies();
  if (env.ARENA_AUTH_PROVIDER === "supabase") {
    // Proxy refreshes the session before page rendering or a Server Action.
    const client = createSupabaseAuthClient(env, { cookies: supabaseCookieStore(store, false), secure: true });
    const session = await readSupabaseSession(client);
    return session ? { kind: "owner", ...session } : null;
  }
  return readPasswordSession(env, store.get(SESSION_COOKIE)?.value);
});
