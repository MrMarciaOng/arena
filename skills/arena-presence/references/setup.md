# Setting up Arena reporting

Read this when `check` fails, or when the user asks how to connect a tool to Arena.

## What the reporter needs

Three values: the Arena URL, an API key for one arena, and that arena's slug. The environment wins; anything it leaves out is read from `~/.config/arena/env` (or the file named by `ARENA_CONFIG`):

```bash
mkdir -p ~/.config/arena
cat > ~/.config/arena/env <<'EOF'
ARENA_URL=http://localhost:3000
ARENA_SLUG=career
ARENA_TOKEN=arena_...
EOF
chmod 600 ~/.config/arena/env
```

The key comes from the arena's **Settings** page in Arena, under **API keys**. Give each machine or tool its own named key (for example `laptop-claude`) and use **Copy**; keys can be copied again later and revoked one at a time. The reporter warns if the file is readable by other users.

Never put the key in a file that gets committed, such as a project's shared `.claude/settings.json`.

## Common failures

| Message | Meaning |
|---|---|
| `set ARENA_URL, ARENA_TOKEN and ARENA_SLUG` | nothing configured: create the file above |
| `request failed: could not reach Arena` | wrong URL, Arena isn't running, or (Codex) the sandbox blocks network access |
| `HTTP 401 unauthorized` | the key is wrong or was revoked: copy a fresh one from Settings |
| `HTTP 403 forbidden` | the key belongs to a different arena than `ARENA_SLUG` |
| `HTTP 429 rate_limited` | too many reports in a burst: report less often |

## Automatic reporting (no skill needed)

These report the main moments on their own; the skill adds richer status on top.

**Claude Code hooks**: the Arena repo's `examples/claude-code-hooks/settings.example.json` wires `arena-hook.mjs` to SessionStart, UserPromptSubmit, Notification (permission and question prompts), Stop and SessionEnd. Each session becomes `claude-<folder>-<session id>`. By default the card stays, dimmed, when the session ends; set `ARENA_ON_SESSION_END=remove` to have it leave the arena instead. If you use the hooks and the skill together, set `ARENA_AGENT_KEY` so both report to one card.

**Codex**: `notify = ["node", "/path/to/arena/examples/codex-notify/arena-notify.mjs"]` in `~/.codex/config.toml` reports `done` with Codex's last message after each turn.

Both read the same three values; the hooks send each report from a background process so they never slow the session down.
