import "server-only";
import { cookies } from "next/headers";
import type { ArenaRow } from "./db/schema";
import { anonymousReadAllowed, getEnv, ownerLoginEnabled } from "./env";
import { ApiError, forbidden, unauthorized } from "./errors";
import { findKeyByHash, touchKey } from "./keys";
import { takeRequest } from "./rate-limit";
import { SESSION_COOKIE, verifySessionExpiry } from "./session";
import { hashToken, secretsEqual } from "./tokens";

export type Credential =
  | { kind: "admin"; rateKey: string }
  | { kind: "ingest"; arenaId: string; keyId: string; rateKey: string }
  | { kind: "owner"; expiresAt: number }
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

/** The owner session's expiry if `value` is a valid session cookie, else null. */
export async function ownerSessionExpiry(value: string | undefined, nowMs = Date.now()): Promise<number | null> {
  const env = getEnv();
  if (!ownerLoginEnabled(env)) return null;
  return verifySessionExpiry(
    value,
    { secret: env.ARENA_SESSION_SECRET!, password: env.ARENA_OWNER_PASSWORD! },
    nowMs,
  );
}

export async function isOwnerSessionValue(value: string | undefined, nowMs = Date.now()): Promise<boolean> {
  return (await ownerSessionExpiry(value, nowMs)) !== null;
}

/** Credentials for reads: a Bearer token if present, else the owner cookie, else anonymous if allowed. */
export async function resolveReader(req: Request): Promise<Credential> {
  const bearer = await resolveBearer(req);
  if (bearer.kind !== "none") return bearer;
  const expiresAt = await ownerSessionExpiry(readCookie(req, SESSION_COOKIE));
  if (expiresAt !== null) return { kind: "owner", expiresAt };
  if (anonymousReadAllowed()) return { kind: "anonymous" };
  return { kind: "none" };
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

/**
 * For Server Actions. Next's Origin check only stops cross-site calls, so every action
 * proves the caller is the owner here before changing anything.
 */
export async function requireOwner(): Promise<void> {
  const store = await cookies();
  if (!(await isOwnerSessionValue(store.get(SESSION_COOKIE)?.value))) {
    throw new ApiError(401, "unauthorized", "log in as the owner to do that");
  }
}

export async function isOwner(): Promise<boolean> {
  const store = await cookies();
  return isOwnerSessionValue(store.get(SESSION_COOKIE)?.value);
}

/** Who may see arena data in a page: the owner, or anyone when anonymous reading is on. */
export async function canReadPages(): Promise<boolean> {
  return anonymousReadAllowed() || (await isOwner());
}
