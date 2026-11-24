import { listAgents } from "@/server/agents";
import { readContext, type SlugParams } from "@/server/api-context";
import { json, route } from "@/server/http";

export const GET = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  const { arena } = await readContext(req, slug);
  return json({ agents: await listAgents(arena) });
});
