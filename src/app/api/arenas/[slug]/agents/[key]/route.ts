import { registerAgentInput } from "@/lib/schemas";
import { getAgentDetail, registerAgent, removeAgent } from "@/server/agents";
import { agentKeyFrom, ingestWrite, readContext, type AgentParams } from "@/server/api-context";
import { json, parseWith, route } from "@/server/http";

export const GET = route<AgentParams>(async (req, ctx) => {
  const { slug, key } = await agentKeyFrom(ctx);
  const { arena } = await readContext(req, slug);
  return json(await getAgentDetail(arena, key));
});

export const PUT = route<AgentParams>(async (req, ctx) => {
  const { slug, key } = await agentKeyFrom(ctx);
  const { created, agent } = await ingestWrite(req, slug, "json", (arena, body) =>
    registerAgent(arena, key, parseWith(registerAgentInput, body), Date.now(), body as Record<string, unknown>),
  );
  return json({ agent }, created ? 201 : 200);
});

export const DELETE = route<AgentParams>(async (req, ctx) => {
  const { slug, key } = await agentKeyFrom(ctx);
  await ingestWrite(req, slug, "none", (arena) => removeAgent(arena, key, Date.now()));
  return new Response(null, { status: 204 });
});
