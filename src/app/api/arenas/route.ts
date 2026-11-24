import { createArenaInput } from "@/lib/schemas";
import { adminWrite } from "@/server/api-context";
import { createArena, listArenaSummaries } from "@/server/arenas";
import { assertCanReadAll, resolveReader } from "@/server/auth";
import { json, parseWith, route } from "@/server/http";

export const GET = route(async (req) => {
  assertCanReadAll(await resolveReader(req));
  return json({ arenas: await listArenaSummaries(Date.now()) });
});

export const POST = route(async (req) =>
  json(await adminWrite(req, "json", (body) => createArena(parseWith(createArenaInput, body), Date.now())), 201),
);
