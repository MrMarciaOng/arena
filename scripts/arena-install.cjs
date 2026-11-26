#!/usr/bin/env node
// Sets up this machine to report agents to an Arena. No dependencies; Node 18+.
//
// Arena serves this file at /api/connect/install.js with its own URL filled in, and each arena's
// Connect page gives the command to run, for example:
//
//   curl -fsSL https://arena.example/api/connect/install.js | ARENA_TOKEN='arena_…' node - skill --arena career
//
// `node -` reads the whole script before running any of it, so a download cut short runs nothing.
//
// Commands (one or more):
//   skill         the arena-presence skill, for Claude Code (~/.claude/skills) and Codex
//                 (~/.codex/skills), whichever is installed: the agent reports for itself
//   claude-hooks  Claude Code hooks: every session reports on its own (edits ~/.claude/settings.json)
//   codex         Codex notify: each finished turn reports (edits ~/.codex/config.toml)
//   reporter      only arena-report.mjs, for shell scripts and cron jobs
//   uninstall     removes everything this installer added, ~/.config/arena/env included
//
// With ARENA_TOKEN in the environment and --arena <slug>, it first writes ~/.config/arena/env, the
// private file every integration reads. The key is taken from the environment, never from an
// argument, where `ps` would show it. Files it edits are backed up first (<file>.arena-backup).
"use strict";
// CommonJS on purpose: `node -` runs the piped script as CommonJS on every supported Node version.
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** Filled in by Arena when it serves this file. */
const SERVED_FROM = "__ARENA_URL__";

const COMMANDS = ["skill", "claude-hooks", "codex", "reporter", "uninstall"];
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_\-.~+/=]{8,512}$/;
const HOOK_EVENTS = [
  ["SessionStart"],
  ["UserPromptSubmit"],
  ["Notification", "permission_prompt|elicitation_dialog"],
  ["Stop"],
  ["SessionEnd"],
];
const ARENA_HOOK = /arena-hook\.mjs/;
const ARENA_NOTIFY = /arena-notify\.mjs/;

class UsageError extends Error {}

const home = () => os.homedir();
const configDir = () => path.join(home(), ".config", "arena");
const binDir = () => path.join(configDir(), "bin");
const envFile = () => path.join(configDir(), "env");
const claudeSettings = () => path.join(home(), ".claude", "settings.json");
const codexConfig = () => path.join(home(), ".codex", "config.toml");
const tilde = (p) => (p.startsWith(home() + path.sep) ? `~${p.slice(home().length)}` : p);

const USAGE = `usage: node - <command>... [--arena <slug>]   (commands: ${COMMANDS.join(", ")})
  skill         the arena-presence skill for Claude Code and Codex
  claude-hooks  Claude Code hooks: every session reports on its own
  codex         Codex notify: each finished turn reports
  reporter      only arena-report.mjs, for scripts and cron jobs
  uninstall     remove everything this installer added
Set ARENA_TOKEN and pass --arena <slug> to write ~/.config/arena/env as well.`;

function parseArgs(argv) {
  const commands = [];
  let arena = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true, commands, arena };
    if (arg === "--arena") {
      arena = argv[(i += 1)];
      if (!arena) throw new UsageError("--arena needs the arena's slug");
    } else if (arg.startsWith("--arena=")) {
      arena = arg.slice("--arena=".length);
    } else if (COMMANDS.includes(arg)) {
      if (!commands.includes(arg)) commands.push(arg);
    } else {
      throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  if (arena !== null && !SLUG_RE.test(arena)) throw new UsageError(`"${arena}" is not an arena slug`);
  if (commands.length === 0) throw new UsageError("say what to install");
  if (commands.includes("uninstall") && commands.length > 1) throw new UsageError("run uninstall on its own");
  return { help: false, commands, arena };
}

function baseUrl() {
  const from = process.env.ARENA_INSTALL_FROM || (SERVED_FROM.startsWith("__") ? "" : SERVED_FROM);
  if (!/^https?:\/\/[^\s/]+/.test(from)) {
    throw new UsageError("run the command from your arena's Connect page (or set ARENA_INSTALL_FROM to Arena's URL)");
  }
  return from.replace(/\/+$/, "");
}

/** Single-quotes a path for the shell Claude Code runs hook commands with, when it needs quoting. */
function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** The file a path really names, so a settings file linked from a dotfiles folder stays a link. */
function realFile(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function backUp(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.arena-backup`);
}

function modeOf(file, fallback) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function makeDownloader(base) {
  const cache = new Map();
  return async (name) => {
    if (cache.has(name)) return cache.get(name);
    let res;
    try {
      res = await fetch(`${base}/api/connect/${name}`, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error(`couldn't reach ${base} to download ${name}`);
    }
    if (!res.ok) throw new Error(`couldn't download ${name} from ${base} (HTTP ${res.status})`);
    const text = await res.text();
    cache.set(name, text);
    return text;
  };
}

// ---- ~/.config/arena/env -------------------------------------------------------------------------

function writeConfig(url, slug, token) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const text = `# Written by Arena's installer. Every Arena integration on this machine reads it. Keep it private.\nARENA_URL=${url}\nARENA_SLUG=${slug}\nARENA_TOKEN=${token}\n`;
  writeAtomic(envFile(), text, 0o600);
}

// ---- Claude Code settings ------------------------------------------------------------------------

function readJsonObject(file) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${tilde(file)} isn't valid JSON, so it was left alone. Fix it, then run this again`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${tilde(file)} doesn't hold a JSON object, so it was left alone`);
  }
  return parsed;
}

/** The settings without any Arena hook; other hooks, matchers and settings stay as they were. */
function withoutArenaHooks(settings) {
  const hooks = settings.hooks;
  if (hooks === undefined) return { settings, removed: 0 };
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`"hooks" in ${tilde(claudeSettings())} isn't an object, so it was left alone`);
  }
  let removed = 0;
  const next = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const others = group.hooks.filter((h) => !(typeof h?.command === "string" && ARENA_HOOK.test(h.command)));
      removed += group.hooks.length - others.length;
      if (others.length > 0) kept.push({ ...group, hooks: others });
      else if (group.hooks.length === 0) kept.push(group);
    }
    if (kept.length > 0) next[event] = kept;
  }
  return { settings: { ...settings, hooks: next }, removed };
}

function installClaudeHooks(hookPath) {
  const file = realFile(claudeSettings());
  const { settings } = withoutArenaHooks(readJsonObject(file));
  const command = `node ${shellQuote(hookPath)}`;
  const hooks = { ...settings.hooks };
  for (const [event, matcher] of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`"hooks.${event}" in ${tilde(file)} isn't a list, so the file was left alone`);
    }
    const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  backUp(file);
  writeAtomic(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, modeOf(file, 0o644));
}

function removeClaudeHooks() {
  const file = realFile(claudeSettings());
  if (!fs.existsSync(file)) return false;
  const { settings, removed } = withoutArenaHooks(readJsonObject(file));
  if (removed === 0) return false;
  backUp(file);
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, modeOf(file, 0o644));
  return true;
}

// ---- Codex config --------------------------------------------------------------------------------

/** Where the top-level keys end: the first table header, or the end of the file. */
function codexTopLevel(lines) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const notify = lines.slice(0, end).findIndex((line) => /^\s*notify\s*=/.test(line));
  return { end, notify };
}

const notifyLine = (notifyPath) => `notify = ["node", ${JSON.stringify(notifyPath)}]`;

function installCodexNotify(notifyPath) {
  const file = realFile(codexConfig());
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  const { end, notify } = codexTopLevel(lines);
  const line = notifyLine(notifyPath);
  if (notify !== -1) {
    const current = lines[notify];
    if (!ARENA_NOTIFY.test(current) || !/\]\s*(#.*)?$/.test(current)) {
      throw new Error(
        `${tilde(file)} already runs a notify program, and Codex runs only one. Replace its notify line with:\n  ${line}`,
      );
    }
    lines[notify] = line;
  } else if (end === lines.length) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  } else {
    lines.splice(end, 0, line, "");
  }
  backUp(file);
  writeAtomic(file, lines.join("\n"), modeOf(file, 0o644));
}

function removeCodexNotify() {
  const file = realFile(codexConfig());
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const { notify } = codexTopLevel(lines);
  if (notify === -1 || !ARENA_NOTIFY.test(lines[notify])) return false;
  backUp(file);
  // Also drop the blank line added after it, but not the file's final newline.
  lines.splice(notify, lines[notify + 1] === "" && notify + 1 < lines.length - 1 ? 2 : 1);
  writeAtomic(file, lines.join("\n"), modeOf(file, 0o644));
  return true;
}

// ---- Files ---------------------------------------------------------------------------------------

/** Claude Code's and Codex's skill folders, for whichever of them is installed (Claude Code if neither). */
function skillDirs() {
  const dirs = [".claude", ".codex"]
    .filter((tool) => fs.existsSync(path.join(home(), tool)))
    .map((tool) => path.join(home(), tool, "skills", "arena-presence"));
  return dirs.length > 0 ? dirs : [path.join(home(), ".claude", "skills", "arena-presence")];
}

/** A skill folder this installer wrote (not a link to a checkout, not someone else's skill). */
function isInstalledSkill(dir) {
  if (isLink(dir)) return false;
  try {
    return /^name:\s*arena-presence\s*$/m.test(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}

async function installSkill(download, done) {
  for (const dir of skillDirs()) {
    if (isLink(dir)) {
      done.push(`kept ${tilde(dir)}: it links to a copy of Arena, which updates it`);
      continue;
    }
    writeAtomic(path.join(dir, "SKILL.md"), await download("SKILL.md"), 0o644);
    writeAtomic(path.join(dir, "references", "setup.md"), await download("setup.md"), 0o644);
    writeAtomic(path.join(dir, "scripts", "arena-report.mjs"), await download("arena-report.mjs"), 0o755);
    done.push(`installed the arena-presence skill in ${tilde(dir)}`);
  }
}

async function installBin(download, name) {
  const file = path.join(binDir(), name);
  writeAtomic(file, await download(name), 0o755);
  return file;
}

/** Removes what it can; a step that fails (say, an unreadable settings file) doesn't stop the rest. */
function uninstall(done, problems) {
  const attempt = (step) => {
    try {
      step();
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  };
  attempt(() => removeClaudeHooks() && done.push(`removed Arena's hooks from ${tilde(claudeSettings())}`));
  attempt(() => removeCodexNotify() && done.push(`removed Arena's notify from ${tilde(codexConfig())}`));
  for (const dir of [path.join(home(), ".claude", "skills", "arena-presence"), path.join(home(), ".codex", "skills", "arena-presence")]) {
    if (isInstalledSkill(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      done.push(`removed ${tilde(dir)}`);
    }
  }
  for (const name of ["arena-report.mjs", "arena-hook.mjs", "arena-notify.mjs"]) {
    const file = path.join(binDir(), name);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      done.push(`removed ${tilde(file)}`);
    }
  }
  if (fs.existsSync(envFile())) {
    fs.rmSync(envFile());
    done.push(`removed ${tilde(envFile())}`);
  }
  for (const dir of [binDir(), configDir()]) {
    try {
      fs.rmdirSync(dir); // only when empty
    } catch {
      // not empty or not there
    }
  }
}

/** Runs the reporter's own `check` against the config file alone (not this command's environment). */
function check(reporter) {
  const env = { ...process.env };
  for (const k of ["ARENA_URL", "ARENA_TOKEN", "ARENA_SLUG", "ARENA_CONFIG"]) delete env[k];
  const run = spawnSync(process.execPath, [reporter, "check", "--strict"], { env, encoding: "utf8", timeout: 20_000 });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  return { ok: run.status === 0, message: out || "no answer from the reporter" };
}

async function main(argv) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error(`needs Node.js 18 or newer; this is ${process.version}`);
  const { help, commands, arena } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const done = [];
  if (commands[0] === "uninstall") {
    const problems = [];
    uninstall(done, problems);
    console.log(done.length > 0 ? done.map((d) => `- ${d}`).join("\n") : "Nothing of Arena's was installed here.");
    for (const problem of problems) console.error(`arena install: ${problem}`);
    return problems.length > 0 ? 1 : 0;
  }

  const base = baseUrl();
  const download = makeDownloader(base);
  const token = process.env.ARENA_TOKEN;
  if (token !== undefined || arena !== null) {
    if (!token || arena === null) throw new UsageError("to save the arena's details, set ARENA_TOKEN and pass --arena <slug> together");
    if (!TOKEN_RE.test(token)) throw new UsageError("ARENA_TOKEN doesn't look like an Arena key");
    writeConfig(base, arena, token);
    done.push(`saved arena "${arena}" and its key in ${tilde(envFile())} (only you can read it)`);
  }

  let reporter = null;
  const restart = [];
  if (commands.includes("skill")) {
    await installSkill(download, done);
    reporter ??= path.join(skillDirs()[0], "scripts", "arena-report.mjs");
    restart.push("Start a new Claude Code (or Codex) session to load the skill. Ask it to check in to Arena, or it will once it starts working.");
  }
  if (commands.includes("claude-hooks")) {
    reporter = await installBin(download, "arena-report.mjs");
    const hook = await installBin(download, "arena-hook.mjs");
    installClaudeHooks(hook);
    done.push(`added Arena's hooks to ${tilde(claudeSettings())} (backup: settings.json.arena-backup)`);
    restart.push("New Claude Code sessions report on their own; restart the ones already open.");
  }
  if (commands.includes("codex")) {
    reporter = await installBin(download, "arena-report.mjs");
    const notify = await installBin(download, "arena-notify.mjs");
    installCodexNotify(notify);
    done.push(`set Codex's notify in ${tilde(codexConfig())} (backup: config.toml.arena-backup)`);
    restart.push("Restart Codex; each finished turn then reports to Arena.");
  }
  if (commands.includes("reporter")) {
    reporter = await installBin(download, "arena-report.mjs");
    done.push(`installed ${tilde(reporter)}`);
    restart.push(`Report from any script: node ${shellQuote(tilde(reporter))} my-job working --activity "Starting"`);
  }
  if (commands.some((c) => c === "claude-hooks" || c === "codex")) {
    done.push(`installed the reporter in ${tilde(binDir())}`);
  }

  console.log(done.map((d) => `- ${d}`).join("\n"));
  if (!fs.existsSync(envFile())) {
    console.log(`\nNo ${tilde(envFile())} yet, so nothing can report. Copy the command from your arena's Connect page, which fills it in.`);
    return 1;
  }
  const result = check(reporter);
  if (!result.ok) {
    console.log(`\nInstalled, but Arena didn't accept the saved details:\n  ${result.message}\nCopy a fresh command from your arena's Connect page.`);
    return 1;
  }
  console.log(`\n${result.message}\n${restart.map((r) => `-> ${r}`).join("\n")}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`arena install: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof UsageError) console.error(USAGE);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
