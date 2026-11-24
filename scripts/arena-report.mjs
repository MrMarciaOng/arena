#!/usr/bin/env node
// Report an agent's state to Arena from a shell, a hook or a cron job. No dependencies; Node 18+.
//
//   ARENA_URL=http://localhost:3000 ARENA_TOKEN=arena_... ARENA_SLUG=career \
//     arena-report.mjs resume-writer working --activity "Tailoring resume"
//   arena-report.mjs resume-writer done --result-file answer.md
//   some-command | arena-report.mjs resume-writer done --result-stdin
//   arena-report.mjs resume-writer waiting --waiting-on human --waiting-for "your approval"
//   arena-report.mjs resume-writer heartbeat --leaving
//   arena-report.mjs resume-writer register --name "Resume Writer" --role "Tailors resumes"
//   arena-report.mjs resume-writer remove          # take the agent off the arena
//   arena-report.mjs check                         # is the configuration right?
//   arena-report.mjs new-key --tool claude         # a fresh agent key, e.g. claude-arena-k3x9
//
// Options: --activity --progress --waiting-on --waiting-for --result --result-file --result-stdin
//          --error --name --role --session --seq --ttl --leaving --arena --strict
// Configuration comes from the environment, or else from ~/.config/arena/env (or $ARENA_CONFIG):
// KEY=VALUE lines for ARENA_URL, ARENA_TOKEN and ARENA_SLUG. Keep that file private (chmod 600).
// Never fails loudly by default: hooks must not break the agent. Pass --strict to exit non-zero on
// any error (bad arguments included). Error messages never include the token or response bodies.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Server limit on a request body. We stay a little under it. */
export const BODY_LIMIT = 256 * 1024;
const BODY_BUDGET = BODY_LIMIT - 4 * 1024;
/** Never hold more of an answer than this in memory; the server keeps at most 64 KB anyway. */
export const INPUT_LIMIT = 1024 * 1024;
const NOTE = "\n\n…(cut by arena-report to fit the request limit)";
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const bytes = (text) => Buffer.byteLength(text, "utf8");

/** Cuts a string at a code point boundary so it has at most `max` UTF-8 bytes. */
export function cutUtf8(text, max) {
  if (bytes(text) <= max) return text;
  const buf = Buffer.from(text, "utf8");
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Shrinks body.result until the JSON body fits the server's limit (JSON escaping can make the
 * encoded answer much bigger than the text). Marks a cut answer so the reader knows.
 */
export function fitBody(body) {
  if (typeof body.result !== "string" || bytes(JSON.stringify(body)) <= BODY_BUDGET) return body;
  let lo = 0;
  let hi = Math.min(bytes(body.result), BODY_BUDGET);
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = cutUtf8(body.result, mid) + NOTE;
    if (bytes(JSON.stringify({ ...body, result: candidate })) <= BODY_BUDGET) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { ...body, result: best || NOTE.trim() };
}

/**
 * Keeps at most `limit` bytes from a file descriptor and marks the text when there was more.
 * With `drain`, it reads on to the end without keeping it, so a program piping into us isn't cut
 * off with SIGPIPE halfway through its output.
 */
export function readBounded(fd, limit = INPUT_LIMIT, { drain = true } = {}) {
  const buf = Buffer.alloc(limit + 1);
  const scratch = Buffer.alloc(64 * 1024);
  let size = 0;
  for (;;) {
    let n;
    const full = size > limit;
    try {
      n = full ? readSync(fd, scratch, 0, scratch.length, null) : readSync(fd, buf, size, buf.length - size, null);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      if (err.code === "EOF") break;
      throw err;
    }
    if (n === 0) break;
    if (!full) size += n;
    if (size > limit && !drain) break;
  }
  const text = cutUtf8(buf.subarray(0, Math.min(size, limit)).toString("utf8"), limit);
  return size > limit ? text + NOTE : text;
}

function readFileBounded(file) {
  const fd = openSync(file, "r");
  try {
    return readBounded(fd, INPUT_LIMIT, { drain: false });
  } finally {
    closeSync(fd);
  }
}

class UsageError extends Error {}

const CONFIG_KEYS = ["ARENA_URL", "ARENA_TOKEN", "ARENA_SLUG"];

/** KEY=VALUE lines (# comments, optional quotes) from the private config file, if there is one. */
export function readConfigFile(file = process.env.ARENA_CONFIG || path.join(homedir(), ".config", "arena", "env")) {
  if (!existsSync(file)) return {};
  if ((statSync(file).mode & 0o077) !== 0) {
    console.error(`arena-report: ${file} is readable by other users; run: chmod 600 ${file}`);
  }
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !CONFIG_KEYS.includes(m[1])) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

/** The environment wins; the config file fills in whatever it leaves out. */
function settings(env = process.env) {
  if (CONFIG_KEYS.every((k) => env[k])) return env;
  return { ...readConfigFile(), ...Object.fromEntries(CONFIG_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])) };
}

function config(env = process.env) {
  const s = settings(env);
  const url = (s.ARENA_URL ?? "").replace(/\/$/, "");
  const token = s.ARENA_TOKEN ?? "";
  const arena = s.ARENA_SLUG ?? "";
  if (!url || !token || !arena) {
    const named = env.ARENA_CONFIG;
    if (named && !existsSync(named)) throw new UsageError(`ARENA_CONFIG points to ${named}, which doesn't exist`);
    throw new UsageError("set ARENA_URL, ARENA_TOKEN and ARENA_SLUG (or put them in ~/.config/arena/env)");
  }
  if (!KEY_RE.test(arena)) throw new UsageError("ARENA_SLUG is not a valid arena slug");
  return { url, token, arena };
}

/** A short description of a failure that never includes request headers or response bodies. */
async function describeFailure(res) {
  let code = "";
  try {
    const parsed = await res.json();
    if (typeof parsed?.error?.code === "string" && /^[a-z_]{1,40}$/.test(parsed.error.code)) code = ` ${parsed.error.code}`;
  } catch {
    // not the Arena error envelope; say nothing more
  }
  return `HTTP ${res.status}${code}`;
}

async function call(method, apiPath, body, { env, timeoutMs = 5000 } = {}) {
  const { url, token } = config(env);
  let res;
  try {
    res = await fetch(`${url}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect could resend the body (prompts, answers) to another host.
      redirect: "error",
    });
  } catch (err) {
    // fetch's own messages can echo header values; keep only the kind of failure.
    const kind = err?.name === "TimeoutError" ? "timed out" : "could not reach Arena";
    throw new Error(`request failed: ${kind}`);
  }
  if (!res.ok) throw new Error(await describeFailure(res));
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    // A JSON parse error quotes the body; say only what went wrong.
    throw new Error(`HTTP ${res.status} with a response that isn't Arena's JSON`);
  }
}

function agentPath(env, key) {
  if (!KEY_RE.test(key)) throw new UsageError(`"${key}" is not a valid agent key (a-z, 0-9, '.', '_', '-'; 1-64 characters)`);
  return `/api/arenas/${encodeURIComponent(config(env).arena)}/agents/${encodeURIComponent(key)}`;
}

export function sendStatus(key, body, opts = {}) {
  return call("POST", `${agentPath(opts.env, key)}/status`, fitBody(body), opts);
}

export function sendHeartbeat(key, body = {}, opts = {}) {
  return call("POST", `${agentPath(opts.env, key)}/heartbeat`, body, opts);
}

export function sendProfile(key, body, opts = {}) {
  return call("PUT", agentPath(opts.env, key), body, opts);
}

/** Takes the agent off the arena (its seat frees up; its history stays until pruned). */
export function sendRemove(key, opts = {}) {
  return call("DELETE", agentPath(opts.env, key), undefined, opts);
}

/** Reads the arena the key belongs to: proves the URL, key and slug all line up. */
export async function checkConfig(opts = {}) {
  const { arena } = config(opts.env);
  const res = await call("GET", `/api/arenas/${encodeURIComponent(arena)}`, undefined, opts);
  return { arena: res.arena.slug, name: res.arena.name, agents: res.agents.length };
}

/** A fresh agent key for one session: <tool>-<folder>-<4 random characters>. */
export function newKey(tool = "agent", folder = path.basename(process.cwd())) {
  const clean = (text, max) =>
    String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, max);
  const suffix = randomBytes(3).toString("hex").slice(0, 4);
  const t = clean(tool, 16) || "agent";
  const f = clean(folder, 64 - t.length - suffix.length - 2) || "project";
  return `${t}-${f}-${suffix}`;
}

/** Runs one job: { kind: "status" | "heartbeat" | "profile" | "remove", key, body }. */
export function sendJob(job, opts = {}) {
  if (job.kind === "profile") return sendProfile(job.key, job.body, opts);
  if (job.kind === "heartbeat") return sendHeartbeat(job.key, job.body, opts);
  if (job.kind === "remove") return sendRemove(job.key, opts);
  return sendStatus(job.key, job.body, opts);
}

const SELF = fileURLToPath(import.meta.url);

/**
 * Background delivery for hooks. Each job is written to a private per-agent spool folder, then a
 * detached worker sends that agent's jobs one at a time in the order they were written, so a slow
 * "done" can never land after the "leaving" or "remove" that followed it. The hook itself returns at
 * once, even when Arena is slow or down. Jobs carry prompts and answers but never the key (that
 * stays in the environment) and never go on a command line, where `ps` would show them.
 */
export function spoolRoot() {
  if (process.env.ARENA_SPOOL_DIR) return path.resolve(process.env.ARENA_SPOOL_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(tmpdir(), `arena-report-spool-${uid}`);
}

const keyDir = (key) => path.join(spoolRoot(), createHash("sha256").update(String(key)).digest("hex").slice(0, 16));
const ERROR_LOG = () => path.join(spoolRoot(), "errors.log");

export function deliverInBackground(job, { startWorker = true } = {}) {
  // Configuration problems are local and immediate: say so now rather than fail silently later.
  config();
  const dir = keyDir(job.key);
  mkdirSync(spoolRoot(), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(15, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}-${randomBytes(3).toString("hex")}.json`;
  writeFileSync(path.join(dir, name), JSON.stringify(job), { mode: 0o600 });
  if (!startWorker) return dir;
  try {
    const child = spawn(process.execPath, [SELF, "--drain", dir], { detached: true, stdio: "ignore" });
    // A worker that can't start leaves the job for the next one; it must not crash the hook.
    child.on("error", () => {});
    child.unref();
  } catch {
    // same: the job stays queued
  }
  return dir;
}

function logDeliveryError(job, err) {
  try {
    const line = `${new Date().toISOString()} ${job?.kind ?? "?"} ${job?.key ?? "?"}: ${err instanceof Error ? err.message : "failed"}\n`;
    const file = ERROR_LOG();
    const kept = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-19) : [];
    writeFileSync(file, [...kept, line.trim()].join("\n") + "\n", { mode: 0o600 });
  } catch {
    // nowhere left to report to
  }
}

/** Recent background delivery failures, newest last (shown by `check`). */
export function recentDeliveryErrors() {
  try {
    return readFileSync(ERROR_LOG(), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends every queued job for one agent, oldest first. Only one worker per agent runs at a time. */
export async function drainSpool(dir, { send = sendJob } = {}) {
  // Only ever touch a spool folder this tool made, never a path that merely arrived in argv.
  const root = spoolRoot();
  if (path.dirname(path.resolve(dir)) !== root || !/^[0-9a-f]{16}$/.test(path.basename(dir))) return;
  const lock = path.join(dir, ".lock");
  for (;;) {
    try {
      mkdirSync(lock);
    } catch {
      // Another worker is draining. Take over only from one that died long ago.
      try {
        if (Date.now() - statSync(lock).mtimeMs < 60_000) return;
        rmdirSync(lock);
      } catch {
        return;
      }
      continue;
    }
    try {
      for (;;) {
        const jobs = readdirSync(dir).filter((f) => /^\d{15}-\d{20}-[0-9a-f]{6}\.json$/.test(f)).sort();
        if (jobs.length === 0) break;
        const file = path.join(dir, jobs[0]);
        let job;
        try {
          job = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          job = null;
        }
        rmSync(file, { force: true });
        if (!job) continue;
        try {
          await send(job, { timeoutMs: 10_000 });
        } catch (err) {
          logDeliveryError(job, err);
        }
      }
    } finally {
      rmdirSync(lock);
    }
    // A job written while we were releasing the lock would otherwise wait for the next hook.
    await sleep(20);
    if (!readdirSync(dir).some((f) => f.endsWith(".json"))) return;
  }
}

const VALUE_FLAGS = new Set([
  "activity",
  "progress",
  "waiting-on",
  "waiting-for",
  "result",
  "result-file",
  "error",
  "name",
  "role",
  "arena",
  "tool",
  "session",
  "seq",
  "ttl",
]);
const SWITCHES = new Set(["leaving", "result-stdin", "strict"]);
const STATUSES = new Set(["idle", "working", "waiting", "done", "error", "heartbeat", "register", "remove"]);
/** Commands that take no agent key. */
const STANDALONE = new Set(["check", "new-key"]);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    // `--name=value` takes the value literally, even one that starts with "--" (front matter, say).
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (SWITCHES.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} needs a value (use --${name}=<value> for one that starts with "--")`);
      }
      flags[name] = value;
      i += 1;
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  // Without a session, an explicit seq would share one ordering with every other unsessioned
  // report for this agent, so a restarted job's reports could be ignored.
  if (flags.seq !== undefined && !flags.session) throw new UsageError("--seq needs --session");
  if (positional.length === 1 && STANDALONE.has(positional[0])) return { key: null, status: positional[0], flags };
  if (positional.length !== 2) {
    throw new UsageError("usage: arena-report.mjs <agent-key> <status|register|heartbeat|remove> [options], or: check | new-key");
  }
  const [key, status] = positional;
  if (!STATUSES.has(status)) throw new UsageError(`unknown status "${status}"`);
  return { key, status, flags };
}

export function buildStatusBody(status, flags, readStdin = () => readBounded(0)) {
  const body = { status };
  if (flags.activity) body.activity = flags.activity;
  if (flags.name) body.displayName = flags.name;
  // Ordering only when asked for: a wall-clock seq without a session would let a slow clock or a
  // restart on another machine have its later reports ignored.
  if (flags.session) {
    body.session = flags.session;
    body.seq = flags.seq !== undefined ? Number(flags.seq) : Date.now();
  }
  if (flags.ttl) body.ttlSeconds = Number(flags.ttl);
  if (status === "working" && flags.progress !== undefined) body.progress = Number(flags.progress);
  if (status === "waiting") {
    if (flags["waiting-on"]) body.waitingOn = flags["waiting-on"];
    if (flags["waiting-for"]) body.waitingFor = flags["waiting-for"];
  }
  if (status === "done") {
    if (flags.result !== undefined) body.result = flags.result;
    else if (flags["result-file"]) body.result = readFileBounded(flags["result-file"]);
    else if (flags["result-stdin"]) body.result = readStdin();
  }
  if (status === "error" && flags.error) body.error = cutUtf8(flags.error, 2048);
  return body;
}

async function main(argv) {
  if (argv[0] === "--drain") {
    try {
      await drainSpool(argv[1]);
    } catch {
      // A background worker has nobody to tell; failed jobs are in the error log.
    }
    return 0;
  }
  const strict = argv.includes("--strict");
  try {
    const { key, status, flags } = parseArgs(argv);
    // The environment beats the config file, so this picks the arena for this call.
    if (flags.arena) process.env.ARENA_SLUG = flags.arena;
    if (status === "new-key") {
      console.log(newKey(flags.tool));
    } else if (status === "check") {
      const info = await checkConfig();
      console.log(`ok: arena "${info.name}" (${info.arena}), ${info.agents} agent${info.agents === 1 ? "" : "s"}`);
      const failures = recentDeliveryErrors();
      if (failures.length) console.log(`recent background delivery failures:\n  ${failures.slice(-5).join("\n  ")}`);
    } else if (status === "register") {
      const body = {};
      if (flags.name) body.displayName = flags.name;
      if (flags.role) body.role = flags.role;
      if (flags.ttl) body.ttlSeconds = Number(flags.ttl);
      await sendProfile(key, body);
    } else if (status === "remove") {
      await sendRemove(key);
    } else if (status === "heartbeat") {
      const body = {};
      if (flags.leaving) body.leaving = true;
      if (flags.ttl) body.ttlSeconds = Number(flags.ttl);
      await sendHeartbeat(key, body);
    } else {
      const res = await sendStatus(key, buildStatusBody(status, flags));
      if (res && res.applied === false) console.error("arena-report: report arrived late and was not applied");
    }
    return 0;
  } catch (err) {
    console.error(`arena-report: ${err instanceof Error ? err.message : "failed"}`);
    return strict ? (err instanceof UsageError ? 2 : 1) : 0;
  }
}

/** True when this file is being run (directly or through a symlink), not imported. */
export function isEntryPoint(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
