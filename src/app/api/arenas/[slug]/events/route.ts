import { eventsQuery } from "@/lib/schemas";
import { readContext, type SlugParams } from "@/server/api-context";
import { listEvents } from "@/server/events";
import { json, parseWith, route } from "@/server/http";

export const GET = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  const { arena } = await readContext(req, slug);
  const query = parseWith(eventsQuery, Object.fromEntries(new URL(req.url).searchParams));
  const events = await listEvents(arena, query);
  return json({ events, nextBefore: events.length === query.limit ? events.at(-1)!.id : null });
});
