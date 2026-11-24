import { SLUG_RE, type AgentPublic } from "./domain";
import type { HeartbeatInput, RegisterAgentInput, StatusInput } from "./schemas";

/** A small typed client for agents written in TypeScript. Works in Node 18+, Bun, Deno and browsers. */

export class ArenaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A status report without the ordering fields, which the client fills in. */
type Report = StatusInput extends infer T ? (T extends unknown ? Omit<T, "session" | "seq"> : never) : never;

export type ArenaClientOptions = {
  baseUrl: string;
  /** One of the arena's API keys (or the admin token). */
  token: string;
  arena: string;
  /** Each request gives up after this long (default 15 s), so a stalled one can't block the agent's queue. */
  timeoutMs?: number;
  /**
   * Orders this client's reports (see "Status update semantics" in docs/PLAN.md). Defaults to a
   * random id per client, so a restarted process starts a new session.
   */
  session?: string;
  fetch?: typeof fetch;
};

/** A random id. Uses Web Crypto where it exists (not every runtime or insecure origin has randomUUID). */
function randomId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function checkSlug(kind: string, value: string): string {
  // Also stops "." and ".." from turning an agent URL into the arena's own URL.
  if (!SLUG_RE.test(value)) throw new ArenaError(400, "invalid_" + kind, `"${value}" is not a valid ${kind}`);
  return value;
}

export function createArenaClient(options: ArenaClientOptions) {
  const base = options.baseUrl.replace(/\/$/, "");
  const arena = checkSlug("arena", options.arena);
  const doFetch = options.fetch ?? fetch;
  const session = options.session ?? randomId();
  let lastSeq = 0;
  // Strictly increasing even for several reports in the same millisecond.
  const nextSeq = () => (lastSeq = Math.max(Date.now(), lastSeq + 1));
  // One request at a time per agent, in call order, so every transition is applied (not just the
  // latest to arrive) even when the caller doesn't await each report.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    queues.set(key, next);
    void next.catch(() => {}).finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}/api/arenas/${encodeURIComponent(arena)}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect could resend the body (answers) to another host.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ArenaError(res.status, payload?.error?.code ?? "http_error", payload?.error?.message ?? `HTTP ${res.status}`);
    }
    // Reading the body is bounded by the same timeout as the request.
    return (res.status === 204 ? null : await res.json()) as T;
  }

  const agentPath = (key: string) => `/agents/${encodeURIComponent(checkSlug("agent key", key))}`;

  const report = (key: string, input: Report) => {
    const path = `${agentPath(key)}/status`;
    const body = { ...input, session, seq: nextSeq() };
    return serial(key, () => call<{ applied: boolean; agent: AgentPublic }>("POST", path, body));
  };

  return {
    session,
    register: (key: string, profile: RegisterAgentInput = {}) => {
      const path = agentPath(key);
      return serial(key, () => call<{ agent: AgentPublic }>("PUT", path, profile));
    },
    report,
    idle: (key: string, activity?: string) => report(key, { status: "idle", activity }),
    working: (key: string, activity?: string, progress?: number) => report(key, { status: "working", activity, progress }),
    waiting: (key: string, waitingFor?: string, waitingOn?: "human" | "agent" | "external") =>
      report(key, { status: "waiting", waitingFor, waitingOn }),
    done: (key: string, result?: string, activity?: string) => report(key, { status: "done", result, activity }),
    error: (key: string, error?: string) => report(key, { status: "error", error }),
    heartbeat: (key: string, input: HeartbeatInput = {}) => {
      const path = `${agentPath(key)}/heartbeat`;
      return serial(key, () => call<null>("POST", path, input));
    },
    remove: (key: string) => {
      const path = agentPath(key);
      return serial(key, () => call<null>("DELETE", path));
    },
    get: (key: string) => call<{ agent: AgentPublic & { result: string | null } }>("GET", agentPath(key)),
    list: async () => (await call<{ agents: AgentPublic[] }>("GET", "/agents")).agents,
  };
}

export type ArenaClient = ReturnType<typeof createArenaClient>;
