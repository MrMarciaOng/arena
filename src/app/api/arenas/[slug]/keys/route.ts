import { createKeyInput } from "@/lib/schemas";
import { adminWrite, type SlugParams } from "@/server/api-context";
import { getArena } from "@/server/arenas";
import { assertAdmin, resolveBearer } from "@/server/auth";
import { json, parseWith, route } from "@/server/http";
import { createKey, listKeys } from "@/server/keys";

/** Lists the arena's API keys (names and prefixes, never the keys). Admin only. */
export const GET = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  assertAdmin(await resolveBearer(req));
  return json({ keys: await listKeys(await getArena(slug)) });
});

/** Creates a named key: `{ "name": "laptop" }` → `{ key, token }`. Admin only. */
export const POST = route<SlugParams>(async (req, ctx) => {
  const { slug } = await ctx.params;
  const created = await adminWrite(req, "json", async (body) =>
    createKey(await getArena(slug), parseWith(createKeyInput, body).name, Date.now()),
  );
  return json(created, 201);
});
