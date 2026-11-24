import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getEnv } from "./env";

// Seals API keys so the owner can copy them again later, while a copy of the database file on its
// own doesn't give them away. The key comes from ARENA_ENCRYPTION_KEY, or ARENA_SESSION_SECRET
// when that isn't set. Changing it makes existing keys impossible to copy again (they still work).

const VERSION = "v1";
const TAG_BYTES = 16;

function sealingKey(): Buffer | null {
  const env = getEnv();
  const secret = env.ARENA_ENCRYPTION_KEY ?? env.ARENA_SESSION_SECRET;
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", secret, "arena", "api-keys v1", 32));
}

export function canSeal(): boolean {
  return sealingKey() !== null;
}

/** AES-256-GCM. Returns null when no secret is configured (the key then can't be shown again). */
export function seal(plain: string): string | null {
  const key = sealingKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** The plain value, or null if it can't be opened (no secret, a changed secret, or tampering). */
export function unseal(sealed: string | null): string | null {
  if (!sealed) return null;
  const key = sealingKey();
  if (!key) return null;
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) return null;
  const tagBytes = Buffer.from(tag, "base64url");
  // v1 always writes a full 16-byte tag; a shorter one means the record was damaged or forged.
  if (tagBytes.length !== TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
