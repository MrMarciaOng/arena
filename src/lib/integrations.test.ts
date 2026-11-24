import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as agentRoute from "@/app/api/arenas/[slug]/agents/[key]/route";
import * as heartbeatRoute from "@/app/api/arenas/[slug]/agents/[key]/heartbeat/route";
import * as statusRoute from "@/app/api/arenas/[slug]/agents/[key]/status/route";
import * as agentsRoute from "@/app/api/arenas/[slug]/agents/route";
import { createArena, getArena } from "@/server/arenas";
import { rows } from "../../test/helpers";
import { events } from "@/server/db/schema";
import {
  agentKeyFor as claudeKey,
  lastAssistantText,
  planFor as claudePlan,
  readTail,
} from "../../examples/claude-code-hooks/arena-hook.mjs";
import { agentKeyFor as codexKey, planFor as codexPlan } from "../../examples/codex-notify/arena-notify.mjs";
import {
  BODY_LIMIT,
  buildStatusBody,
  checkConfig,
  cutUtf8,
  fitBody,
  newKey,
  parseArgs,
  readConfigFile,
  sendJob,
  sendRemove,
} from "../../scripts/arena-report.mjs";
import { ArenaError, createArenaClient } from "./client";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;

/** Routes fetch calls straight to the route handlers, so the client is tested against the real API. */
const viaHandlers: typeof fetch = async (input, init) => {
  const req = new Request(input as string, init);
  const parts = new URL(req.url).pathname.split("/").filter(Boolean); // api arenas :slug agents [:key [status|heartbeat]]
  const [, , slug, , key, action] = parts;
  const ctx = { params: Promise.resolve({ slug, key }) };
  if (!key) return agentsRoute.GET(req, { params: Promise.resolve({ slug }) });
  if (action === "status") return statusRoute.POST(req, ctx);
  if (action === "heartbeat") return heartbeatRoute.POST(req, ctx);
  const handler = { GET: agentRoute.GET, PUT: agentRoute.PUT, DELETE: agentRoute.DELETE }[req.method];
  if (!handler) throw new Error(`no handler for ${req.method} ${req.url}`);
  return handler(req, ctx);
};

describe("createArenaClient", () => {
  it("registers, reports through every status, heartbeats and removes", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const client = createArenaClient({ baseUrl: "http://arena.test", token: apiKey.token, arena: "career", fetch: viaHandlers });

    expect((await client.register("writer", { displayName: "Writer" })).agent.displayName).toBe("Writer");
    expect((await client.working("writer", "drafting", 0.5)).agent).toMatchObject({ status: "working", progress: 0.5 });
    expect((await client.waiting("writer", "your approval", "human")).agent).toMatchObject({ waitingOn: "human" });
    expect((await client.done("writer", "## Answer")).applied).toBe(true);
    expect((await client.error("writer", "oops")).applied).toBe(true);
    expect((await client.get("writer")).agent.status).toBe("error");
    await client.heartbeat("writer", { leaving: true });
    expect((await client.list())[0].awaySince).not.toBeNull();
    await client.remove("writer");
    expect(await client.list()).toEqual([]);
  });

  it("applies every report in call order, even unawaited, in the same millisecond, with reversed delivery", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    onTestFinished(() => void vi.useRealTimers());
    // A transport that would deliver the first request last if the client sent them together.
    let delay = 30;
    const slowFirst: typeof fetch = async (input, init) => {
      const wait = delay;
      delay = 0;
      await new Promise((r) => setTimeout(r, wait));
      return viaHandlers(input, init);
    };
    const client = createArenaClient({ baseUrl: "http://arena.test", token: apiKey.token, arena: "career", fetch: slowFirst });
    const results = await Promise.all([client.working("writer", "one"), client.done("writer", "two")]);
    expect(results.map((r) => r.applied)).toEqual([true, true]);
    const applied = (await rows(events)).filter((e) => e.type === "agent.status" && e.applied);
    expect(applied.map((e) => (e.report as { status: string }).status)).toEqual(["working", "done"]);
  });

  it("refuses an invalid agent key before sending anything (\"..\" must never reach the arena URL)", async () => {
    const calls: string[] = [];
    const recording: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 204 });
    };
    const client = createArenaClient({ baseUrl: "http://arena.test", token: "arena_x", arena: "career", fetch: recording });
    expect(() => client.remove("..")).toThrow(ArenaError);
    expect(() => client.remove(".")).toThrow(/not a valid agent key/);
    expect(calls).toEqual([]);
  });

  it("raises ArenaError with the server's code, and refuses redirects", async () => {
    await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const client = createArenaClient({ baseUrl: "http://arena.test", token: "arena_wrong", arena: "career", fetch: viaHandlers });
    await expect(client.idle("writer")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    let seen: RequestInit | undefined;
    const spy: typeof fetch = async (_input, init) => {
      seen = init;
      return new Response(null, { status: 204 });
    };
    await createArenaClient({ baseUrl: "http://arena.test", token: "arena_x", arena: "career", fetch: spy }).heartbeat("writer");
    expect(seen?.redirect).toBe("error");
  });
});

describe("arena-report CLI", () => {
  const script = path.resolve("scripts/arena-report.mjs");
  const run = (args: string[], vars: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: env({ PATH: process.env.PATH ?? "", ARENA_URL: "http://127.0.0.1:9", ARENA_SLUG: "career", ARENA_TOKEN: "arena_secret_123", ...vars }),
    });

  it("cuts at a character boundary", () => {
    expect(cutUtf8("a€b", 3)).toBe("a");
    expect(cutUtf8("a€b", 4)).toBe("a€");
  });

  it("shrinks an answer so the JSON body fits the limit, and marks it", () => {
    const body = fitBody({ status: "done", result: "\u0001".repeat(200_000) }); // 6 bytes each once escaped
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(BODY_LIMIT);
    expect(body.result).toMatch(/cut by arena-report/);
    const small = { status: "done", result: "short" };
    expect(fitBody(small)).toBe(small);
  });

  it("only orders reports when given a session", () => {
    expect(buildStatusBody("working", {})).toEqual({ status: "working" });
    expect(buildStatusBody("working", { session: "s" })).toMatchObject({ session: "s", seq: expect.any(Number) });
    expect(buildStatusBody("waiting", { "waiting-on": "human", "waiting-for": "ok?", seq: "7", session: "s" })).toEqual({
      status: "waiting",
      waitingOn: "human",
      waitingFor: "ok?",
      seq: 7,
      session: "s",
    });
    expect(buildStatusBody("done", { "result-stdin": true }, () => "from stdin")).toMatchObject({ result: "from stdin" });
  });

  it("takes --name=value literally and wants a session with --seq", () => {
    expect((parseArgs(["bot", "done", "--result=--- front matter"]).flags as { result?: string }).result).toBe("--- front matter");
    expect(() => parseArgs(["bot", "working", "--seq", "3"])).toThrow(/--seq needs --session/);
    expect(() => parseArgs(["bot", "working", "--strict=1"])).toThrow(/takes no value/);
  });

  it("reads all of piped stdin even past the limit, so the writer isn't killed by SIGPIPE", () => {
    const producer = `process.stdout.write("x".repeat(4 * 1024 * 1024))`;
    const out = spawnSync("/bin/sh", ["-c", `set -o pipefail 2>/dev/null; "${process.execPath}" -e '${producer}' | "${process.execPath}" "${script}" bot done --result-stdin; echo "pipe=$?"`], {
      encoding: "utf8",
      env: env({ PATH: process.env.PATH ?? "", ARENA_URL: "http://127.0.0.1:9", ARENA_SLUG: "career", ARENA_TOKEN: "arena_x" }),
    });
    expect(out.stdout).toMatch(/pipe=0/);
  });

  it("never echoes a non-JSON success body", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<html>secret proxy page</html>", { status: 200 })) as typeof fetch;
    onTestFinished(() => {
      globalThis.fetch = real;
    });
    const failure = sendJob(
      { kind: "status", key: "bot", body: { status: "idle" } },
      { env: env({ ARENA_URL: "http://a.test", ARENA_TOKEN: "arena_x", ARENA_SLUG: "career" }) },
    );
    await expect(failure).rejects.toThrow(/isn't Arena's JSON/);
    await expect(failure).rejects.not.toThrow(/secret proxy page/);
  });

  it("rejects unknown flags, missing values and stray arguments", () => {
    expect(() => parseArgs(["bot", "done", "--reslt-file", "x.md"])).toThrow(/unknown option --reslt-file/);
    expect(() => parseArgs(["bot", "working", "--activity", "--strict"])).toThrow(/--activity needs a value/);
    expect(() => parseArgs(["bot", "done", "extra"])).toThrow(/usage/);
    expect(() => parseArgs(["bot", "sleeping"])).toThrow(/unknown status/);
  });

  it("exits 0 on errors unless --strict, and never prints the token", () => {
    const loose = run(["bot", "nonsense"]);
    expect(loose.status).toBe(0);
    expect(loose.stderr).toMatch(/unknown status/);
    expect(run(["bot", "nonsense", "--strict"]).status).toBe(2);

    // Unreachable server, and a token fetch would refuse (it contains a newline).
    const leaky = run(["bot", "working", "--strict"], { ARENA_TOKEN: "arena_secret_123\nX-Evil: 1" });
    expect(leaky.status).toBe(1);
    expect(leaky.stderr).not.toContain("arena_secret_123");
    expect(leaky.stderr).toMatch(/request failed/);
  });

  it("runs when invoked through a symlink", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arena-link-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const link = path.join(dir, "arena-report");
    symlinkSync(script, link);
    const out = spawnSync(process.execPath, [link, "bot", "nonsense"], { encoding: "utf8", env: env({ PATH: process.env.PATH ?? "" }) });
    expect(out.stderr).toMatch(/unknown status/);
  });
});

describe("Claude Code hook", () => {
  const base = { session_id: "3f9a2c41-aaaa-bbbb", cwd: "/Users/me/code/My Project", transcript_path: "/tmp/t.jsonl" };

  it("maps prompts, permission prompts, stops and session end, one agent per session", () => {
    const key = claudeKey(base, env());
    expect(key).toMatch(/^claude-[0-9a-f]{12}$/);
    expect(claudePlan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the\nbug" }, { now: 5, env: env() })).toEqual({
      kind: "status",
      key,
      body: { session: base.session_id, seq: 5, displayName: "Claude · My Project", status: "working", activity: "fix the bug" },
    });
    expect(
      claudePlan(
        { ...base, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" },
        { now: 5, env: env() },
      ),
    ).toMatchObject({ key, body: { status: "waiting", waitingOn: "human", waitingFor: "Claude needs your permission to use Bash" } });
    expect(claudePlan({ ...base, hook_event_name: "SessionEnd" }, { env: env() })).toEqual({ kind: "heartbeat", key, body: { leaving: true } });
    // A second session in the same folder is a different agent, even with a shared id prefix
    // (UUIDv7 ids start with a timestamp); the same session keeps its key when its folder changes.
    expect(claudeKey({ ...base, session_id: "3f9a2c41-aaaa-cccc" }, env())).not.toBe(key);
    expect(claudeKey({ ...base, cwd: "/somewhere/else" }, env())).toBe(key);
    expect(claudeKey(base, env({ ARENA_AGENT_KEY: "shared" }))).toBe("shared");
  });

  it("keeps prompts off the dashboard when ARENA_SHARE_PROMPTS=0", () => {
    expect(
      claudePlan({ ...base, hook_event_name: "UserPromptSubmit", prompt: "secret plan" }, { env: env({ ARENA_SHARE_PROMPTS: "0" }) }),
    ).toMatchObject({ body: { activity: "Working" } });
  });

  it("ignores notifications that don't need a human", () => {
    for (const type of ["idle_prompt", "auth_success"]) {
      expect(claudePlan({ ...base, hook_event_name: "Notification", notification_type: type, message: "x" }, { env: env() })).toBeNull();
    }
  });

  it("caps the display name at the API's 80 characters", () => {
    const plan = claudePlan({ ...base, cwd: `/x/${"d".repeat(120)}`, hook_event_name: "SessionStart" }, { env: env() })!;
    expect(Array.from((plan.body as { displayName: string }).displayName).length).toBeLessThanOrEqual(80);
    expect(plan.key.length).toBeLessThanOrEqual(64);
  });

  it("takes the answer from the hook input, or else from this turn of the transcript only", () => {
    expect(claudePlan({ ...base, hook_event_name: "Stop", last_assistant_message: "direct" }, { env: env() })).toMatchObject({
      body: { result: "direct" },
    });
    const turn = [
      JSON.stringify({ type: "user", message: { role: "user", content: "earlier prompt" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Old answer." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "new prompt" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here is the plan." }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    ].join("\n");
    expect(lastAssistantText(turn)).toBe("Here is the plan.");
    // This turn produced no text: don't reuse the previous turn's answer.
    const toolsOnly = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Old answer." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "new prompt" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
    ].join("\n");
    expect(lastAssistantText(toolsOnly)).toBeNull();
    // A prompt that is only an image still starts a new turn.
    const imageOnly = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Old answer." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", source: {} }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } }),
    ].join("\n");
    expect(lastAssistantText(imageOnly)).toBeNull();
    expect(claudePlan({ ...base, hook_event_name: "Stop" }, { readTranscript: () => toolsOnly, env: env() })!.body).not.toHaveProperty("result");
  });

  it("reads only the tail of a transcript, and only from a regular file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arena-tail-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "x".repeat(5000) + "\nEND");
    expect(readTail(file, 100)).toHaveLength(100);
    expect(readTail(file, 100).endsWith("END")).toBe(true);
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(() => readTail(fifo)).toThrow(/not a regular file/);
  });
});

describe("Codex notify", () => {
  it("reports done with the last message, one agent per thread, and ignores other events", () => {
    const event = {
      type: "agent-turn-complete",
      "thread-id": "abc123-ffff",
      cwd: "/code/arena",
      "input-messages": ["rename the", "function"],
      "last-assistant-message": "Renamed.",
    };
    expect(codexPlan(event, 9, env())).toEqual({
      status: "done",
      session: "abc123-ffff",
      seq: 9,
      displayName: "Codex · arena",
      activity: "rename the function",
      result: "Renamed.",
    });
    expect(codexKey(event, env())).toMatch(/^codex-[0-9a-f]{12}$/);
    // Two threads whose ids share a timestamp prefix are still two agents.
    expect(codexKey({ ...event, "thread-id": "abc123-0000" }, env())).not.toBe(codexKey(event, env()));
    expect(codexPlan(event, 9, env({ ARENA_SHARE_PROMPTS: "0" }))).not.toHaveProperty("activity");
    expect(codexPlan({ type: "something-else" })).toBeNull();
  });
});

describe("hooks against the real API", () => {
  it("a Claude session's registration is accepted by the server", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    const arena = await getArena("career");
    const client = createArenaClient({ baseUrl: "http://arena.test", token: apiKey.token, arena: arena.slug, fetch: viaHandlers });
    const plan = claudePlan({ session_id: "s1", cwd: "/code/arena", hook_event_name: "SessionStart" }, { env: env() })!;
    const profile = plan.body as { displayName: string; role: string };
    expect((await client.register(plan.key, profile)).agent.displayName).toBe("Claude · arena");
  });
});

describe("reporter commands the skill uses", () => {
  /** Lets the reporter's fetch reach the route handlers, and restores the real fetch afterwards. */
  function routeFetchToHandlers() {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const [, , slug, , key] = url.pathname.split("/").filter(Boolean);
      if (!key) {
        const arenaRoute = await import("@/app/api/arenas/[slug]/route");
        return arenaRoute.GET(new Request(url, init), { params: Promise.resolve({ slug }) });
      }
      return viaHandlers(input as string, init);
    }) as typeof fetch;
    onTestFinished(() => {
      globalThis.fetch = real;
    });
  }

  it("new-key makes a valid, per-session key", () => {
    const a = newKey("claude", "My Project");
    expect(a).toMatch(/^claude-my-project-[0-9a-f]{4}$/);
    expect(newKey("claude", "My Project")).not.toBe(a);
    expect(newKey("codex", "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("parses the standalone commands and the new options", () => {
    expect(parseArgs(["check"])).toMatchObject({ key: null, status: "check" });
    expect(parseArgs(["new-key", "--tool", "codex"])).toMatchObject({ status: "new-key", flags: { tool: "codex" } });
    expect(parseArgs(["bot", "register", "--name", "Bot", "--role", "helps", "--arena", "personal"])).toMatchObject({
      key: "bot",
      status: "register",
      flags: { name: "Bot", role: "helps", arena: "personal" },
    });
    expect(parseArgs(["bot", "remove"])).toMatchObject({ status: "remove" });
  });

  it("reads the private config file, with the environment taking precedence", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arena-cfg-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "env");
    writeFileSync(file, '# arena\nexport ARENA_URL="http://a.test"\nARENA_SLUG=career\nARENA_TOKEN=arena_x\nOTHER=ignored\n', { mode: 0o600 });
    expect(readConfigFile(file)).toEqual({ ARENA_URL: "http://a.test", ARENA_SLUG: "career", ARENA_TOKEN: "arena_x" });
    expect(readConfigFile(path.join(dir, "missing"))).toEqual({});
  });

  it("check, register, report and remove work against the API", async () => {
    const { apiKey } = await createArena({ slug: "career", name: "Career", theme: "office" }, Date.now());
    routeFetchToHandlers();
    const opts = { env: env({ ARENA_URL: "http://arena.test", ARENA_TOKEN: apiKey.token, ARENA_SLUG: "career" }) };
    expect(await checkConfig(opts)).toEqual({ arena: "career", name: "Career", agents: 0 });
    await sendJob({ kind: "profile", key: "claude-arena-ab12", body: { displayName: "Claude · arena" } }, opts);
    await sendJob({ kind: "status", key: "claude-arena-ab12", body: { status: "working", activity: "x" } }, opts);
    expect((await checkConfig(opts)).agents).toBe(1);
    await sendRemove("claude-arena-ab12", opts);
    expect((await checkConfig(opts)).agents).toBe(0);
  });

  it("the Claude hook removes the agent on SessionEnd when asked to", () => {
    const input = { session_id: "abc123", cwd: "/code/arena", hook_event_name: "SessionEnd" };
    expect(claudePlan(input, { env: env({ ARENA_ON_SESSION_END: "remove" }) })).toEqual({
      kind: "remove",
      key: claudeKey(input, env()),
      body: null,
    });
    expect(claudePlan(input, { env: env() })).toMatchObject({ kind: "heartbeat", body: { leaving: true } });
  });
});

describe("background delivery spool", () => {
  function useTempSpool() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arena-spool-test-"));
    vi.stubEnv("ARENA_SPOOL_DIR", dir);
    for (const [k, v] of Object.entries({ ARENA_URL: "http://a.test", ARENA_TOKEN: "arena_x", ARENA_SLUG: "career" })) vi.stubEnv(k, v);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  it("delivers one agent's jobs in the order they were queued, then leaves the spool empty", async () => {
    useTempSpool();
    const { deliverInBackground, drainSpool } = await import("../../scripts/arena-report.mjs");
    const queue = (job: object) => deliverInBackground(job, { startWorker: false }) as string;
    queue({ kind: "status", key: "bot", body: { status: "working" } });
    queue({ kind: "status", key: "bot", body: { status: "done" } });
    const dir = queue({ kind: "remove", key: "bot", body: null });
    const sent: string[] = [];
    await drainSpool(dir, {
      send: async (job: { kind: string; body: { status?: string } | null }) => void sent.push(job.body?.status ?? job.kind),
    });
    expect(sent).toEqual(["working", "done", "remove"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("records a failed delivery where `check` can show it, without the key", async () => {
    useTempSpool();
    const { deliverInBackground, drainSpool, recentDeliveryErrors } = await import("../../scripts/arena-report.mjs");
    const dir = deliverInBackground({ kind: "status", key: "bot", body: { status: "idle" } }, { startWorker: false }) as string;
    await drainSpool(dir, { send: async () => Promise.reject(new Error("HTTP 401 unauthorized")) });
    const errors = recentDeliveryErrors();
    expect(errors.at(-1)).toMatch(/status bot: HTTP 401 unauthorized/);
    expect(errors.join("\n")).not.toContain("arena_x");
  });

  it("refuses to touch a folder that isn't one of its spool folders", async () => {
    useTempSpool();
    const { drainSpool } = await import("../../scripts/arena-report.mjs");
    const dir = mkdtempSync(path.join(os.tmpdir(), "arena-not-spool-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "000000000000001-00000000000000000001-abcdef.json"), "{}");
    writeFileSync(path.join(dir, "keep.txt"), "important");
    const sends: unknown[] = [];
    await drainSpool(dir, { send: async (job: unknown) => void sends.push(job) });
    expect(sends).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["000000000000001-00000000000000000001-abcdef.json", "keep.txt"]);
  });
});
