import { getEnv } from "@/server/env";
import { unauthorized } from "@/server/errors";
import { pruneEvents } from "@/server/events";
import { pruneChanges } from "@/server/feed";
import { json, route } from "@/server/http";
import { pruneThrottles } from "@/server/rate-limit";
import { secretsEqual } from "@/server/tokens";

/**
 * Daily housekeeping, called by Vercel Cron (see vercel.json) with `Authorization: Bearer $CRON_SECRET`:
 * event-history retention, the change feed's one-hour window, and old rate-limit counters.
 */
export const GET = route(async (req) => {
  const secret = getEnv().CRON_SECRET;
  const sent = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!secret || !sent || !secretsEqual(sent, secret)) throw unauthorized("cron only");
  const now = Date.now();
  const events = await pruneEvents(now);
  const changes = await pruneChanges(now);
  await pruneThrottles(now);
  return json({ ok: true, pruned: { events, changes } });
});
