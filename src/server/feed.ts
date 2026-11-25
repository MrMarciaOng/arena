import "server-only";
import { and, asc, gt, lt, sql } from "drizzle-orm";
import type { StreamMessage } from "@/lib/domain";
import { arenaOwnerFilter, type ArenaOwner } from "./arena-owner";
import { getDb, rowsOf, writeTx, type Tx } from "./db/client";
import { changes, counters, type ArenaRow } from "./db/schema";

/** A change the dashboards should see, numbered by the global counter. */
export type FeedMessage = Exclude<StreamMessage, { type: "snapshot" } | { type: "reconnect" }>;

/** How long the feed keeps changes. Live streams only ever read the last few minutes. */
export const FEED_RETENTION_MS = 60 * 60 * 1000;

/**
 * Records a change in the live-update feed. Call inside writeTx(), after taking the message's
 * seq from nextSeq(), so the feed commits with the change and in counter order.
 */
export async function emit(tx: Tx, arena: Pick<ArenaRow, "id" | "ownerUserId">, message: FeedMessage, nowMs: number): Promise<void> {
  await tx.insert(changes).values({ seq: message.seq, arenaId: arena.id, ownerUserId: arena.ownerUserId, message, createdAt: nowMs });
}

/**
 * Changes after `cursor`, oldest first. `gap` is true when the feed was pruned past the cursor,
 * so some changes are gone and the reader needs a fresh snapshot instead.
 */
export async function readChanges(
  after: number,
  limit: number,
  owner?: ArenaOwner,
): Promise<{ messages: FeedMessage[]; gap: boolean }> {
  const conn = await getDb();
  const rows = await conn
    .select({ message: changes.message })
    .from(changes)
    .where(and(gt(changes.seq, after), arenaOwnerFilter(changes.ownerUserId, owner)))
    .orderBy(asc(changes.seq))
    .limit(limit);
  // Read after the rows: if pruning removed anything newer than the cursor, this now says so.
  const pruned = await conn
    .select({ value: counters.value })
    .from(counters)
    .where(sql`${counters.name} = 'changes_pruned_through'`);
  return { messages: rows.map((r) => r.message as FeedMessage), gap: Number(pruned[0]?.value ?? 0) > after };
}

/** Drops changes older than the retention window and records how far the feed was pruned. */
export async function pruneChanges(nowMs: number): Promise<number> {
  return writeTx(async (tx) => {
    const removed = rowsOf<{ seq: string | number }>(
      await tx.execute(
        sql`DELETE FROM ${changes} WHERE ${lt(changes.createdAt, nowMs - FEED_RETENTION_MS)} RETURNING ${changes.seq}`,
      ),
    );
    if (removed.length === 0) return 0;
    const highest = Math.max(...removed.map((r) => Number(r.seq)));
    await tx
      .update(counters)
      .set({ value: sql`GREATEST(${counters.value}, ${highest})` })
      .where(sql`${counters.name} = 'changes_pruned_through'`);
    return removed.length;
  });
}
