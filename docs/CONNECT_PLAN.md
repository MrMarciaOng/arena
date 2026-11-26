# Connect agents: plan

## Problem

Arena only shows agents that report to it, but the web app gives no way to set one up beyond an API key and a single `curl` example. The reporter script, the Claude Code hook, the Codex notify script and the `arena-presence` skill live in the repo, which people using a deployed Arena never see, and the app doesn't serve them.

## Goal

From any arena, an owner can connect Claude Code, Codex, another AI assistant, or a shell script in under a minute: pick a key, pick a tool, press **Copy**, and paste. Every snippet already has the site's URL, the arena slug and the key filled in.

## Design

### 1. Files served by the app: `GET /api/connect/:file`

A public route (it holds no secrets) with a fixed allowlist, read from the repo at request time and traced into the function with `outputFileTracingIncludes`:

| File | Source |
|---|---|
| `install.js` | `scripts/arena-install.cjs`, with this site's URL filled in |
| `arena-report.mjs` | `scripts/arena-report.mjs` |
| `arena-hook.mjs` | `examples/claude-code-hooks/arena-hook.mjs`, importing `./arena-report.mjs` |
| `arena-notify.mjs` | `examples/codex-notify/arena-notify.mjs`, importing `./arena-report.mjs` |
| `SKILL.md`, `setup.md` | `skills/arena-presence/` |

- Served as `text/plain` with `nosniff`, so a browser never runs them.
- Unknown names get 404; the lookup is an own-property check, so a name can't reach other files.

### 2. The installer: `curl -fsSL <url>/api/connect/install.js | ARENA_TOKEN='…' node - <commands> --arena <slug>`

Node instead of `sh`:
- Node is already required by every integration.
- `node -` reads the whole script before running any of it, so a cut-off download runs nothing.
- It works the same on macOS and Linux.

What it does:
- Writes `~/.config/arena/env` (folder 700, file 600) when `ARENA_TOKEN` and `--arena` are given. The key goes in through the environment, never as an argument that `ps` could show.
- Runs one or more commands:
  - `skill`: installs `arena-presence` in `~/.claude/skills`, and in `~/.codex/skills` when Codex is installed. A symlinked checkout is left alone.
  - `claude-hooks`: puts the reporter and the hook in `~/.config/arena/bin`, then adds the five hook events to `~/.claude/settings.json`.
    - It backs the file up first and refuses to touch a file that isn't valid JSON.
    - Existing Arena hook entries are replaced and other hooks are kept, so running it again is safe.
  - `codex`: puts the reporter and the notify script in `~/.config/arena/bin`, then sets `notify` in `~/.codex/config.toml`.
    - It backs the file up first and inserts the setting above the first table.
    - It never replaces another program's `notify`; it explains instead.
  - `reporter`: installs `arena-report.mjs` only, for shell scripts and cron.
  - `uninstall`: removes everything the installer added, including the hook entries, the notify line and the env file.
- Ends with `arena-report check` and prints what it changed and what to restart.

### 3. The Connect page: `/arenas/:slug/connect` (owner only)

1. **Key.** Pick one of the arena's copyable keys, or create one inline.
   - Choosing a key fetches it with `revealKeyAction`; it's never in the HTML.
   - Snippets show the masked prefix, and **Copy** puts the real key on the clipboard. **Show key** reveals it.
   - `?key=<id>` preselects a key.
2. **Tool**, as accessible tabs:
   - **Claude Code**: the skill (Claude reports for itself: progress, questions, answers) or the hooks (automatic, no cooperation needed).
   - **Codex**: skill and notify.
   - **Any AI assistant**: a prompt to paste that explains the HTTP API with the values filled in. It comes with a warning that pasting the key shares it with that service.
   - **Shell and cron**: installs the reporter, with examples and a raw `curl` command.
3. **Check.** Agents appear on the arena after their first report, with a link back to the arena.

Copying works over HTTP too: when the clipboard is unavailable, the text is shown selected so it can be copied by hand.

### 4. Ways in

- The arena header gets a **Connect agents** link, and an arena with no agents points to the Connect page instead of API keys.
- In Settings, the API keys section links to it, and a newly created key links to it with that key preselected.
- A new arena's ready screen leads with **Connect agents**.

## Testing

- **Unit:** the snippet builders, covering filled-in values, masked and real keys, and shell-safe quoting.
- **Route:** every allowlisted file is served, the imports are rewritten, the installer gets the request's URL, unknown and tricky names return 404, and nothing is cached as HTML.
- **Installer, end to end:** the route is served on a local port and the installer is piped into `node` with a temporary `HOME`. It must:
  - write the env file with mode 600;
  - install the skill;
  - merge the hooks into existing settings without losing other hooks, and stay idempotent;
  - insert Codex `notify` correctly and refuse to replace a foreign one;
  - leave invalid JSON untouched;
  - leave a clean home after `uninstall`;
  - leave the reporter's `check` working against the real API.
- **Playwright:**
  - The empty arena links to the Connect page.
  - Choosing a tab and copying puts the real key on the clipboard.
  - The copied `curl` command, run as is, makes the agent appear on the arena.
  - A non-owner gets the owner-only message.

## Out of scope

- Windows shells (PowerShell), beyond the "Any AI assistant" prompt and `curl`.
- Per-tool keys created automatically.
- A TypeScript client package.
