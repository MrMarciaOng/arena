// What the Connect page offers to copy. Pure, so the page can render it with a masked key and copy
// it with the real one, and tests can check both.

export type ConnectValues = {
  /** This Arena's origin, e.g. https://arena.example. */
  origin: string;
  slug: string;
  /** The API key, or a masked stand-in for display. */
  token: string;
};

export const CONNECT_TOOLS = ["claude", "codex", "assistant", "shell"] as const;
export type ConnectTool = (typeof CONNECT_TOOLS)[number];

export const TOOL_LABEL: Record<ConnectTool, string> = {
  claude: "Claude Code",
  codex: "Codex",
  assistant: "Any AI assistant",
  shell: "Shell and cron",
};

export type InstallCommand = "skill" | "claude-hooks" | "codex" | "reporter";

/** Single quotes for the shell; a value that's already safe stays bare. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One line that downloads the installer from this Arena and runs it with Node (macOS, Linux, WSL). */
export function installCommand(v: ConnectValues, commands: InstallCommand[]): string {
  return `curl -fsSL ${v.origin}/api/connect/install.js | ARENA_TOKEN=${shellQuote(v.token)} node - ${commands.join(" ")} --arena ${v.slug}`;
}

export function uninstallCommand(origin: string): string {
  return `curl -fsSL ${origin}/api/connect/install.js | node - uninstall`;
}

const statusUrl = (v: ConnectValues, key: string) => `${v.origin}/api/arenas/${v.slug}/agents/${key}/status`;

/** A report anyone can run to see an agent appear. */
export function curlExample(v: ConnectValues, agentKey = "my-agent"): string {
  return `curl -X POST ${statusUrl(v, agentKey)} \\
  -H ${shellQuote(`Authorization: Bearer ${v.token}`)} -H "Content-Type: application/json" \\
  -d '{"status":"working","activity":"Hello from my agent","displayName":"My agent"}'`;
}

/** After `reporter` is installed: what a script or cron job runs. */
export function reporterExamples(): string {
  const r = "node ~/.config/arena/bin/arena-report.mjs";
  return `${r} nightly-backup working --activity "Copying photos" --progress 0.4
${r} nightly-backup waiting --waiting-on human --waiting-for "disk is full"
some-command | ${r} nightly-backup done --result-stdin
${r} nightly-backup error --error "backup drive not found"
${r} nightly-backup heartbeat --leaving`;
}

/**
 * Instructions to paste into an AI assistant that can make HTTP requests or run commands. It
 * explains the whole API with this arena's values, so no install is needed.
 */
export function assistantPrompt(v: ConnectValues): string {
  const base = `${v.origin}/api/arenas/${v.slug}/agents/<agent-key>`;
  const auth = `-H ${shellQuote(`Authorization: Bearer ${v.token}`)} -H "Content-Type: application/json"`;
  return `Please keep my Arena dashboard up to date while you work. Arena is a live board of my AI agents. Report your status to it with HTTP requests (curl or any HTTP tool you have).

Arena: ${v.origin} (arena "${v.slug}")
API key: ${v.token}
Send the key as "Authorization: Bearer <key>". Keep it out of files you commit or share.

1. Pick an agent key once and reuse it for every report: lowercase letters, digits, ".", "_" or "-", up to 64 characters, ending in a few random letters so two sessions don't collide (for example "assistant-research-k3x9"). Use it for <agent-key> below.

2. Report a status. Each report replaces the previous one, and the first one adds you to the board:
curl -sS -X POST ${base}/status ${auth} -d '{"status":"working","activity":"Reading the auth module","displayName":"<your name> · <project>"}'

Statuses and their fields:
- "working": "activity" (one short line), "progress" (0 to 1, optional)
- "waiting": "waitingOn" ("human", "agent" or "external"), "waitingFor" (what you need). Send waitingOn "human" right before you ask me something; the board flags it as Needs you.
- "done": "result" (markdown: your answer or a summary of what you did)
- "error": "error" (what went wrong)
- "idle": between tasks
Always include "displayName" so the board names you.

3. When to report: "working" when you start and when you move to a new phase; "waiting" right before you ask me a question or wait on something; "done" with your answer when you finish; "error" if you can't go on. About 5 to 10 reports for a big task, not one per step. After I answer a question, report "working" again.

4. During long work with nothing to report (10 minutes or more), send a heartbeat so you don't look stalled:
curl -sS -X POST ${base}/heartbeat ${auth} -d '{}'

5. When the session is over, leave the board:
curl -sS -X DELETE ${base} -H ${shellQuote(`Authorization: Bearer ${v.token}`)}

Reporting must never get in the way of the work. If a report fails, tell me once in one line, then carry on without reporting.`;
}
