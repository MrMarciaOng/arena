#!/usr/bin/env node
// Claude Code hook → Arena. Install it for the events listed in settings.example.json.
//
// Reads the hook's JSON from stdin and reports, for this session's agent:
//   SessionStart      → registers the agent (named after the project folder)
//   UserPromptSubmit  → working, activity = the prompt (ARENA_SHARE_PROMPTS=0 hides it)
//   Notification      → waiting on you, only for permission and question prompts
//   Stop              → done, result = Claude's last message in this turn
//   SessionEnd        → away (status and answer stay on the dashboard), or, with
//                       ARENA_ON_SESSION_END=remove, the agent leaves the arena altogether
//
// Each session is its own agent, keyed by a hash of the whole session id (claude-<hash>) and named
// after its project folder, so sessions running side by side don't overwrite each other and a
// session that changes directory keeps its card. Set ARENA_AGENT_KEY to share one agent instead.
// Env: ARENA_URL, ARENA_TOKEN, ARENA_SLUG. The report is sent from a detached background process,
// so the hook returns at once and never blocks or fails Claude, even when Arena is down.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename } from "node:path";
import { deliverInBackground, isEntryPoint } from "../../scripts/arena-report.mjs";

/** Notification types that mean "a human has to act". Others (idle, auth success, ...) change nothing. */
const NEEDS_HUMAN = new Set(["permission_prompt", "elicitation_dialog"]);
/** Only this much of the end of a transcript is read when looking for the last answer. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

const chars = (text, max) => {
  const all = Array.from(String(text ?? ""));
  return all.length > max ? `${all.slice(0, max - 1).join("")}…` : all.join("");
};

const folderOf = (input) => basename(input.cwd ?? process.cwd());

/** Identity comes from the whole session id (hashed), never from a prefix or the current folder. */
export function agentKeyFor(input, env = process.env) {
  if (env.ARENA_AGENT_KEY) return env.ARENA_AGENT_KEY;
  return `claude-${createHash("sha256").update(String(input.session_id ?? "unknown")).digest("hex").slice(0, 12)}`;
}

const displayNameFor = (input) => chars(`Claude · ${folderOf(input) || "session"}`, 80);

const oneLine = (text, max = 200) => chars(String(text ?? "").replace(/\s+/g, " ").trim(), max);

/** A message the user sent (text, an image, a document...). A tool result is recorded as a user
 * message too, but it continues the turn rather than starting one. */
const isUserPrompt = (entry) => {
  const message = entry.message ?? entry;
  if (entry.type !== "user" && message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0 && !content.some((c) => c?.type === "tool_result");
};

/**
 * The text of the last assistant message in the current turn of a Claude Code transcript (JSONL),
 * or null if this turn has none. Stops at the turn's prompt so an older answer is never reused.
 */
export function lastAssistantText(transcript) {
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the first line of a tail read is usually cut
    }
    if (isUserPrompt(entry)) return null;
    const message = entry.message ?? entry;
    if (entry.type !== "assistant" && message.role !== "assistant") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
          : "";
    if (text.trim()) return text;
  }
  return null;
}

/** The last TRANSCRIPT_TAIL_BYTES of a regular file (never blocks on a FIFO or device). */
export function readTail(file, limit = TRANSCRIPT_TAIL_BYTES) {
  // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    const length = Math.min(stat.size, limit);
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, stat.size - length + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Maps one hook event to an Arena job. Pure apart from reading the transcript, so it is unit-tested.
 * Returns null when the event should change nothing.
 */
export function planFor(input, { readTranscript = readTail, now = Date.now(), env = process.env } = {}) {
  const key = agentKeyFor(input, env);
  const sharePrompts = env.ARENA_SHARE_PROMPTS !== "0";
  // displayName is only used if this report has to register the agent (SessionStart was missed).
  const base = { session: input.session_id, seq: now, displayName: displayNameFor(input) };
  switch (input.hook_event_name) {
    case "SessionStart":
      return {
        kind: "profile",
        key,
        body: { displayName: displayNameFor(input), role: "Claude Code session" },
      };
    case "UserPromptSubmit":
      return {
        kind: "status",
        key,
        body: { ...base, status: "working", activity: (sharePrompts && oneLine(input.prompt)) || "Working" },
      };
    case "Notification": {
      const type = input.notification_type ?? (/permission/i.test(input.message ?? "") ? "permission_prompt" : null);
      if (!NEEDS_HUMAN.has(type)) return null;
      return {
        kind: "status",
        key,
        body: { ...base, status: "waiting", waitingOn: "human", waitingFor: oneLine(input.message) || "your input" },
      };
    }
    case "Stop": {
      let result = typeof input.last_assistant_message === "string" ? input.last_assistant_message : null;
      if (!result && input.transcript_path) {
        try {
          result = lastAssistantText(readTranscript(input.transcript_path));
        } catch {
          result = null; // report done without an answer rather than not at all
        }
      }
      return { kind: "status", key, body: { ...base, status: "done", ...(result ? { result } : {}) } };
    }
    case "SessionEnd":
      return env.ARENA_ON_SESSION_END === "remove"
        ? { kind: "remove", key, body: null }
        : { kind: "heartbeat", key, body: { leaving: true } };
    default:
      return null;
  }
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const job = planFor(input);
    if (!job) return;
    // Jobs for one agent are delivered in the order they were queued, so "leaving" or "remove"
    // can't overtake the "done" before it.
    deliverInBackground(job);
  } catch (err) {
    console.error(`arena-hook: ${err instanceof Error ? err.message : "failed"}`);
  }
}

if (isEntryPoint(import.meta.url)) main();
