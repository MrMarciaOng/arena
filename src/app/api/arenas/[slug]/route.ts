import { updateArenaInput } from "@/lib/schemas";
import { listAgents } from "@/server/agents";
import { adminWrite, readContext, type SlugParams } from "@/server/api-context";
import { deleteArena, updateArena } from "@/server/arenas";
import { json, parseWith, route } from "@/server/http";
import { toArenaPublic } from "@/server/serialize";

export const GET = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  const { arena } = await readContext(req, slug);
  return json({
    arena: toArenaPublic(arena),
    agents: await listAgents(arena),
    serverTime: new Date().toISOString(),
  });
});

export const PATCH = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  const arena = await adminWrite(req, "json", (body) => updateArena(slug, parseWith(updateArenaInput, body), Date.now()));
  return json({ arena });
});

export const DELETE = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  await adminWrite(req, "none", () => deleteArena(slug));
  return new Response(null, { status: 204 });
});
