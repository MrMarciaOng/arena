import "server-only";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { LIMITS, type AgentEvent, type EventType } from "@/lib/domain";
import { getDb, rowsOf, type Db, type Tx } from "./db/client";
import { events, type ArenaRow } from "./db/schema";
import { toEvent } from "./serialize";

export async function appendEvent(
  tx: Tx | Db,
  event: {
    arenaId: string;
    agentKey: string;
    type: EventType;
    applied: boolean;
    report: Record<string, unknown> | null;
    agentVersion: number | null;
    createdAt: number;
  },
): Promise<number> {
  const rows = await tx.insert(events).values(event).returning({ id: events.id });
  return Number(rows[0].id);
}

export async function listEvents(
  arena: ArenaRow,
  query: { agent?: string; before?: number; limit: number },
): Promise<AgentEvent[]> {
  const filters = [eq(events.arenaId, arena.id)];
  if (query.agent) filters.push(eq(events.agentKey, query.agent));
  if (query.before) filters.push(lt(events.id, query.before));
  const rows = await (await getDb())
    .select()
    .from(events)
    .where(and(...filters))
    .orderBy(desc(events.id))
    .limit(query.limit);
  return rows.map(toEvent);
}

/**
 * Keeps the newest LIMITS.eventsPerAgent events per agent and drops anything older than
 * LIMITS.eventMaxAgeMs. History is only for the timeline; the live stream never replays it.
 */
export async function pruneEvents(nowMs: number, arenaId?: string): Promise<number> {
  const db = await getDb();
  const cutoff = nowMs - LIMITS.eventMaxAgeMs;
  const scope = arenaId ? sql`arena_id = ${arenaId}` : sql`TRUE`;
  return db.transaction(async (tx) => {
    const old = rowsOf(await tx.execute(sql`DELETE FROM events WHERE ${scope} AND created_at < ${cutoff} RETURNING id`));
    const extra = rowsOf(
      await tx.execute(sql`
        DELETE FROM events WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY arena_id, agent_key ORDER BY id DESC) AS rn
            FROM events WHERE ${scope}
          ) ranked WHERE rn > ${LIMITS.eventsPerAgent}
        ) RETURNING id`),
    );
    return old.length + extra.length;
  });
}

// Per instance: on serverless each instance throttles itself; the daily cron catches the rest.
const lastPrune = new Map<string, number>();

/** Prunes one arena at most once a minute per server instance; called after writes. */
export async function maybePruneArena(arenaId: string, nowMs: number): Promise<void> {
  if (nowMs - (lastPrune.get(arenaId) ?? 0) < 60_000) return;
  lastPrune.set(arenaId, nowMs);
  try {
    await pruneEvents(nowMs, arenaId);
  } catch (err) {
    console.error("[arena] pruning failed", err);
  }
}
