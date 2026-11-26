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
// With ARENA_TOKEN in the environment and --arena <slug>, it saves ~/.config/arena/env, the private
// file every integration on this machine reads, once Arena has accepted the key. The key comes from
// the environment, never from an argument, where `ps` would show it.
//
// It checks everything that could stop it (the key, the files it edits) and downloads what it needs
// before it changes anything. The first time it edits a file it keeps a copy (<file>.arena-backup);
// uninstall puts the copy back when nothing else in the file has changed since. Like Claude Code and
// Codex, it honours CLAUDE_CONFIG_DIR and CODEX_HOME.
"use strict";

// Before anything newer Node would be needed for (the `node:` imports below need 14.18 or 16).
if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error("arena install: needs Node.js 18 or newer; this is " + process.version);
  process.exit(1);
}

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

/** What has been changed so far; printed even when a later step fails. */
const done = [];

const home = () => os.homedir();
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
const codexHome = () => process.env.CODEX_HOME || path.join(home(), ".codex");
const configDir = () => path.join(home(), ".config", "arena");
const binDir = () => path.join(configDir(), "bin");
const envFile = () => path.join(configDir(), "env");
const claudeSettings = () => path.join(claudeHome(), "settings.json");
const codexConfig = () => path.join(codexHome(), "config.toml");
const backupOf = (file) => `${file}.arena-backup`;
const tilde = (p) => (p.startsWith(home() + path.sep) ? `~${p.slice(home().length)}` : p);
const list = (items) => items.map((item) => `- ${item}`).join("\n");

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

/**
 * The file a path really names, following links (even one to a file that isn't there yet), so a
 * settings file linked from a dotfiles folder stays a link.
 */
function realFile(file) {
  let current = file;
  for (let hops = 0; hops < 32; hops += 1) {
    let target;
    try {
      target = fs.readlinkSync(current);
    } catch {
      return current; // not a link, or not there
    }
    let dir = path.dirname(current);
    try {
      dir = fs.realpathSync(dir);
    } catch {
      // keep the path as written
    }
    current = path.resolve(dir, target);
  }
  return current;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
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
      throw new Error(`couldn't reach ${base} to download ${name}, so nothing was changed`);
    }
    if (!res.ok) throw new Error(`couldn't download ${name} from ${base} (HTTP ${res.status}), so nothing was changed`);
    const text = await res.text();
    cache.set(name, text);
    return text;
  };
}

/**
 * A planned edit is written first-copy-kept: the file as it was before Arena touched it is saved
 * once, and a later run (when Arena's lines are already in it) leaves that copy alone.
 */
function applyEdit(edit) {
  let backup = null;
  if (edit.existed && !edit.hadArena) {
    backup = backupOf(edit.file);
    fs.copyFileSync(edit.file, backup);
  }
  writeAtomic(edit.file, edit.text, modeOf(edit.file, 0o644));
  return backup;
}

/**
 * After Arena's lines are taken out: puts back the copy kept at install when the file matches it
 * (so its formatting comes back too), or writes the cleaned file and keeps the copy, saying so.
 */
function settle(file, cleaned, matchesCopy) {
  const backup = backupOf(file);
  const original = readText(backup);
  if (original !== null && matchesCopy(original)) {
    writeAtomic(file, original, modeOf(file, 0o644));
    fs.rmSync(backup);
    return;
  }
  writeAtomic(file, cleaned, modeOf(file, 0o644));
  if (original !== null) {
    done.push(`kept ${tilde(backup)}, the file as it was before Arena (it has changed since); delete it if you don't need it`);
  }
}

// ---- ~/.config/arena/env -------------------------------------------------------------------------

/** Asks Arena whether the key opens this arena, before anything is saved. */
async function verifyDetails(base, slug, token) {
  let res;
  try {
    res = await fetch(`${base}/api/arenas/${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`couldn't reach ${base}, so nothing was changed. Check the connection and run it again`);
  }
  if (res.ok) return;
  const why =
    res.status === 401
      ? "Arena didn't accept the key (it may have been revoked)"
      : res.status === 403 || res.status === 404
        ? `the key doesn't open arena "${slug}"`
        : "Arena couldn't check the key";
  throw new Error(`${why} (HTTP ${res.status}), so nothing was changed. Copy a fresh command from your arena's Connect page`);
}

function savedDetails() {
  const text = readText(envFile());
  if (text === null) return null;
  const values = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?(ARENA_URL|ARENA_SLUG|ARENA_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function saveDetails(url, slug, token) {
  const before = savedDetails();
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const text = `# Written by Arena's installer. Every Arena integration on this machine reads it. Keep it private.\nARENA_URL=${url}\nARENA_SLUG=${slug}\nARENA_TOKEN=${token}\n`;
  writeAtomic(envFile(), text, 0o600);
  const where = tilde(envFile());
  if (before && before.ARENA_SLUG && (before.ARENA_SLUG !== slug || before.ARENA_URL !== url)) {
    const old = before.ARENA_URL === url ? `"${before.ARENA_SLUG}"` : `"${before.ARENA_SLUG}" at ${before.ARENA_URL}`;
    done.push(`saved arena "${slug}" in ${where} in place of ${old}: everything of Arena's on this machine now reports to "${slug}"`);
  } else if (before && before.ARENA_TOKEN && before.ARENA_TOKEN !== token) {
    done.push(`saved the new key for arena "${slug}" in ${where} in place of the old one: everything of Arena's on this machine now uses it`);
  } else {
    done.push(`saved arena "${slug}" and its key in ${where} (only you can read it)`);
  }
}

// ---- Claude Code settings ------------------------------------------------------------------------

function parseJsonObject(file, text) {
  if (text === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${tilde(file)} isn't valid JSON, so nothing was changed. Fix it, then run this again`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${tilde(file)} doesn't hold a JSON object, so nothing was changed`);
  }
  return parsed;
}

/** The settings without any Arena hook; other hooks, matchers and settings stay as they were. */
function withoutArenaHooks(settings, file) {
  const hooks = settings.hooks;
  if (hooks === undefined) return { settings, removed: 0 };
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`"hooks" in ${tilde(file)} isn't an object, so nothing was changed`);
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

/** An empty "hooks" means the same as none; dropped so a file Arena added hooks to can match its copy. */
function withoutEmptyHooks(settings) {
  const { hooks, ...rest } = settings;
  return hooks && typeof hooks === "object" && Object.keys(hooks).length === 0 ? rest : settings;
}

function planClaudeHooks(hookPath) {
  const file = realFile(claudeSettings());
  const text = readText(file);
  const { settings, removed } = withoutArenaHooks(parseJsonObject(file, text), file);
  const command = `node ${shellQuote(hookPath)}`;
  const hooks = { ...settings.hooks };
  for (const [event, matcher] of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`"hooks.${event}" in ${tilde(file)} isn't a list, so nothing was changed`);
    }
    const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  return { file, text: `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, existed: text !== null, hadArena: removed > 0 };
}

function removeClaudeHooks() {
  const file = realFile(claudeSettings());
  const text = readText(file);
  if (text === null) return;
  const { settings, removed } = withoutArenaHooks(parseJsonObject(file, text), file);
  if (removed === 0) return;
  const cleaned = withoutEmptyHooks(settings);
  const same = (original) => {
    try {
      return JSON.stringify(withoutEmptyHooks(withoutArenaHooks(JSON.parse(original), file).settings)) === JSON.stringify(cleaned);
    } catch {
      return false;
    }
  };
  settle(file, `${JSON.stringify(cleaned, null, 2)}\n`, same);
  done.push(`removed Arena's hooks from ${tilde(claudeSettings())}`);
}

// ---- Codex config --------------------------------------------------------------------------------

const TABLE_HEADER = /^\s*\[\[?[^[\],=]+\]\]?\s*(#.*)?$/;
const NOTIFY_KEY = /^\s*(?:notify|"notify"|'notify')\s*=/;
const BOM = "﻿";

/** The top-level notify line, if there is one: top-level keys come before the first table. */
function findNotify(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (TABLE_HEADER.test(lines[i])) return -1;
    if (NOTIFY_KEY.test(lines[i])) return i;
  }
  return -1;
}

const notifyLine = (notifyPath) => `notify = ["node", ${JSON.stringify(notifyPath)}]`;

function splitToml(text) {
  const bom = text.startsWith(BOM) ? BOM : "";
  return { bom, lines: text.slice(bom.length).split("\n") };
}

function planCodexNotify(notifyPath) {
  if (!fs.existsSync(codexHome())) {
    throw new Error(`Codex isn't set up on this machine (there's no ${tilde(codexHome())}), so nothing was changed. Run Codex once, then run this again`);
  }
  const file = realFile(codexConfig());
  const text = readText(file);
  const { bom, lines } = splitToml(text ?? "");
  const at = findNotify(lines);
  const line = notifyLine(notifyPath);
  if (at !== -1) {
    const current = lines[at];
    if (!ARENA_NOTIFY.test(current) || !/\]\s*(#.*)?$/.test(current)) {
      throw new Error(
        `${tilde(file)} already runs a notify program, and Codex runs only one, so nothing was changed. Replace its notify line with:\n  ${line}`,
      );
    }
    lines[at] = line;
  } else if (lines.length === 1 && lines[0] === "") {
    lines.splice(0, 1, line, "");
  } else {
    // At the very top, where a key is top-level whatever the rest of the file holds.
    lines.unshift(line, "");
  }
  return { file, text: bom + lines.join("\n"), existed: text !== null, hadArena: at !== -1 };
}

function removeCodexNotify() {
  const file = realFile(codexConfig());
  const text = readText(file);
  if (text === null) return;
  const { bom, lines } = splitToml(text);
  const at = findNotify(lines);
  if (at === -1 || !ARENA_NOTIFY.test(lines[at])) return;
  // Also drop the blank line added after it, but not the file's final newline.
  lines.splice(at, lines[at + 1] === "" && at + 1 < lines.length - 1 ? 2 : 1);
  const cleaned = bom + lines.join("\n");
  settle(file, cleaned, (original) => original === cleaned);
  done.push(`removed Arena's notify from ${tilde(codexConfig())}`);
}

// ---- Files ---------------------------------------------------------------------------------------

/** Claude Code's and Codex's skill folders, for whichever of them is installed (Claude Code if neither). */
function skillDirs() {
  const dirs = [claudeHome(), codexHome()]
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.join(dir, "skills", "arena-presence"));
  return dirs.length > 0 ? dirs : [path.join(claudeHome(), "skills", "arena-presence")];
}

/** A skill folder this installer wrote (not a link to a checkout, not someone else's skill). */
function isInstalledSkill(dir) {
  if (isLink(dir)) return false;
  return /^name:\s*arena-presence\s*$/m.test(readText(path.join(dir, "SKILL.md")) ?? "");
}

async function installSkill(download) {
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
function uninstall(problems) {
  const attempt = (step) => {
    try {
      step();
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  };
  attempt(removeClaudeHooks);
  attempt(removeCodexNotify);
  for (const dir of [claudeHome(), codexHome()].map((d) => path.join(d, "skills", "arena-presence"))) {
    attempt(() => {
      if (!isInstalledSkill(dir)) return;
      fs.rmSync(dir, { recursive: true, force: true });
      done.push(`removed ${tilde(dir)}`);
    });
  }
  for (const file of ["arena-report.mjs", "arena-hook.mjs", "arena-notify.mjs"].map((n) => path.join(binDir(), n)).concat(envFile())) {
    attempt(() => {
      if (!fs.existsSync(file)) return;
      fs.rmSync(file);
      done.push(`removed ${tilde(file)}`);
    });
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
  const { help, commands, arena } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (commands[0] === "uninstall") {
    const problems = [];
    uninstall(problems);
    console.log(done.length > 0 ? list(done) : "Nothing of Arena's was installed here.");
    for (const problem of problems) console.error(`arena install: ${problem}`);
    return problems.length > 0 ? 1 : 0;
  }

  const base = baseUrl();
  const token = process.env.ARENA_TOKEN;
  const saving = token !== undefined || arena !== null;
  if (saving) {
    if (!token || arena === null) throw new UsageError("to save the arena's details, set ARENA_TOKEN and pass --arena <slug> together");
    if (!TOKEN_RE.test(token)) throw new UsageError("ARENA_TOKEN doesn't look like an Arena key");
  }
  const want = (command) => commands.includes(command);

  // First everything that could stop it, and every download, so that stopping changes nothing.
  const claudeEdit = want("claude-hooks") ? planClaudeHooks(path.join(binDir(), "arena-hook.mjs")) : null;
  const codexEdit = want("codex") ? planCodexNotify(path.join(binDir(), "arena-notify.mjs")) : null;
  if (saving) await verifyDetails(base, arena, token);
  const download = makeDownloader(base);
  const needed = new Set();
  if (want("skill")) ["SKILL.md", "setup.md", "arena-report.mjs"].forEach((name) => needed.add(name));
  if (want("claude-hooks")) ["arena-report.mjs", "arena-hook.mjs"].forEach((name) => needed.add(name));
  if (want("codex")) ["arena-report.mjs", "arena-notify.mjs"].forEach((name) => needed.add(name));
  if (want("reporter")) needed.add("arena-report.mjs");
  for (const name of needed) await download(name);

  // Then the changes.
  if (saving) saveDetails(base, arena, token);
  let reporter = null;
  const next = [];
  if (want("skill")) {
    await installSkill(download);
    reporter = path.join(skillDirs()[0], "scripts", "arena-report.mjs");
    next.push("Start a new Claude Code (or Codex) session to load the skill. Ask it to check in to Arena, or it will once it starts working.");
  }
  if (want("claude-hooks") || want("codex") || want("reporter")) {
    reporter = await installBin(download, "arena-report.mjs");
    done.push(`installed the reporter in ${tilde(binDir())}`);
  }
  if (claudeEdit) {
    await installBin(download, "arena-hook.mjs");
    const backup = applyEdit(claudeEdit);
    done.push(`added Arena's hooks to ${tilde(claudeSettings())}${backup ? ` (a copy of it as it was: ${tilde(backup)})` : ""}`);
    next.push("New Claude Code sessions report on their own; restart the ones already open.");
  }
  if (codexEdit) {
    await installBin(download, "arena-notify.mjs");
    const backup = applyEdit(codexEdit);
    done.push(`set Codex's notify in ${tilde(codexConfig())}${backup ? ` (a copy of it as it was: ${tilde(backup)})` : ""}`);
    next.push("Restart Codex; each finished turn then reports to Arena.");
  }
  if (want("reporter")) {
    next.push(`Report from any script: node ${shellQuote(tilde(reporter))} my-job working --activity "Starting"`);
  }

  console.log(list(done));
  if (!fs.existsSync(envFile())) {
    console.log(`\nNo ${tilde(envFile())} yet, so nothing can report. Copy the command from your arena's Connect page, which fills it in.`);
    return 1;
  }
  const result = check(reporter);
  if (!result.ok) {
    console.log(`\nInstalled, but Arena didn't accept the saved details:\n  ${result.message}\nCopy a fresh command from your arena's Connect page.`);
    return 1;
  }
  console.log(`\n${result.message}\n${next.map((line) => `-> ${line}`).join("\n")}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (done.length > 0) console.log(`Changed before it stopped:\n${list(done)}\n`);
    console.error(`arena install: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof UsageError) console.error(USAGE);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
