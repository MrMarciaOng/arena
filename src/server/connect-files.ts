import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Files the Connect page's commands download from this Arena (`/api/connect/:file`). They hold no
 * secrets: the key goes into ~/.config/arena/env on the user's machine, never into these files.
 * Each path is a literal so the build traces the file into the function (next.config.ts lists them
 * too).
 */

/** The hook and notify scripts import the reporter from the repo layout; installed, it sits beside them. */
function besideReporter(text: string): string {
  return replaceOnce(text, `from "../../scripts/arena-report.mjs"`, `from "./arena-report.mjs"`);
}

function replaceOnce(text: string, search: string, replacement: string): string {
  if (!text.includes(search)) throw new Error(`connect file: expected to find ${search}`);
  return text.replace(search, () => replacement);
}

const cwd = () => process.cwd();

export const CONNECT_FILES = {
  "install.js": {
    read: () => readFile(path.join(cwd(), "scripts", "arena-install.cjs"), "utf8"),
    transform: (text: string, origin: string) => replaceOnce(text, `"__ARENA_URL__"`, JSON.stringify(origin)),
  },
  "arena-report.mjs": { read: () => readFile(path.join(cwd(), "scripts", "arena-report.mjs"), "utf8") },
  "arena-hook.mjs": {
    read: () => readFile(path.join(cwd(), "examples", "claude-code-hooks", "arena-hook.mjs"), "utf8"),
    transform: besideReporter,
  },
  "arena-notify.mjs": {
    read: () => readFile(path.join(cwd(), "examples", "codex-notify", "arena-notify.mjs"), "utf8"),
    transform: besideReporter,
  },
  "SKILL.md": { read: () => readFile(path.join(cwd(), "skills", "arena-presence", "SKILL.md"), "utf8") },
  "setup.md": { read: () => readFile(path.join(cwd(), "skills", "arena-presence", "references", "setup.md"), "utf8") },
} satisfies Record<string, { read: () => Promise<string>; transform?: (text: string, origin: string) => string }>;

export type ConnectFileName = keyof typeof CONNECT_FILES;

export function isConnectFile(name: string): name is ConnectFileName {
  return Object.hasOwn(CONNECT_FILES, name);
}

/** The file's text as served from `origin` (the installer downloads the rest from there), or null. */
export async function readConnectFile(name: string, origin: string): Promise<string | null> {
  if (!isConnectFile(name)) return null;
  const file: { read: () => Promise<string>; transform?: (text: string, origin: string) => string } = CONNECT_FILES[name];
  const text = await file.read();
  return file.transform ? file.transform(text, origin) : text;
}
