import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { LIMITS, type ApiKeyPublic } from "@/lib/domain";
import { getDb, writeTx, type Db, type Tx } from "./db/client";
import { apiKeys, arenas, type ApiKeyRow, type ArenaRow } from "./db/schema";
import { ApiError, conflict, notFound } from "./errors";
import { canSeal, seal, unseal } from "./secrets";
import { generateToken, hashToken } from "./tokens";

const iso = (ms: number) => new Date(ms).toISOString();

export function toKeyPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix === "arena_" ? "arena_…" : `${row.prefix}…`,
    copyable: unseal(row.tokenSealed) !== null,
    createdAt: iso(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
  };
}

/** Inserts a new key. Pass the caller's transaction when it is part of a larger write. */
export async function insertKey(tx: Tx | Db, arenaId: string, name: string, nowMs: number): Promise<{ row: ApiKeyRow; token: string }> {
  // A key that can't be sealed could never be copied again; refuse before writing anything.
  if (!canSeal()) {
    throw new ApiError(
      500,
      "encryption_not_configured",
      "set ARENA_ENCRYPTION_KEY (or ARENA_SESSION_SECRET) so API keys can be stored for copying",
    );
  }
  const existing = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.arenaId, arenaId));
  if (existing.length >= LIMITS.keysPerArena) {
    throw new ApiError(409, "too_many_keys", `an arena holds at most ${LIMITS.keysPerArena} keys`);
  }
  const clash = await tx
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.arenaId, arenaId), eq(apiKeys.name, name)));
  if (clash[0]) throw conflict(`a key named '${name}' already exists`);
  const token = generateToken();
  const row: ApiKeyRow = {
    id: randomUUID(),
    arenaId,
    name,
    tokenHash: hashToken(token),
    tokenSealed: seal(token),
    prefix: token.slice(0, 10),
    createdAt: nowMs,
    lastUsedAt: null,
  };
  await tx.insert(apiKeys).values(row);
  return { row, token };
}

export async function createKey(arena: ArenaRow, name: string, nowMs: number): Promise<{ key: ApiKeyPublic; token: string }> {
  // The arena lock keeps the 50-key cap and name check exact under concurrent creates.
  const { row, token } = await writeTx(async (tx) => {
    await tx.select({ id: arenas.id }).from(arenas).where(eq(arenas.id, arena.id)).for("update");
    return insertKey(tx, arena.id, name, nowMs);
  });
  return { key: toKeyPublic(row), token };
}

export async function listKeys(arena: ArenaRow): Promise<ApiKeyPublic[]> {
  const rows = await (await getDb())
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.arenaId, arena.id))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.name));
  return rows.map(toKeyPublic);
}

async function getKeyRow(arena: ArenaRow, id: string): Promise<ApiKeyRow> {
  const rows = await (await getDb())
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.arenaId, arena.id), eq(apiKeys.id, id)));
  if (!rows[0]) throw notFound("key");
  return rows[0];
}

/** The key itself, for copying. 409 when it can't be shown again. */
export async function revealKey(arena: ArenaRow, id: string): Promise<{ key: ApiKeyPublic; token: string }> {
  const row = await getKeyRow(arena, id);
  const token = unseal(row.tokenSealed);
  if (!token) {
    throw new ApiError(409, "not_copyable", "this key can't be shown again; create a new key and revoke this one");
  }
  return { key: toKeyPublic(row), token };
}

/** Revokes a key. Agents using it get 401 from the next request on. */
export async function revokeKey(arena: ArenaRow, id: string): Promise<void> {
  const removed = await (await getDb())
    .delete(apiKeys)
    .where(and(eq(apiKeys.arenaId, arena.id), eq(apiKeys.id, id)))
    .returning({ id: apiKeys.id });
  if (removed.length === 0) throw notFound("key");
}

export async function findKeyByHash(
  hash: string,
): Promise<{ id: string; arenaId: string; lastUsedAt: number | null } | undefined> {
  const rows = await (await getDb())
    .select({ id: apiKeys.id, arenaId: apiKeys.arenaId, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(eq(apiKeys.tokenHash, hash));
  return rows[0];
}

/** Records use, at most once a minute per key, so busy agents don't write on every request. */
export async function touchKey(key: { id: string; lastUsedAt: number | null }, nowMs: number): Promise<void> {
  if (key.lastUsedAt !== null && nowMs - key.lastUsedAt < 60_000) return;
  await (await getDb()).update(apiKeys).set({ lastUsedAt: nowMs }).where(eq(apiKeys.id, key.id));
}
