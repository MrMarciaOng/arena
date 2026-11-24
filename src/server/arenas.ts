import "server-only";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { countAgents, type ApiKeyPublic, type ArenaPublic, type ArenaSummary, type CountableAgent } from "@/lib/domain";
import type { CreateArenaInput, UpdateArenaInput } from "@/lib/schemas";
import { getDb, nextSeq, writeTx } from "./db/client";
import { agents, arenas, type ArenaRow } from "./db/schema";
import { conflict, notFound } from "./errors";
import { emit } from "./feed";
import { insertKey, toKeyPublic } from "./keys";
import { toArenaPublic } from "./serialize";

export async function findArena(slug: string): Promise<ArenaRow | undefined> {
  const rows = await (await getDb()).select().from(arenas).where(eq(arenas.slug, slug));
  return rows[0];
}

export async function getArena(slug: string): Promise<ArenaRow> {
  const arena = await findArena(slug);
  if (!arena) throw notFound(`arena '${slug}'`);
  return arena;
}

/** Counts only: reads the few columns grouping and presence need, never the answers. */
export async function listArenaSummaries(nowMs: number): Promise<ArenaSummary[]> {
  const db = await getDb();
  const arenaRows = await db.select().from(arenas).orderBy(asc(arenas.createdAt));
  const rows = await db
    .select({
      arenaId: agents.arenaId,
      status: agents.status,
      waitingOn: agents.waitingOn,
      lastSeenAt: agents.lastSeenAt,
      awaySince: agents.awaySince,
      ttlSeconds: agents.ttlSeconds,
    })
    .from(agents);
  const byArena = new Map<string, CountableAgent[]>();
  for (const r of rows) {
    const list = byArena.get(r.arenaId) ?? [];
    list.push({
      status: r.status,
      waitingOn: r.waitingOn,
      ttlSeconds: r.ttlSeconds,
      lastSeenAt: new Date(r.lastSeenAt).toISOString(),
      awaySince: r.awaySince === null ? null : new Date(r.awaySince).toISOString(),
    });
    byArena.set(r.arenaId, list);
  }
  return arenaRows.map((arena) => ({
    ...toArenaPublic(arena),
    counts: countAgents(byArena.get(arena.id) ?? [], nowMs),
  }));
}

/** Creates the arena with one API key named "default"; the key is returned (and copyable later). */
export async function createArena(
  input: CreateArenaInput,
  nowMs: number,
): Promise<{ arena: ArenaPublic; apiKey: ApiKeyPublic & { token: string } }> {
  return writeTx(async (tx) => {
    const existing = await tx.select({ id: arenas.id }).from(arenas).where(eq(arenas.slug, input.slug));
    if (existing[0]) throw conflict(`arena '${input.slug}' already exists`);
    const row: ArenaRow = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      theme: input.theme,
      version: await nextSeq(tx),
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await tx.insert(arenas).values(row);
    const { row: keyRow, token } = await insertKey(tx, row.id, "default", nowMs);
    const arena = toArenaPublic(row);
    await emit(tx, row.id, { type: "arena.upserted", seq: arena.version, arena }, nowMs);
    return { arena, apiKey: { ...toKeyPublic(keyRow), token } };
  });
}

export async function updateArena(slug: string, input: UpdateArenaInput, nowMs: number): Promise<ArenaPublic> {
  return writeTx(async (tx) => {
    const rows = await tx.select().from(arenas).where(eq(arenas.slug, slug));
    const current = rows[0];
    if (!current) throw notFound(`arena '${slug}'`);
    const next: ArenaRow = {
      ...current,
      name: input.name ?? current.name,
      theme: input.theme ?? current.theme,
      version: await nextSeq(tx),
      updatedAt: nowMs,
    };
    await tx
      .update(arenas)
      .set({ name: next.name, theme: next.theme, version: next.version, updatedAt: nowMs })
      .where(eq(arenas.id, current.id));
    const arena = toArenaPublic(next);
    await emit(tx, current.id, { type: "arena.upserted", seq: arena.version, arena }, nowMs);
    return arena;
  });
}

/** Deletes the arena with its agents, events and keys (foreign keys cascade). */
export async function deleteArena(slug: string, nowMs = Date.now()): Promise<void> {
  await writeTx(async (tx) => {
    const rows = await tx.select({ id: arenas.id }).from(arenas).where(eq(arenas.slug, slug));
    const current = rows[0];
    if (!current) throw notFound(`arena '${slug}'`);
    const seq = await nextSeq(tx);
    await tx.delete(arenas).where(eq(arenas.id, current.id));
    await emit(tx, current.id, { type: "arena.removed", seq, arenaId: current.id, slug }, nowMs);
  });
}
