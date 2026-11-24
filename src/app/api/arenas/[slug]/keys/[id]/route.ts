import { adminWrite } from "@/server/api-context";
import { getArena } from "@/server/arenas";
import { assertAdmin, resolveBearer } from "@/server/auth";
import { json, route } from "@/server/http";
import { revealKey, revokeKey } from "@/server/keys";

type KeyParams = { params: Promise<{ slug: string; id: string }> };

/** The key itself, for copying: `{ key, token }`. Admin only. */
export const GET = route<KeyParams>(async (req, ctx) => {
  const { slug, id } = await ctx.params;
  assertAdmin(await resolveBearer(req));
  return json(await revealKey(await getArena(slug), id), 200, { "Cache-Control": "no-store" });
});

/** Revokes the key. Admin only. */
export const DELETE = route<KeyParams>(async (req, ctx) => {
  const { slug, id } = await ctx.params;
  await adminWrite(req, "none", async () => revokeKey(await getArena(slug), id));
  return new Response(null, { status: 204 });
});
