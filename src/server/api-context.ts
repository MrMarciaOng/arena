import "server-only";
import { slugSchema } from "@/lib/schemas";
import { getArena } from "./arenas";
import { assertAdmin, assertCanIngest, assertCanReadArena, resolveBearer, resolveReader, type Credential } from "./auth";
import type { ArenaRow } from "./db/schema";
import { unauthorized } from "./errors";
import { discardBody, parseWith, readJson } from "./http";

export type SlugParams = { params: Promise<{ slug: string }> };
export type AgentParams = { params: Promise<{ slug: string; key: string }> };

export async function agentKeyFrom(ctx: AgentParams): Promise<{ slug: string; key: string }> {
  const { slug, key } = await ctx.params;
  return { slug, key: parseWith(slugSchema, key) };
}

/** Credential first, then the arena, so unauthenticated callers can't probe which arenas exist. */
async function ingestContext(req: Request, slug: string, charge: boolean): Promise<ArenaRow> {
  const cred = await resolveBearer(req, { charge });
  if (cred.kind === "none") {
    throw unauthorized("send this arena's token as 'Authorization: Bearer <token>'");
  }
  const arena = await getArena(slug);
  assertCanIngest(cred, arena);
  return arena;
}

/**
 * For agent writes. Rejects bad credentials before reading the body, reads the body (bounded),
 * then checks the credential and arena again before writing. The write itself re-reads the arena
 * inside its transaction while holding the write lock (which arena deletion also takes), so an
 * arena deleted meanwhile gives 404, never a half-done write.
 */
export async function ingestWrite<R>(
  req: Request,
  slug: string,
  body: "json" | "none",
  write: (arena: ArenaRow, body: unknown) => Promise<R>,
): Promise<R> {
  await ingestContext(req, slug, true);
  const parsed = body === "json" ? await readJson(req) : await discardBody(req);
  return write(await ingestContext(req, slug, false), parsed);
}

/** For admin writes, with the same check, read, re-check order as ingestWrite. */
export async function adminWrite<R>(req: Request, body: "json" | "none", write: (body: unknown) => Promise<R>): Promise<R> {
  assertAdmin(await resolveBearer(req));
  const parsed = body === "json" ? await readJson(req) : await discardBody(req);
  assertAdmin(await resolveBearer(req, { charge: false }));
  return write(parsed);
}

export async function readContext(req: Request, slug: string): Promise<{ cred: Credential; arena: ArenaRow }> {
  const cred = await resolveReader(req);
  if (cred.kind === "none") throw unauthorized();
  const arena = await getArena(slug);
  assertCanReadArena(cred, arena);
  return { cred, arena };
}
