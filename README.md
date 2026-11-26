# Arena

A pixel-art dashboard for your AI agents. Each **arena** is a workplace (a "Career" office, a "Personal" kitchen, a voxel "Island", ...). Agents report over HTTP whether they are working, waiting or done, and the dashboard shows it live: who is busy, who is waiting on you, and what they produced.

The design, the full endpoint list and how it runs in production are in [docs/PLAN.md](docs/PLAN.md).

## Quick start

```bash
pnpm install
cp .env.example .env.local   # then fill it in (see below)
pnpm db:migrate
pnpm dev --hostname 127.0.0.1
```

Open [Arena locally](http://127.0.0.1:3000), log in, and select **New arena**.

What to set in `.env.local`:

- **Database.** In your Supabase project, open **Connect**, copy the **Session pooler** connection string (port 5432), fill in the database password and set it as `DATABASE_URL`. Leave it empty to work offline on an embedded [PGlite](https://pglite.dev) database.
- **Login.** Set up [Supabase magic links](#sign-in-with-supabase). To work offline, set `ARENA_OWNER_PASSWORD` and `ARENA_SESSION_SECRET` for password login.
- **Admin API.** Set `ARENA_ADMIN_TOKEN` to manage arenas over HTTP.

[`.env.example`](.env.example) describes every setting. On Vercel, set them as the project's environment variables.

## Sign in with Supabase

People sign in with a [magic link](https://supabase.com/docs/guides/auth/auth-email-passwordless): they enter their email and open the link Supabase sends. A new email gets an account on first sign-in, and each account can own up to eight private arenas (deleting one frees a slot).

1. In the Supabase dashboard, open **Authentication → URL Configuration**. Set **Site URL** to your production URL, and add `<your-domain>/**` to **Redirect URLs** for every domain Arena runs on (for example `http://localhost:3000/**` and your Vercel preview domains).
2. Set `ARENA_AUTH_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `ARENA_ENCRYPTION_KEY`. If Arena already has API keys, keep the secret it has now (`ARENA_ENCRYPTION_KEY` or `ARENA_SESSION_SECRET`), or they can't be copied again.
3. Run `pnpm db:migrate` and restart Arena. Open `/login`, enter your email, and open the link in the same browser.

Before other people sign in:

- **Set up custom SMTP** (**Authentication → Emails → SMTP Settings**). Supabase's built-in email service sends only a few emails an hour, and only to members of your Supabase organization. With custom SMTP you can also make links work in any browser: in the **Magic link** and **Confirm signup** templates, set the link to `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`.
- **To allow only accounts you create**, turn off **Allow new users to sign up** (**Authentication → Sign In / Providers**) and invite people from **Authentication → Users**.

Arenas that have no Supabase account stay reachable in password mode and through the admin API; Supabase accounts start with an empty dashboard. To create an arena for a particular account through the admin API, pass its Supabase User UID as `ownerUserId` to `POST /api/arenas`. It counts toward that account's limit.

## Report from an agent

Create an arena with **New arena** in the web UI, or through the admin API:

```bash
curl -X POST "$ARENA_URL/api/arenas" \
  -H "Authorization: Bearer $ARENA_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"slug":"career","name":"Career","theme":"office"}'
```

The arena comes with an API key named `default`: `apiKey.token` in the response, or **Settings → API keys** in the web UI. Report with that key. The first report registers the agent, and each report replaces the previous state:

```bash
curl -X POST "$ARENA_URL/api/arenas/career/agents/resume-writer/status" \
  -H "Authorization: Bearer $ARENA_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"working","activity":"Tailoring resume for Acme"}'
```

| Status | Fields |
|---|---|
| `idle` | |
| `working` | `activity`, `progress` (0–1) |
| `waiting` | `waitingOn` (`human`, `agent` or `external`), `waitingFor` |
| `done` | `result` (markdown) |
| `error` | `error` |

- **API keys.** A key works only for its arena. Give each machine or agent its own (`laptop`, `claude-hooks`, ...) so you can revoke one without breaking the rest. On the arena's **Settings** page you can create, copy and revoke keys; the admin API does the same under `/api/arenas/:slug/keys`. If you change the encryption secret, existing keys keep working but can't be copied again.
- **Out-of-order reports.** Hooks that fire in parallel can deliver reports out of order. Send `session` (any id for the run) and `seq` (a number that goes up within the session, such as `Date.now()`). A report whose `seq` is at or below the last one in its session goes into the history but doesn't change the dashboard. A new `session` starts over.
- **Away and stalled.** An agent that isn't heard from for `ttlSeconds` (default 900) shows as **away**: dimmed, with its status and answer kept. A working agent that goes quiet is flagged **Stalled?**. Send `POST .../heartbeat` during long work, or `{"leaving": true}` to go away at once, for example when a session ends.

## Integrations

The quickest way in is an arena's **Connect agents** page (the link next to **Settings**). Pick a key and a tool, then copy what it gives you:

| Tool | What you copy |
|---|---|
| Claude Code | a command that installs the skill, or the hooks |
| Codex | a command that installs the skill and Codex's `notify` |
| Any AI assistant | a prompt that explains the API, with this arena's URL and key filled in |
| Shell and cron | a command that installs the reporter, plus examples and a raw `curl` |

The commands download the installer from the arena itself (`/api/connect/install.js`) and run it with Node 18+:

```bash
curl -fsSL https://your-arena/api/connect/install.js | ARENA_TOKEN='arena_…' node - skill --arena career
```

- **What it writes.** Once Arena accepts the key, it saves the URL, slug and key in `~/.config/arena/env` (mode 600). Every integration below reads that one file, so installing with another key or arena replaces it for all of them, and the installer says so.
- **Where things go.** Scripts go in `~/.config/arena/bin`, and the skill in `~/.claude/skills` and `~/.codex/skills` (or under `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set).
- **Editing settings.** The first time it changes `~/.claude/settings.json` or `~/.codex/config.toml`, it keeps a copy (`<file>.arena-backup`); uninstall puts the copy back if nothing else in the file has changed. It leaves other hooks alone and never replaces another `notify` program. It checks the key and these files, and downloads everything, before it changes anything.
- **Commands.** `skill`, `claude-hooks`, `codex` and `reporter` install those integrations; `uninstall` removes everything it added.
- **Served files.** The same route serves `arena-report.mjs`, `arena-hook.mjs`, `arena-notify.mjs`, `SKILL.md` and `setup.md`. None of them holds a secret.

The rest of this section sets the same integrations up by hand from a checkout. Each reads `ARENA_URL`, `ARENA_SLUG` (the arena) and `ARENA_TOKEN` (one of its API keys) from the environment. Keep `ARENA_TOKEN` out of anything you commit.

### Shell and cron

[`scripts/arena-report.mjs`](scripts/arena-report.mjs) needs only Node 18+:

```bash
scripts/arena-report.mjs nightly-backup working --activity "Copying photos"
scripts/arena-report.mjs nightly-backup waiting --waiting-on human --waiting-for "disk is full"
some-command | scripts/arena-report.mjs nightly-backup done --result-stdin   # or --result-file report.md
scripts/arena-report.mjs nightly-backup heartbeat --leaving
```

It exits 0 even when a report fails, so it can't break the job that calls it (`--strict` exits non-zero), and its error messages never include the key. Answers too long for the request limit are cut and marked as cut. Pass `--session <run-id>` when one job sends several reports and their order matters. The other commands are `register`, `remove`, `check` (is the configuration right?) and `new-key` (a fresh agent key for a session).

### Claude Code hooks

Copy `hooks` and `env` from [`examples/claude-code-hooks/settings.example.json`](examples/claude-code-hooks/settings.example.json) into `~/.claude/settings.json` or a project's `.claude/settings.json`, with the real path to `arena-hook.mjs`. Put `ARENA_TOKEN` somewhere private: `~/.claude/settings.json`, a project's `.claude/settings.local.json` (not committed), or your shell environment.

| Claude Code event | Arena shows |
|---|---|
| SessionStart | the agent, registered |
| UserPromptSubmit | working, with your prompt as the activity (`ARENA_SHARE_PROMPTS=0` shows only "Working") |
| Notification (permission and question prompts) | waiting on you (**Needs you**) |
| Stop | done, with Claude's last message of the turn as the answer |
| SessionEnd | away, with the answer kept (`ARENA_ON_SESSION_END=remove` removes the agent) |

Each session is its own agent, named `claude-<folder>-<id>`, so sessions running side by side don't overwrite each other. Set `ARENA_AGENT_KEY` to make sessions share one agent. Remove finished sessions from **Settings**. The hook reports from a background process, so Claude never waits on Arena.

### Codex

Add this to `~/.codex/config.toml`:

```toml
notify = ["node", "/path/to/arena/examples/codex-notify/arena-notify.mjs"]
```

Each finished turn reports done, with Codex's last message as the answer and your request as the activity (`ARENA_SHARE_PROMPTS=0` leaves the request out). Each thread is its own agent, named `codex-<folder>-<id>`, unless you set `ARENA_AGENT_KEY`.

### Skill for Claude Code and Codex

[`skills/arena-presence/`](skills/arena-presence/SKILL.md) teaches the agent to report for itself: register, keep its status current, send heartbeats during long work, and remove itself when the session is finished. `scripts/install-skill.sh` links it into `~/.claude/skills` and `~/.codex/skills` (`--uninstall` removes the links). Then put the arena's details in a private file that the reporter reads:

```bash
mkdir -p ~/.config/arena && cat > ~/.config/arena/env <<'ENV'
ARENA_URL=http://localhost:3000
ARENA_SLUG=career
ARENA_TOKEN=arena_...   # Settings → API keys → Copy
ENV
chmod 600 ~/.config/arena/env
```

The skill and the hooks can run together. Set `ARENA_AGENT_KEY` so that both report to one card.

### TypeScript

[`src/lib/client.ts`](src/lib/client.ts) is a small typed client. Its types come from `src/lib/domain.ts` and `src/lib/schemas.ts`, so copy those too if you use it elsewhere.

```ts
const arena = createArenaClient({ baseUrl: process.env.ARENA_URL!, token: process.env.ARENA_TOKEN!, arena: "career" });
await arena.working("resume-writer", "Tailoring resume", 0.3);
await arena.done("resume-writer", "## Resume\n- tailored for Acme");
```

It fills in `session` and `seq`, and sends each agent's reports one at a time in the order you call them, even if you don't await each call.

## Deploy on Vercel and Supabase

1. **Create a Supabase project.** Open **Connect** and copy the **Transaction pooler** connection string (port 6543), with your database password filled in. That pooler suits serverless functions, which open and drop connections all the time.
2. **Import the repository in Vercel** and set these for Production:
   - `DATABASE_URL`: the pooler connection string
   - the login settings from [Sign in with Supabase](#sign-in-with-supabase)
   - `ARENA_ADMIN_TOKEN`, `ARENA_ENCRYPTION_KEY` and `CRON_SECRET`
   - `ARENA_TRUST_PROXY=1`

   Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Don't give Preview deployments the production `DATABASE_URL`: their builds would migrate it too.
3. **Run functions next to the database.** Every page load reads Postgres several times in a row, so a function on another continent waits a full round trip for each read. `vercel.json` pins functions to `sin1` (Singapore), where this project's Supabase database is. If yours is elsewhere, change `regions` to the [Vercel region](https://vercel.com/docs/edge-network/regions) nearest it.
4. **Deploy.** The build runs `pnpm db:migrate && pnpm build` (see `vercel.json`), so the schema is migrated before each new version goes live. The previous version keeps serving until then, so a migration must not break it: add columns and tables first, and drop old ones a release later.

What to know once it is running:

- **Live updates.** Each open dashboard tab holds one streaming request, which Arena ends and the browser reopens every 240 s. If your Vercel plan caps functions below 300 s, set `ARENA_STREAM_SECONDS` under that cap, or the page briefly shows "reconnecting" each time.
- **Daily cleanup.** Vercel Cron calls `/api/cron/maintenance` once a day. It keeps the last 100 events per agent, for 30 days at most.
- **Health check.** `GET /api/health`.
- **Backups** are Supabase's (**Database → Backups**; daily on paid plans). For your own copy, run `pg_dump` with the session pooler or direct connection string, not the transaction pooler. Store the dump privately, because it holds every prompt and answer. Keep `ARENA_ENCRYPTION_KEY` safe too: restored API keys work without it, but can't be copied again.

**Other hosts.** Arena is a normal Next.js app: `pnpm db:migrate && pnpm build && pnpm start` runs it on any Node host with a Postgres `DATABASE_URL`. In production it starts only with a login configured (or `ARENA_ALLOW_ANONYMOUS_READ=1`), and it refuses an embedded `pglite:` database unless `ARENA_ALLOW_EMBEDDED_DB=1`. Vercel always refuses one.

## Develop

```bash
pnpm test              # unit and route-handler tests (Vitest, each file on its own in-memory PGlite)
pnpm test:e2e          # browser tests against a production build (Playwright)
pnpm typecheck
pnpm lint
pnpm simulate          # fake agents in a "career" and a "personal" arena (needs ARENA_URL and ARENA_ADMIN_TOKEN)
scripts/smoke-api.sh   # curl walk-through of the API against a running server
```

To run the unit tests on a real Postgres, which they wipe: `TEST_DATABASE_URL=postgres://... pnpm test --no-file-parallelism`.
