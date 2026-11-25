"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createArenaInput, keyNameSchema, slugSchema, updateArenaInput } from "@/lib/schemas";
import { agentIdFor, removeAgent } from "./agents";
import type { ArenaOwner } from "./arena-owner";
import { createArena, deleteArena, findArena, getArena, updateArena } from "./arenas";
import { requireOwner } from "./auth";
import { ApiError } from "./errors";
import { createKey, revealKey, revokeKey } from "./keys";

// Settings actions. Each one checks the owner session itself before touching anything.

export type FormState = { ok?: boolean; error?: string; token?: string; keyName?: string; keyId?: string; slug?: string };

async function guarded(fn: (owner: ArenaOwner) => Promise<FormState>): Promise<FormState> {
  try {
    return await fn(await requireOwner());
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    throw err;
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input";
}

export async function createArenaAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async (owner) => {
    const parsed = createArenaInput.safeParse({
      slug: String(form.get("slug") ?? "").trim(),
      name: String(form.get("name") ?? ""),
      theme: String(form.get("theme") ?? "office"),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    const { arena, apiKey } = await createArena(parsed.data, Date.now(), owner);
    return { ok: true, slug: arena.slug, token: apiKey.token, keyName: apiKey.name };
  });
}

export async function createKeyAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async (owner) => {
    const parsed = z.strictObject({ slug: slugSchema, name: keyNameSchema }).safeParse({
      slug: form.get("slug"),
      name: form.get("name"),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    const { key, token } = await createKey(await getArena(parsed.data.slug, owner), parsed.data.name, Date.now());
    return { ok: true, slug: parsed.data.slug, token, keyName: key.name, keyId: key.id };
  });
}

/** Key ids are UUIDs, or 32 hex characters for keys migrated from the old single token. */
const keyId = z.string().regex(/^[0-9a-f-]{32,36}$/i, "invalid key id");
const keyRef = z.strictObject({ slug: slugSchema, id: keyId });

/** Returns a key so the owner can copy it. Called from a button, not a form. */
export async function revealKeyAction(input: { slug: string; id: string }): Promise<FormState> {
  return guarded(async (owner) => {
    const parsed = keyRef.safeParse(input);
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    const { key, token } = await revealKey(await getArena(parsed.data.slug, owner), parsed.data.id);
    return { ok: true, token, keyName: key.name };
  });
}

export async function revokeKeyAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async (owner) => {
    const parsed = keyRef.safeParse({ slug: form.get("slug"), id: form.get("id") });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    await revokeKey(await getArena(parsed.data.slug, owner), parsed.data.id);
    return { ok: true };
  });
}

export async function updateArenaAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async (owner) => {
    const slug = slugSchema.safeParse(form.get("slug"));
    if (!slug.success) return { error: firstIssue(slug.error) };
    const parsed = updateArenaInput.safeParse({
      name: form.get("name") ?? undefined,
      theme: form.get("theme") ?? undefined,
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    await updateArena(slug.data, parsed.data, Date.now(), owner);
    return { ok: true, slug: slug.data };
  });
}

export async function removeAgentAction(_prev: FormState, form: FormData): Promise<FormState> {
  return guarded(async (owner) => {
    const parsed = z.strictObject({ slug: slugSchema, key: slugSchema, agentId: z.string().min(1) }).safeParse({
      slug: form.get("slug"),
      key: form.get("key"),
      agentId: form.get("agentId"),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    const arena = await findArena(parsed.data.slug, owner);
    if (!arena) return { error: "arena not found" };
    // The page may be stale: only remove the agent it showed, not a newer one with the same key.
    if ((await agentIdFor(arena, parsed.data.key)) !== parsed.data.agentId) {
      return { error: "this agent has changed since the page loaded; reload and try again" };
    }
    await removeAgent(arena, parsed.data.key, Date.now());
    return { ok: true, slug: parsed.data.slug };
  });
}

/** Deleting needs the slug typed again, so a stray click can't wipe an arena. */
export async function deleteArenaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const result = await guarded(async (owner) => {
    const parsed = z.strictObject({ slug: slugSchema, arenaId: z.string().min(1), confirm: z.string() }).safeParse({
      slug: form.get("slug"),
      arenaId: form.get("arenaId"),
      confirm: form.get("confirm"),
    });
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    if (parsed.data.confirm.trim() !== parsed.data.slug) return { error: `type "${parsed.data.slug}" to confirm` };
    // Only delete the arena this page showed, not a newer one created under the same slug.
    await deleteArena(parsed.data.slug, Date.now(), { owner, id: parsed.data.arenaId });
    return { ok: true };
  });
  if (result.ok) redirect("/");
  return result;
}
