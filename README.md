# Arena

A pixel-art dashboard for your AI agents. Each **arena** is a workplace (a "Career" office, a "Personal" kitchen, ...). Agents report over HTTP whether they are working, waiting or done, and what their answer was. The dashboard shows who is busy, who is waiting on you, and what they produced, live.

The design is in [docs/PLAN.md](docs/PLAN.md).

## Run it

Run the Next.js app locally and connect it to a Supabase development database over PostgreSQL.
In your Supabase project, open **Connect** and copy the **Session pooler** connection string
(port 5432). Fill in the database password and set `DATABASE_URL` in `.env.local`. If `.env` already
sets `DATABASE_URL`, omit that variable from `.env.local`.

Set `ARENA_OWNER_PASSWORD` and `ARENA_SESSION_SECRET` in `.env.local` to enable owner login.
Set `ARENA_ADMIN_TOKEN` if you also need to manage arenas through the API. Use the variable
names in `.env.example` as a reference.

```bash
pnpm install
pnpm db:migrate
pnpm dev --hostname 127.0.0.1
```

Open [Arena locally](http://127.0.0.1:3000), log in, and select **New arena** to create a workplace.
For offline development or automated tests, Arena also supports [PGlite](https://pglite.dev).

Set local values in `.env` or `.env.local`. On Vercel, use the project's environment variables.

| Variable | What it does |
|---|---|
| `DATABASE_URL` | `postgres://...` (Supabase or any Postgres), or `pglite:<dir>` for an embedded database. Default `pglite:./data/pglite` |
| `ARENA_ADMIN_TOKEN` | Bearer token for the admin API (create, rename and delete arenas; manage API keys). 24+ characters |
| `ARENA_OWNER_PASSWORD` | Password for the web UI |
| `ARENA_SESSION_SECRET` | Signs the login cookie. 32+ characters, required with a password |
| `ARENA_ENCRYPTION_KEY` | Encrypts stored API keys so they can be copied again. 32+ characters; defaults to `ARENA_SESSION_SECRET` |
| `CRON_SECRET` | Lets Vercel Cron call the daily cleanup (`/api/cron/maintenance`). 16+ characters |
| `ARENA_TRUST_PROXY` | `1` only behind a proxy that overwrites `X-Forwarded-For` (Vercel does); then failed logins are throttled per client |
| `ARENA_INSECURE_COOKIE` | `1` lets the login cookie work over plain HTTP in production (self-hosted on a LAN without TLS) |
| `ARENA_ALLOW_ANONYMOUS_READ` | `1` lets anyone who can reach the app read dashboards. Off by default |

Without a password (and without anonymous read) nobody can read the dashboard, and production refuses to start.

## Report from an agent

Create an arena (once). It comes with an API key named `default` (`apiKey.token` in the response):

```bash
curl -X POST "$ARENA_URL/api/arenas" \
  -H "Authorization: Bearer $ARENA_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"slug":"career","name":"Career","theme":"office"}'
```

Report state with that key. The first report registers the agent:

```bash
curl -X POST "$ARENA_URL/api/arenas/career/agents/resume-writer/status" \
  -H "Authorization: Bearer $ARENA_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"working","activity":"Tailoring resume for Acme"}'

curl -X POST "$ARENA_URL/api/arenas/career/agents/resume-writer/status" \
  -H "Authorization: Bearer $ARENA_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"done","result":"## Resume\n- tailored for Acme"}'
```

Statuses: `idle`, `working` (`activity`, `progress` 0–1), `waiting` (`waitingOn`: `human` | `agent` | `external`, `waitingFor`), `done` (`result`, markdown), `error` (`error`). Each report replaces the previous state. The full endpoint list is in the plan.

You can also do all of this from the web UI once you're logged in as the owner: **New arena** in the header, and each arena's **Settings** page.

### API keys

Each arena has its own named API keys, sent as `Authorization: Bearer <key>`; a key only works for its arena. Give each machine or agent its own key (`laptop`, `claude-hooks`, ...) so you can revoke one without breaking the rest. On the **Settings** page you can create keys, **copy any key again at any time**, and revoke them. Keys are stored encrypted with `ARENA_ENCRYPTION_KEY` (or `ARENA_SESSION_SECRET` if that isn't set); if you change that secret, existing keys keep working but can't be copied again. The admin API has the same operations under `/api/arenas/:slug/keys`.

### Out-of-order reports

Hooks that fire in parallel can deliver reports out of order. Send `session` (any id for this run) and `seq` (a number that goes up within the session, e.g. `Date.now()`); a report with a `seq` at or below the last one in the same session is kept in history but doesn't change the dashboard. A new `session` starts over.

### Heartbeats and "away"

An agent that isn't heard from for `ttlSeconds` (default 900) shows as **away**: dimmed, but its status and answer stay. A working agent that goes quiet is flagged **Stalled?**. Send `POST .../heartbeat` to stay live during long work, or `{"leaving": true}` to go away right now (for example when a session ends) without clearing the answer.

## Integrations

All of these read `ARENA_URL`, `ARENA_TOKEN` (one of the arena's API keys) and `ARENA_SLUG` (the arena) from the environment. Keep `ARENA_TOKEN` out of anything you commit: export it in your shell profile, or put it in a file that stays private (see the Claude Code notes below).

**Shell, cron, anything** — [`scripts/arena-report.mjs`](scripts/arena-report.mjs) (Node 18+, no install):

```bash
scripts/arena-report.mjs nightly-backup working --activity "Copying photos"
scripts/arena-report.mjs nightly-backup done --result-file report.md
some-command | scripts/arena-report.mjs nightly-backup done --result-stdin
scripts/arena-report.mjs nightly-backup waiting --waiting-on human --waiting-for "disk is full"
scripts/arena-report.mjs nightly-backup heartbeat --leaving
```

It exits 0 even when something fails, so it can't break the job that calls it (`--strict` exits non-zero instead), and its error messages never include the key. Long answers are cut to fit the request limit and marked as cut. Pass `--session <run-id>` when one job sends several reports and their order matters; without it, the last report to arrive wins.

**Claude Code** — [`examples/claude-code-hooks/`](examples/claude-code-hooks): copy the `hooks` and `env` from `settings.example.json` into `~/.claude/settings.json` (or a project's `.claude/settings.json`), with the real path to `arena-hook.mjs`. Add `ARENA_TOKEN` somewhere private: your user-level `~/.claude/settings.json`, a project's `.claude/settings.local.json` (not committed), or your shell environment. Never put it in a project's shared `.claude/settings.json`.

Each session is its own agent, named after its folder plus a short session id (`claude-<folder>-<id>`), so sessions running side by side don't overwrite each other; set `ARENA_AGENT_KEY` to make sessions share one agent. Finished sessions stay on the dashboard (an idle one that has gone away is hidden in the scene); remove old ones from Settings. The hook sends each report from a background process, so Claude never waits on Arena, even when it is down.

| Claude Code event | Arena |
|---|---|
| SessionStart | registers the agent |
| UserPromptSubmit | working, with your prompt as the activity (`ARENA_SHARE_PROMPTS=0` shows just "Working") |
| Notification (permission or question prompts only) | waiting on you (**Needs you**) |
| Stop | done, with Claude's last message in that turn as the answer |
| SessionEnd | away; the answer stays |

**Codex** — [`examples/codex-notify/arena-notify.mjs`](examples/codex-notify/arena-notify.mjs): add `notify = ["node", "/path/to/arena/examples/codex-notify/arena-notify.mjs"]` to `~/.codex/config.toml`. Each finished turn reports done with Codex's last message as the answer and your request as the activity (`ARENA_SHARE_PROMPTS=0` leaves it out). Each Codex thread is its own agent (`codex-<folder>-<id>`, or set `ARENA_AGENT_KEY`).

**A skill for Claude Code and Codex** — [`skills/arena-presence/`](skills/arena-presence/SKILL.md) teaches the agent itself to show up in an arena: register, keep its status text current (working on what, waiting on you or on CI, done with its answer, error, standing by), send heartbeats during long work, and remove itself from the arena when the session is finished. Install it with `scripts/install-skill.sh` (it links the skill into `~/.claude/skills` and `~/.codex/skills`; `--uninstall` removes the links), then put your arena's details in a private file the reporter reads:

```bash
mkdir -p ~/.config/arena && cat > ~/.config/arena/env <<'ENV'
ARENA_URL=http://localhost:3000
ARENA_SLUG=career
ARENA_TOKEN=arena_...   # Settings → API keys → Copy
ENV
chmod 600 ~/.config/arena/env
```

The skill and the hooks can run together; set `ARENA_AGENT_KEY` so both report to one card. With the Claude Code hook, `ARENA_ON_SESSION_END=remove` takes the agent off the arena when the session ends.

The reporter also has `register`, `remove`, `check` (is the configuration right?) and `new-key` (a fresh per-session agent key) commands.

**TypeScript** — [`src/lib/client.ts`](src/lib/client.ts) is a small typed client. It takes its types from `src/lib/domain.ts` and `src/lib/schemas.ts`, so copy those along if you use it elsewhere:

```ts
const arena = createArenaClient({ baseUrl: process.env.ARENA_URL!, token: process.env.ARENA_TOKEN!, arena: "career" });
await arena.working("resume-writer", "Tailoring resume", 0.3);
await arena.done("resume-writer", "## Resume\n- tailored for Acme");
```

It fills in `session` and `seq` for you and sends each agent's reports one at a time in the order you call them, so every transition is applied, even if you don't await each call.

## Deploy (Vercel + Supabase)

1. **Create a Supabase project.** Arena only needs its Postgres database. In the dashboard, open
   **Connect** and copy the **Transaction pooler** connection string (port 6543, host
   `*.pooler.supabase.com`), with your database password filled in. That pooler suits serverless
   functions, which open and drop connections all the time; Arena turns off prepared statements
   for it automatically.
2. **Import the repository in Vercel** and set the environment variables for Production. Don't
   give Preview deployments the production `DATABASE_URL`: their builds would migrate it too.
   - `DATABASE_URL`: the pooler connection string
   - `ARENA_ADMIN_TOKEN`, `ARENA_OWNER_PASSWORD`, `ARENA_SESSION_SECRET` (and optionally `ARENA_ENCRYPTION_KEY`)
   - `CRON_SECRET`: any random string of 16+ characters
   - `ARENA_TRUST_PROXY=1`: Vercel overwrites `X-Forwarded-For`, so failed logins can be throttled per client

   Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
3. **Deploy.** `vercel.json` makes the build run `pnpm db:migrate && pnpm build`, so the schema is
   migrated before each new version goes live. Drizzle records which migrations ran, so each runs
   once. The previous version keeps serving until the new one is live, so a migration must not
   break it (add columns and tables; drop old ones a release later). The app never migrates on a
   cold start unless `ARENA_AUTO_MIGRATE=1`.

How it runs there:

- **Live updates.** Every change is written, in the same transaction, to a `changes` table with a
  global sequence number. Each open dashboard holds one Server-Sent Events request that starts
  with a snapshot and then polls that table once a second (`ARENA_STREAM_POLL_MS`), so it doesn't
  matter which function instance took the write. Vercel ends a function after `maxDuration` (300 s),
  so the stream says "reconnect" after 240 s (`ARENA_STREAM_SECONDS`) and the browser reopens it at
  once, from a fresh snapshot. Each open tab therefore keeps one function busy (mostly idle) and
  makes about one small query a second. If your Vercel plan or settings cap functions below 300 s,
  set `ARENA_STREAM_SECONDS` under that cap; otherwise the stream is cut and the page briefly shows
  "reconnecting".
- **Rate limits and the login throttle** are counted in Postgres, so they hold across instances.
- **Daily cleanup.** Vercel Cron calls `/api/cron/maintenance` once a day (see `vercel.json`). It
  sends `CRON_SECRET` as a bearer token and the endpoint refuses anything else. It keeps the last
  100 events per agent (30 days at most), an hour of the change feed and a minute of rate-limit
  counters. Events are also pruned as agents report, so a missed run is harmless.
- **Health check.** `GET /api/health` runs `SELECT 1`.
- **Connections.** Each instance opens at most `ARENA_DB_POOL_SIZE` (default 5) connections. The
  transaction pooler shares them out; Supabase's direct connection (port 5432) would run out fast.
- **Backups** are Supabase's (daily on paid plans; Database → Backups). For your own copy, use
  `pg_dump` with the **session pooler** or direct connection string, not the transaction pooler.
  Keep `ARENA_ENCRYPTION_KEY` / `ARENA_SESSION_SECRET` safe too: restored API keys always keep
  working, but they can only be copied again with the same secret. The dump holds every prompt and
  answer, so store it privately.

**Elsewhere.** Arena is a normal Next.js app: `pnpm db:migrate && pnpm build && pnpm start` runs it
on any Node host with a Postgres `DATABASE_URL`. An embedded `pglite:` database is refused in
production (and always on Vercel, whose disk doesn't last) unless `ARENA_ALLOW_EMBEDDED_DB=1`.

## Develop

```bash
pnpm test        # unit and route-handler tests (Vitest, each file on its own in-memory PGlite)
TEST_DATABASE_URL=postgres://... pnpm test --no-file-parallelism   # the same tests on a real Postgres (it is wiped)
pnpm test:e2e    # browser tests against a production build (Playwright)
pnpm typecheck
pnpm lint
pnpm simulate    # fake agents in a "career" and a "personal" arena (needs ARENA_URL and ARENA_ADMIN_TOKEN)
scripts/smoke-api.sh   # curl walk-through of the API against a running server
```
