import { z } from "zod";
import { createArenaInput } from "@/lib/schemas";
import { adminWrite } from "@/server/api-context";
import { createArena, listArenaSummaries } from "@/server/arenas";
import { assertCanReadAll, readerArenaOwner, resolveReader } from "@/server/auth";
import { json, parseWith, route } from "@/server/http";

export const GET = route(async (req) => {
  const cred = await resolveReader(req);
  assertCanReadAll(cred);
  return json({ arenas: await listArenaSummaries(Date.now(), readerArenaOwner(cred)) });
});

const adminCreateArenaInput = createArenaInput.extend({ ownerUserId: z.uuid().toLowerCase().optional() });

export const POST = route(async (req) =>
  json(await adminWrite(req, "json", (body) => {
    const { ownerUserId, ...input } = parseWith(adminCreateArenaInput, body);
    return createArena(input, Date.now(), ownerUserId ? { ownerUserId } : undefined);
  }), 201),
);
