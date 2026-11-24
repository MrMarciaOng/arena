#!/usr/bin/env node
// Codex `notify` → Arena. In ~/.codex/config.toml:
//
//   notify = ["node", "/path/to/arena/examples/codex-notify/arena-notify.mjs"]
//
// Codex runs it with one JSON argument. On "agent-turn-complete" this reports `done` with Codex's
// last message as the answer, and what you asked as the activity (ARENA_SHARE_PROMPTS=0 hides it).
// Each Codex thread is its own agent (codex-<hash of the thread id>, named after its folder); set
// ARENA_AGENT_KEY to share one.
// Env: ARENA_URL, ARENA_TOKEN, ARENA_SLUG. Sent from a detached background process; never fails.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { deliverInBackground, isEntryPoint } from "../../scripts/arena-report.mjs";

/** Identity comes from the whole thread id (hashed): UUIDv7 prefixes are timestamps, so two threads
 * started close together would share one. */
export function agentKeyFor(event, env = process.env) {
  if (env.ARENA_AGENT_KEY) return env.ARENA_AGENT_KEY;
  return `codex-${createHash("sha256").update(String(event["thread-id"] ?? "unknown")).digest("hex").slice(0, 12)}`;
}

/** Maps a Codex notification to a status report, or null to ignore it. */
export function planFor(event, now = Date.now(), env = process.env) {
  if (event?.type !== "agent-turn-complete") return null;
  const asked = Array.isArray(event["input-messages"]) ? event["input-messages"].join(" ") : "";
  const flat = asked.replace(/\s+/g, " ").trim();
  const all = Array.from(flat);
  const activity = env.ARENA_SHARE_PROMPTS === "0" ? "" : all.length > 200 ? `${all.slice(0, 199).join("")}…` : flat;
  const result = event["last-assistant-message"];
  const folder = basename(event.cwd ?? process.cwd()) || "thread";
  const name = Array.from(`Codex · ${folder}`);
  return {
    status: "done",
    session: event["thread-id"] ?? undefined,
    seq: now,
    // Used only when this report registers the agent (the first turn of a thread).
    displayName: name.length > 80 ? `${name.slice(0, 79).join("")}…` : name.join(""),
    ...(activity ? { activity } : {}),
    ...(typeof result === "string" && result ? { result } : {}),
  };
}

function main() {
  try {
    const event = JSON.parse(process.argv.at(-1) ?? "{}");
    const body = planFor(event);
    if (body) deliverInBackground({ kind: "status", key: agentKeyFor(event), body });
  } catch (err) {
    console.error(`arena-notify: ${err instanceof Error ? err.message : "failed"}`);
  }
}

if (isEntryPoint(import.meta.url)) main();
