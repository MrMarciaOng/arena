import "server-only";
import { asc, inArray } from "drizzle-orm";
import type { StreamSnapshot } from "@/lib/domain";
import { currentSeq, getDb } from "./db/client";
import { agents, arenas } from "./db/schema";
import { toAgentPublic, toArenaPublic } from "./serialize";

/**
 * Everything the UI shows, read at one point in time (a REPEATABLE READ, read-only transaction).
 * `seq` is the change counter at that point. Writes take the counter row's lock and commit in
 * counter order, so every change numbered `seq` or lower is in this snapshot and every later one
 * has a higher number: the live stream continues from `seq` without gaps or repeats.
 */
export async function readSnapshot(slugs: string[] | null, nowMs: number): Promise<StreamSnapshot> {
  const db = await getDb();
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const arenaRows = await (slugs
        ? tx.select().from(arenas).where(inArray(arenas.slug, slugs))
        : tx.select().from(arenas)
      ).orderBy(asc(arenas.createdAt));
      const slugById = new Map(arenaRows.map((a) => [a.id, a.slug]));
      const agentRows =
        arenaRows.length === 0
          ? []
          : await tx
              .select()
              .from(agents)
              .where(inArray(agents.arenaId, [...slugById.keys()]))
              .orderBy(asc(agents.seat));
      return {
        type: "snapshot" as const,
        seq,
        serverTime: new Date(nowMs).toISOString(),
        arenas: arenaRows.map(toArenaPublic),
        agents: agentRows.map((row) => toAgentPublic(row, slugById.get(row.arenaId)!)),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
