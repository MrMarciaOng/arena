// Owner session cookie, signed with HMAC-SHA256 over Web Crypto so proxy.ts can verify it too.
// No "server-only" import for the same reason.

export const SESSION_COOKIE = "arena_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Changing the password changes this, which invalidates every existing session. */
async function passwordFingerprint(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`arena-owner:${password}`));
  return toBase64Url(digest).slice(0, 22);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SessionKeys = { secret: string; password: string };

export async function createSessionValue(keys: SessionKeys, nowMs: number): Promise<string> {
  const expiresAt = nowMs + SESSION_TTL_MS;
  const fp = await passwordFingerprint(keys.password);
  return `${expiresAt}.${await sign(keys.secret, `owner.${expiresAt}.${fp}`)}`;
}

/** The session's expiry (epoch ms) if the value is valid now, else null. */
export async function verifySessionExpiry(
  value: string | undefined,
  keys: SessionKeys,
  nowMs: number,
): Promise<number | null> {
  if (!value) return null;
  const [expiresRaw, signature, ...rest] = value.split(".");
  if (rest.length > 0 || !expiresRaw || !signature || !/^\d+$/.test(expiresRaw)) return null;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs) return null;
  const fp = await passwordFingerprint(keys.password);
  return constantTimeEqual(signature, await sign(keys.secret, `owner.${expiresAt}.${fp}`)) ? expiresAt : null;
}

export async function verifySessionValue(value: string | undefined, keys: SessionKeys, nowMs: number): Promise<boolean> {
  return (await verifySessionExpiry(value, keys, nowMs)) !== null;
}
