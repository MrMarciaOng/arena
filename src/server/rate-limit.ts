import "server-only";
import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { loginFailures, rateLimits } from "./db/schema";

// Kept in Postgres, not in memory: on Vercel every request may land on a different instance, and
// a per-instance counter would let a client spread its attempts across them.

const WINDOW_MS = 10_000;
/** Requests per token per 10-second window (default 200, i.e. 20 a second on average). */
const apiLimit = () => Number(process.env.ARENA_RATE_LIMIT_PER_10S ?? 200);

/** Counts one request for `key`. Returns 0 if allowed, otherwise the seconds to wait. */
export async function takeRequest(key: string, nowMs: number): Promise<number> {
  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const rows = await (await getDb())
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  if (rows[0].count <= apiLimit()) return 0;
  return Math.max(1, Math.ceil((windowStart + WINDOW_MS - nowMs) / 1000));
}

const LOGIN_WINDOW_MS = 60_000;
const PER_CLIENT = 5;
const OVERALL = 20;

/**
 * Failed-login throttle: at most 5 failures per client and 20 in total per minute. Going over locks
 * the client (or everyone) out until the oldest counted failure is a minute old.
 * Returns the seconds to wait, or 0.
 */
export async function loginRetryAfter(client: string, nowMs: number): Promise<number> {
  const db = await getDb();
  const since = nowMs - LOGIN_WINDOW_MS;
  const waits: number[] = [];
  const mine = await db
    .select({ at: loginFailures.at })
    .from(loginFailures)
    .where(and(eq(loginFailures.client, client), gte(loginFailures.at, since)))
    .orderBy(asc(loginFailures.at));
  if (mine.length >= PER_CLIENT) waits.push(mine[mine.length - PER_CLIENT].at + LOGIN_WINDOW_MS - nowMs);
  const all = await db.select({ n: count() }).from(loginFailures).where(gte(loginFailures.at, since));
  if (Number(all[0].n) >= OVERALL) {
    const oldest = await db
      .select({ at: loginFailures.at })
      .from(loginFailures)
      .where(gte(loginFailures.at, since))
      .orderBy(asc(loginFailures.at))
      .limit(1)
      .offset(Number(all[0].n) - OVERALL);
    if (oldest[0]) waits.push(oldest[0].at + LOGIN_WINDOW_MS - nowMs);
  }
  return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0;
}

export async function recordLoginFailure(client: string, nowMs: number): Promise<void> {
  await (await getDb()).insert(loginFailures).values({ client, at: nowMs });
}

/** Drops counters that can no longer matter (run by the daily cron). */
export async function pruneThrottles(nowMs: number): Promise<void> {
  const db = await getDb();
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, nowMs - 60_000));
  await db.delete(loginFailures).where(lt(loginFailures.at, nowMs - 60 * 60_000));
}
