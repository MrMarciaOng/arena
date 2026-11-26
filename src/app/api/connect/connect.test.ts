import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import * as agentRoute from "@/app/api/arenas/[slug]/agents/[key]/route";
import * as heartbeatRoute from "@/app/api/arenas/[slug]/agents/[key]/heartbeat/route";
import * as statusRoute from "@/app/api/arenas/[slug]/agents/[key]/status/route";
import * as arenaRoute from "@/app/api/arenas/[slug]/route";
import { createArena } from "@/server/arenas";
import { agents } from "@/server/db/schema";
import { rows } from "../../../../test/helpers";
import { GET } from "./[file]/route";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const repo = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), "utf8");

async function serve(file: string, origin = "http://arena.test") {
  return GET(new Request(`${origin}/api/connect/${file}`), { params: Promise.resolve({ file }) });
}

describe("GET /api/connect/:file", () => {
  it("serves each file as plain text that a browser won't run", async () => {
    const expected: Record<string, string> = {
      "arena-report.mjs": repo("scripts", "arena-report.mjs"),
      "SKILL.md": repo("skills", "arena-presence", "SKILL.md"),
      "setup.md": repo("skills", "arena-presence", "references", "setup.md"),
    };
    for (const [file, text] of Object.entries(expected)) {
      const res = await serve(file);
      expect(res.status, file).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(text);
    }
  });

  it("fills in this Arena's URL in the installer", async () => {
    const text = await (await serve("install.js", "https://arena.example")).text();
    expect(text).toContain(`const SERVED_FROM = "https://arena.example";`);
    expect(text).not.toContain("__ARENA_URL__");
  });

  it("points the hook and notify scripts at the reporter installed beside them", async () => {
    for (const [file, source] of [
      ["arena-hook.mjs", ["examples", "claude-code-hooks", "arena-hook.mjs"]],
      ["arena-notify.mjs", ["examples", "codex-notify", "arena-notify.mjs"]],
    ] as const) {
      const text = await (await serve(file)).text();
      expect(text).toContain(`from "./arena-report.mjs"`);
      expect(text).not.toContain("../../scripts/arena-report.mjs");
      expect(text.replace(`from "./arena-report.mjs"`, `from "../../scripts/arena-report.mjs"`)).toBe(repo(...source));
    }
  });

  it("serves nothing else", async () => {
    for (const file of ["nope", "package.json", "../package.json", "..%2Fpackage.json", "constructor", "__proto__", "toString", "SKILL.MD"]) {
      const res = await serve(file);
      expect(res.status, file).toBe(404);
    }
  });
});

// ---- The installer, end to end: Arena on a local port, a throwaway home folder ---------------------

async function bodyOf(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Routes requests to the real handlers, so the installed scripts talk to the real API. */
async function dispatch(request: Request): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[1] === "connect" && parts.length === 3) return GET(request, { params: Promise.resolve({ file: parts[2] }) });
  if (parts[1] !== "arenas") return new Response("not found", { status: 404 });
  const [, , slug, , key, action] = parts;
  if (parts.length === 3 && request.method === "GET") return arenaRoute.GET(request, { params: Promise.resolve({ slug }) });
  const ctx = { params: Promise.resolve({ slug, key }) };
  if (action === "status") return statusRoute.POST(request, ctx);
  if (action === "heartbeat") return heartbeatRoute.POST(request, ctx);
  const handler = { GET: agentRoute.GET, PUT: agentRoute.PUT, DELETE: agentRoute.DELETE }[request.method ?? ""];
  return handler ? handler(request, ctx) : new Response("not found", { status: 404 });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      const body = await bodyOf(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const response = await dispatch(new Request(`${base}${req.url}`, { method: req.method, headers, body: body && new Uint8Array(body) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Run = { code: number | null; out: string; err: string };

/** Runs a command without blocking this process, which is also serving Arena. */
function run(command: string, args: string[], env: Record<string, string>, input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "arena-home-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function installer(): Promise<string> {
  return (await (await fetch(`${base}/api/connect/install.js`)).text());
}

/** `node - <args>` with the installer on stdin, as `curl … | node -` runs it. */
async function install(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return run(process.execPath, ["-", ...args], { HOME: home, ARENA_SPOOL_DIR: path.join(home, ".spool"), ...extraEnv }, await installer());
}

const read = (file: string) => readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(read(file));
const hasCurl = spawnSync("curl", ["--version"]).status === 0;

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("the installer", () => {
  it.skipIf(!hasCurl)("curl | node - installs the skill, the hooks and Codex's notify, and they report", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const home = tempHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const settingsFile = path.join(home, ".claude", "settings.json");
    const codexFile = path.join(home, ".codex", "config.toml");
    writeFileSync(
      settingsFile,
      JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2),
    );
    writeFileSync(codexFile, 'model = "o3"\n\n[tui]\nnotifications = true\n');

    const result = await run(
      "sh",
      ["-c", `curl -fsSL ${base}/api/connect/install.js | node - skill claude-hooks codex --arena career`],
      { HOME: home, ARENA_TOKEN: apiKey.token, ARENA_SPOOL_DIR: path.join(home, ".spool") },
    );
    expect(result.err).toBe("");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('ok: arena "Career" (career)');
    expect(`${result.out}${result.err}`).not.toContain(apiKey.token);

    // The private config every integration reads.
    const envFile = path.join(home, ".config", "arena", "env");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(read(envFile)).toContain(`ARENA_URL=${base}\nARENA_SLUG=career\nARENA_TOKEN=${apiKey.token}\n`);

    // The skill, for both tools.
    for (const tool of [".claude", ".codex"]) {
      const dir = path.join(home, tool, "skills", "arena-presence");
      expect(read(path.join(dir, "SKILL.md"))).toBe(repo("skills", "arena-presence", "SKILL.md"));
      expect(existsSync(path.join(dir, "references", "setup.md"))).toBe(true);
      expect(statSync(path.join(dir, "scripts", "arena-report.mjs")).mode & 0o111).not.toBe(0);
    }

    // Claude Code: the other settings and hooks stay, each event gets one Arena hook.
    const hookPath = path.join(home, ".config", "arena", "bin", "arena-hook.mjs");
    const checkSettings = () => {
      const settings = readJson(settingsFile);
      expect(settings.model).toBe("opus");
      expect(settings.hooks.Stop[0]).toEqual({ hooks: [{ type: "command", command: "say done" }] });
      for (const event of ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"]) {
        const arenaHooks = settings.hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks).filter((h: { command: string }) => h.command.includes("arena-hook.mjs"));
        expect(arenaHooks, event).toEqual([{ type: "command", command: `node ${hookPath}` }]);
      }
      expect(settings.hooks.Notification.at(-1).matcher).toBe("permission_prompt|elicitation_dialog");
    };
    checkSettings();
    expect(existsSync(`${settingsFile}.arena-backup`)).toBe(true);

    // Codex: notify goes in with the top-level keys, above the first table.
    const notifyPath = path.join(home, ".config", "arena", "bin", "arena-notify.mjs");
    const expectedToml = `model = "o3"\n\nnotify = ["node", ${JSON.stringify(notifyPath)}]\n\n[tui]\nnotifications = true\n`;
    expect(read(codexFile)).toBe(expectedToml);

    // Running it again changes nothing.
    const again = await install(home, ["skill", "claude-hooks", "codex"]);
    expect(again.code, again.out + again.err).toBe(0);
    checkSettings();
    expect(read(codexFile)).toBe(expectedToml);

    // The installed hook really reports (it imports the reporter installed beside it).
    const sessionStart = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-1", cwd: "/work/arena" });
    const hook = await run(process.execPath, [hookPath], { HOME: home, ARENA_SPOOL_DIR: path.join(home, ".spool") }, sessionStart);
    expect(hook.code, hook.err).toBe(0);
    const claudeAgent = await waitFor(async () => (await rows(agents)).find((a) => a.displayName === "Claude · arena"));
    expect(claudeAgent.key).toMatch(/^claude-[0-9a-f]{12}$/);

    // So does Codex's notify.
    const turn = JSON.stringify({ type: "agent-turn-complete", "thread-id": "t-1", "last-assistant-message": "All done", cwd: "/work/arena" });
    const notify = await run(process.execPath, [notifyPath, turn], { HOME: home, ARENA_SPOOL_DIR: path.join(home, ".spool") });
    expect(notify.code, notify.err).toBe(0);
    const codexAgent = await waitFor(async () => (await rows(agents)).find((a) => a.displayName === "Codex · arena"));
    expect(codexAgent.status).toBe("done");

    // Uninstall takes it all back out and leaves everything else.
    const removed = await install(home, ["uninstall"]);
    expect(removed.code, removed.err).toBe(0);
    const settings = readJson(settingsFile);
    expect(settings.model).toBe("opus");
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    expect(read(codexFile)).toBe('model = "o3"\n\n[tui]\nnotifications = true\n');
    expect(existsSync(path.join(home, ".claude", "skills", "arena-presence"))).toBe(false);
    expect(existsSync(path.join(home, ".codex", "skills", "arena-presence"))).toBe(false);
    expect(existsSync(path.join(home, ".config", "arena"))).toBe(false);
  });

  it("installs the skill for Claude Code only when Codex isn't installed, and keeps a linked checkout", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const home = tempHome();
    const result = await install(home, ["skill", "--arena", "career"], { ARENA_TOKEN: apiKey.token });
    expect(result.code, result.out + result.err).toBe(0);
    expect(existsSync(path.join(home, ".claude", "skills", "arena-presence", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".codex"))).toBe(false);

    const linked = tempHome();
    mkdirSync(path.join(linked, ".claude", "skills"), { recursive: true });
    symlinkSync(path.join(process.cwd(), "skills", "arena-presence"), path.join(linked, ".claude", "skills", "arena-presence"));
    const kept = await install(linked, ["skill", "--arena", "career"], { ARENA_TOKEN: apiKey.token });
    expect(kept.code, kept.out + kept.err).toBe(0);
    expect(kept.out).toContain("links to a copy of Arena");
    expect(lstatSync(path.join(linked, ".claude", "skills", "arena-presence")).isSymbolicLink()).toBe(true);
  });

  it("leaves a settings file it can't read untouched", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const home = tempHome();
    mkdirSync(path.join(home, ".claude"));
    const settingsFile = path.join(home, ".claude", "settings.json");
    writeFileSync(settingsFile, "{ not json");
    const result = await install(home, ["claude-hooks", "--arena", "career"], { ARENA_TOKEN: apiKey.token });
    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't valid JSON, so it was left alone");
    expect(read(settingsFile)).toBe("{ not json");
  });

  it("keeps linked settings files linked, and gives a file back exactly as it was", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const home = tempHome();
    const dotfiles = path.join(home, "dotfiles");
    mkdirSync(dotfiles);
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(dotfiles, "settings.json"), '{ "model": "opus" }\n');
    writeFileSync(path.join(dotfiles, "config.toml"), 'model = "o3"\n');
    symlinkSync(path.join(dotfiles, "settings.json"), path.join(home, ".claude", "settings.json"));
    symlinkSync(path.join(dotfiles, "config.toml"), path.join(home, ".codex", "config.toml"));

    const result = await install(home, ["claude-hooks", "codex", "--arena", "career"], { ARENA_TOKEN: apiKey.token });
    expect(result.code, result.out + result.err).toBe(0);
    expect(lstatSync(path.join(home, ".claude", "settings.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(home, ".codex", "config.toml")).isSymbolicLink()).toBe(true);
    expect(readJson(path.join(dotfiles, "settings.json")).hooks.Stop).toHaveLength(1);
    expect(read(path.join(dotfiles, "config.toml"))).toContain("arena-notify.mjs");

    const removed = await install(home, ["uninstall"]);
    expect(removed.code, removed.err).toBe(0);
    expect(read(path.join(dotfiles, "config.toml"))).toBe('model = "o3"\n');
    expect(readJson(path.join(dotfiles, "settings.json"))).toEqual({ model: "opus", hooks: {} });
  });

  it("uninstall carries on past a settings file it can't read, and says so", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json");
    mkdirSync(path.join(home, ".config", "arena"), { recursive: true });
    writeFileSync(path.join(home, ".config", "arena", "env"), "ARENA_URL=http://x\n");
    const result = await install(home, ["uninstall"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't valid JSON");
    expect(existsSync(path.join(home, ".config", "arena"))).toBe(false);
  });

  it("won't replace another notify program in Codex", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const codexFile = path.join(home, ".codex", "config.toml");
    writeFileSync(codexFile, 'notify = ["say", "done"]\n');
    const result = await install(home, ["codex", "--arena", "career"], { ARENA_TOKEN: apiKey.token });
    expect(result.code).toBe(1);
    expect(result.err).toContain("already runs a notify program");
    expect(read(codexFile)).toBe('notify = ["say", "done"]\n');
  });

  it("says when the key is wrong, and never prints it", async () => {
    await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const home = tempHome();
    const token = "arena_not-a-real-key-0123456789";
    const result = await install(home, ["reporter", "--arena", "career"], { ARENA_TOKEN: token });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Arena didn't accept the saved details");
    expect(result.out).toContain("HTTP 401");
    expect(`${result.out}${result.err}`).not.toContain(token);
  });

  it("refuses bad arguments before changing anything", async () => {
    const home = tempHome();
    for (const [args, env, message] of [
      [[], {}, "say what to install"],
      [["skill", "--arena", "Career!"], { ARENA_TOKEN: "arena_0123456789abcdef" }, "is not an arena slug"],
      [["skill"], { ARENA_TOKEN: "arena_0123456789abcdef" }, "set ARENA_TOKEN and pass --arena <slug> together"],
      [["skill", "--arena", "career"], { ARENA_TOKEN: "has spaces in it" }, "doesn't look like an Arena key"],
      [["skill", "--bogus"], {}, 'unknown argument "--bogus"'],
      [["uninstall", "skill"], {}, "run uninstall on its own"],
    ] as const) {
      const result = await install(home, [...args], { ...env });
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.err).toContain(message);
    }
    expect(existsSync(path.join(home, ".config"))).toBe(false);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("without saved details, installs but says what's missing", async () => {
    const home = tempHome();
    const result = await install(home, ["reporter"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("No ~/.config/arena/env yet");
    expect(existsSync(path.join(home, ".config", "arena", "bin", "arena-report.mjs"))).toBe(true);
  });
});
