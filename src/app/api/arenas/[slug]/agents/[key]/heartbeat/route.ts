import { heartbeatInput } from "@/lib/schemas";
import { heartbeat } from "@/server/agents";
import { agentKeyFrom, ingestWrite, type AgentParams } from "@/server/api-context";
import { parseWith, route } from "@/server/http";

export const POST = route<AgentParams>(async (req, ctx) => {
  const { slug, key } = await agentKeyFrom(ctx);
  await ingestWrite(req, slug, "json", (arena, body) => heartbeat(arena, key, parseWith(heartbeatInput, body), Date.now()));
  return new Response(null, { status: 204 });
});
