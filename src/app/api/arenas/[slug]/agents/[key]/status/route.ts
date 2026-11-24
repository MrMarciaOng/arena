import { statusInput } from "@/lib/schemas";
import { reportStatus } from "@/server/agents";
import { agentKeyFrom, ingestWrite, type AgentParams } from "@/server/api-context";
import { json, parseWith, route } from "@/server/http";

export const POST = route<AgentParams>(async (req, ctx) => {
  const { slug, key } = await agentKeyFrom(ctx);
  const { applied, created, agent } = await ingestWrite(req, slug, "json", (arena, body) =>
    // History keeps the body exactly as submitted; the agent row gets the validated values.
    reportStatus(arena, key, parseWith(statusInput, body), Date.now(), body as Record<string, unknown>),
  );
  return json({ applied, agent }, created ? 201 : 200);
});
