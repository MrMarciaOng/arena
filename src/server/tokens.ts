import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Ingest tokens start with "arena_" so secret scanners can spot them. */
export function generateToken(): string {
  return `arena_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compares two secrets in constant time by comparing their hashes. */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
