# Arena: implementation plan

A Next.js web app that shows your AI agents as pixel-art characters in 2D workplaces. Each workplace is an **arena**, for example a "Career" office and a "Personal" kitchen. Agents call HTTP endpoints to register and report their state. The UI shows at a glance who is working, who is waiting (and on what), who is done (and their answer), and who has gone quiet.

## Goals

1. Agents can register in an arena and report `working` / `waiting` / `done` / `error` / `idle`, including a short activity line and, when done, the answer.
2. You can keep several arenas (Career, Personal, ...), each with its own theme, token and agents.
3. A live 2D scene per arena: the state of each agent shows in where it stands, how it moves and its speech bubble. Click a character to read its answer and history.
4. Integrating an agent takes one `curl` call, so shell hooks (Claude Code, Codex `notify`, cron jobs, scripts) can report without an SDK.

## Non-goals for v1

- Two-way messaging (replying to a waiting agent from the UI). The data model leaves room for it (see Future).
- Teams and shared arenas. Each arena belongs to one account (in password mode, to the one owner).
- Running or orchestrating agents. Arena only shows the state they report.

## Assumptions to confirm

- **Art style:** "accelerated art" is read as **pixel art** (low-resolution sprites scaled up with crisp pixels).
- **Hosting:** Vercel (serverless functions) with Supabase as a PostgreSQL server. Local development connects to a Supabase development database. Automated tests use PGlite, an embedded Postgres.
- **Themes for v1:** `office` and `kitchen`.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript strict | Requested; route handlers serve the API and server components serve the pages |
| Styling | Tailwind CSS 4 for the UI chrome; a pixel font (Pixelify Sans, OFL) via `next/font` | Fast to build; the font fits the art |
| DB | **PostgreSQL** + **Drizzle ORM** (`pg-core`). Production uses the Supabase transaction pooler. Local development uses the session pooler. Tests use **PGlite** (`pglite:<dir>` or `pglite:memory`). | Every environment runs the same SQL, schema, and migrations. The database holds arena data, the change feed, rate limits, and the login throttle. |
| Hosting | **Vercel** (Fluid compute), cron from `vercel.json` | Requested. The build migrates the database (`pnpm db:migrate && pnpm build`) |
| Validation | zod 4, with schemas shared by API and client | One source of truth for payloads |
| Live updates | Server-Sent Events from a route handler that follows a change-feed table in Postgres (polled once a second) | One-way push is all the UI needs. Polling a table works across serverless instances with no extra service. Each connection starts from a fresh snapshot and reconnects before Vercel's time limit |
| Markdown answers | `react-markdown` + `rehype-sanitize` (no raw HTML, no images) | Agent output is untrusted |
| Tests | Vitest (unit + route handlers, each file on its own in-memory PGlite; `TEST_DATABASE_URL` runs the same tests on a real Postgres), Playwright (e2e against a production build) | |
| Package manager | pnpm | |

Next 16 notes: `middleware.ts` is now `proxy.ts`. Route handler `params` is a `Promise`. The scaffold turns on **Cache Components**, which removes the `runtime` and `dynamic` segment options: route handlers that read the request are dynamic on their own, and pages and server components that read the database call `await connection()` (from `next/server`) inside a `<Suspense>` boundary, so they render per request and are never prerendered against the build-time database. The live pages take their data from the stream, so only the settings page reads the database while rendering.

---

## Domain model

### Arena
A workplace. Fields: `id`, `slug` (URL-safe, unique), `name`, `theme` (`office` | `kitchen`), `ownerUserId` (the Supabase account that owns it; null for an arena without one), `version`, timestamps.

### API key
An arena has any number of **named API keys** (for example `default`, `laptop`, `claude-hooks`); agents send one as `Authorization: Bearer <key>`. Fields: `id`, `arenaId`, `name` (unique in the arena), `tokenHash` (SHA-256, how requests are matched), `tokenSealed` (the key encrypted with AES-256-GCM under `ARENA_ENCRYPTION_KEY`, or `ARENA_SESSION_SECRET` when that isn't set), `prefix` (first characters, for telling keys apart), `createdAt`, `lastUsedAt` (updated at most once a minute). The owner can **copy a key again at any time**; a copy of the database file alone doesn't reveal keys. A key with no sealed copy (made before sealing existed, or with no secret configured, or after the secret changed) still works but can't be shown again. Revoking one key leaves the others working. A new arena starts with one key named `default`; at most 50 keys per arena.

### Agent
A character inside one arena, identified by a **client-chosen `key`** that is unique within that arena (for example `resume-writer` or `claude-arena-repo`). Because the key comes from the client, registration is idempotent: an agent that restarts keeps its identity and seat instead of creating a duplicate. The same real agent in two arenas is two registrations.

| Field | Notes |
|---|---|
| `key`, `displayName`, `role` | identity; `role` is a one-line description |
| `appearance` | `{ seed?, palette? }`. The sprite colors come from a hash of `key` unless overridden |
| `status` | `idle` \| `working` \| `waiting` \| `done` \| `error` |
| `activity` | ≤ 200 chars, for example "Tailoring resume for Acme" |
| `waitingOn` / `waitingFor` | `human` \| `agent` \| `external`, and ≤ 200 chars of reason. `waitingOn: human` is shown as **Needs you** |
| `progress` | 0–1, optional |
| `result`, `resultTruncated` | markdown answer, set with `done`. Above 64 KB the server cuts it at a UTF-8 boundary and sets `resultTruncated`, so a long answer never blocks the `done` transition |
| `error` | ≤ 2 KB, set with `error` |
| `seat` | stable home station index, given out at registration (the lowest free index) |
| `version` | taken from one global change counter on every applied change (status, profile, acknowledge), so it also orders a re-registration after a removal. Clients use it to drop stale messages |
| `session`, `seqWatermark` | the ordering guard (see below) |
| `ttlSeconds` | how long without contact before the agent counts as **away** (default 900) |
| `lastSeenAt`, `awaySince`, `statusChangedAt` | presence and timing |
| `metadata` | free JSON ≤ 4 KB, stored and shown but not interpreted |

### Presence is separate from status
Presence is `live` or `away`. An agent is `away` if `awaySince` is set (it said it was leaving) or `now − lastSeenAt > ttlSeconds`. Any later contact clears `awaySince`. Presence is derived and never stored as a status.

Presence **never hides status**. A one-shot hook that reports `done` and exits stays under Done with its answer until you acknowledge it. An agent waiting on you stays under Needs you. Away agents are drawn dimmed with "last seen 20 m ago". The one combination that needs a warning is `working` + away, which is flagged **Stalled?** because the work may have died. The client computes presence with a server-clock offset taken from the snapshot, so it changes without a server event.

### Status update semantics
- A status report **replaces** the current state fields (`status`, `activity`, `waitingOn`, `waitingFor`, `progress`, `result`, `error`). It does not merge. What the agent sent last is what the scene shows, and an old activity line never lingers.
- Fields that don't fit the status are rejected by validation. For example, `result` is only allowed with `done`, and `waitingFor` only with `waiting`.
- **Ordering (optional).** A report may carry `session` (any string; Claude Code's `session_id` works) and `seq` (any number that increases within that session: epoch ms or a counter). The first rule that matches decides:
  1. No `seq`: the report applies, and the watermark doesn't change.
  2. `session` differs from the stored one: the report applies, and the watermark resets to this `seq`. A restart on another host or a clock correction starts a new session, so an old future-dated `seq` can't block it.
  3. Same session and `seq` > watermark: the report applies, and the watermark becomes `seq`.
  4. Same session and `seq` ≤ watermark (ties included): the report is stored in history as superseded, and the current state doesn't change. The response is `200 { applied: false }`. A sender that can emit two reports in the same millisecond uses a counter, not epoch ms.
- The first status report for an unknown `key` **auto-registers** the agent (`displayName` defaults to `key`), so a single curl call is enough.
- **Writes are serialized.** Every write that changes what the dashboard shows runs in a transaction that first locks the global counter row (`SELECT … FOR UPDATE`), so such writes run one at a time across every instance and commit in counter order. Looking up the key, checking the 100-agent cap, picking the lowest free seat, writing the agent, appending the event and adding to the change feed all happen inside it. `UNIQUE(arenaId, key)` and `UNIQUE(arenaId, seat)` back it up. Two first reports that arrive together can't take the same seat or both squeeze in as agent 100. At this app's write rate (a few reports a second at most) one lock is not a bottleneck.

### Event (history)
An append-only history for the agent timeline. The live stream does **not** replay from it (see SSE), so pruning can't corrupt what the UI shows. Fields: `id`, `arenaId`, `agentKey`, `type` (`agent.registered` | `agent.status` | `agent.updated` | `agent.acknowledged` | `agent.removed`), `applied` (bool), `report` (the body exactly as submitted, so a superseded report shows what really arrived; `result` is kept only on `done` reports), `agentVersion` (the version after the change, null when not applied), `createdAt`.

- Heartbeats are **not** stored as events. They update `lastSeenAt` / `awaySince` and publish a non-persisted `presence` message.
- Retention: keep the last 100 events per agent and drop events older than 30 days. Prune after writes (at most once a minute per arena) and in a daily job.

---

## HTTP API

All JSON. Errors look like `{ "error": { "code": "validation_failed", "message": "...", "details": [...] } }` with the right status codes (400, 401, 403, 404, 409, 413, 429).

### Auth model

| Credential | How it's sent | Can do |
|---|---|---|
| **Admin token** (`ARENA_ADMIN_TOKEN` env) | `Authorization: Bearer` | everything over the API |
| **Arena API key** (any number per arena, named, copyable by the owner at any time, revocable one by one) | `Authorization: Bearer` | register, report, heartbeat and remove agents in **that arena only**; read that arena |
| **Supabase account session** | cookie | read and manage up to eight arenas owned by the account |
| **Legacy owner session** (password login) | cookie | read and manage arenas without an assigned Supabase account |

- Route handlers that write accept **Bearer tokens only**, never cookies, so cookie-based CSRF against the API is impossible.
- UI mutations (create arena, create, copy and revoke API keys, rename, change theme, remove agent, acknowledge) go through Server Actions. Each action verifies the session and scopes the operation to the authenticated owner's arenas.
- **`proxy.ts` only gates pages.** A page request without an owner cookie redirects to `/login`; `/login` and `/auth/confirm` are exempt. In Supabase mode the proxy also refreshes the session cookie. The proxy's matcher excludes `/api/*` (a matched request would have its body buffered, up to 10 MB, before any handler check): each API handler resolves its own credential (admin Bearer, arena API key Bearer, or owner cookie for reads) and returns a JSON 401/403. That way an arena API key can read its own arena over the API, and `/api/health` stays open.
- `ARENA_ALLOW_ANONYMOUS_READ=1` enables public reads of legacy arenas in password mode. Supabase mode requires an account for browser access.
- **Login:**
  - **Supabase mode** signs people in with a magic link. They enter an email and Supabase sends the link; a new email gets an account on first use unless sign-ups are turned off in Supabase. The link lands on `/auth/confirm`, which exchanges its token hash or PKCE code for a session cookie. Supabase's default link uses PKCE, so it must be opened in the browser that asked for it; an email template with a token-hash link works in any browser. Each request then checks the session's verified JWT claims.
  - **Password mode** compares the configured password in constant time and signs a 30-day cookie with `ARENA_SESSION_SECRET`.
  - Both modes share one throttle in Postgres (5 attempts per client and 20 in total per minute). Password mode counts failed attempts; Supabase mode counts every link sent, so the form can't be used to flood an inbox.
  - Both modes use `httpOnly` cookies and restrict the return path to the app. A cookie-authenticated stream reconnects when the session expires.
- Keys: 32 random bytes, prefixed `arena_` so secret scanners catch them, looked up by SHA-256 hash, and stored sealed for copying (see "API key" above).
- Limits: request body ≤ 256 KB (413); 100 agents per arena; a rate limit of 200 requests per 10-second window per token, counted in Postgres (429 with `Retry-After`).

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | liveness |
| GET | `/api/arenas` | owner / admin | list arenas with status counts (`working`, `waiting`, `needsYou`, `done`, `error`, `idle`) plus `away` |
| POST | `/api/arenas` | admin | create `{ slug, name, theme, ownerUserId? }` → `{ arena, apiKey: { id, name, prefix, token, ... } }` (its first key, named `default`) |
| GET | `/api/arenas/:slug` | owner / admin / ingest(own) | snapshot: `{ arena, agents[], serverTime }` |
| PATCH | `/api/arenas/:slug` | admin | rename, change theme |
| DELETE | `/api/arenas/:slug` | admin | delete the arena with its agents and events |
| GET | `/api/arenas/:slug/keys` | admin | list API keys (name, prefix, created, last used, copyable; never the keys) |
| POST | `/api/arenas/:slug/keys` | admin | create a key `{ name }` → `{ key, token }` |
| GET | `/api/arenas/:slug/keys/:id` | admin | the key itself, for copying → `{ key, token }` (409 if it can't be shown again) |
| DELETE | `/api/arenas/:slug/keys/:id` | admin | revoke a key; agents using it get 401 at once |
| GET | `/api/arenas/:slug/agents` | read | list agents |
| PUT | `/api/arenas/:slug/agents/:key` | ingest | register or update the profile (`displayName`, `role`, `appearance`, `ttlSeconds`, `metadata`); idempotent |
| GET | `/api/arenas/:slug/agents/:key` | read | the agent with its full answer, plus its last 20 events |
| DELETE | `/api/arenas/:slug/agents/:key` | ingest / admin | deregister and free the seat |
| POST | `/api/arenas/:slug/agents/:key/status` | ingest | report state (auto-registers); → `{ applied, agent }` |
| POST | `/api/arenas/:slug/agents/:key/heartbeat` | ingest | refresh `lastSeenAt` (and optionally `ttlSeconds`). `{"leaving": true}` marks the agent away now without touching its status or answer; → `204` |
| GET | `/api/arenas/:slug/events` | read | history, `?agent=&before=&limit=` (cursor on `id`, newest first) |
| GET | `/api/stream` | owner / admin | SSE over accessible arenas. Filter with `?arenas=career,personal` |
| GET | `/api/cron/maintenance` | `CRON_SECRET` bearer | daily cleanup, called by Vercel Cron |

`slug` and `key` match `^[a-z0-9][a-z0-9._-]{0,63}$`. The slug `new` is reserved, because `/arenas/new` is the creation page.

### Example

```bash
curl -X POST "$ARENA_URL/api/arenas/career/agents/resume-writer/status" \
  -H "Authorization: Bearer $ARENA_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"done","activity":"Tailored resume for Acme","result":"## Summary\n- ...","session":"run-42","seq":1764000000000}'
```

### SSE stream (`/api/stream`)

**Every connection starts from a fresh snapshot.** Reconnects stay correct whatever was pruned, deleted or created while the client was away. After the snapshot, the connection follows a change feed in Postgres:

- **The feed.** Every write that changes what the UI shows also inserts its stream message into a `changes` table, in the same transaction, keyed by `seq` (the global change counter). Writes commit in counter order (see "Writes are serialized"), so once a reader sees change N, every change below N has committed too.
- **On each connection:** read the snapshot in one `REPEATABLE READ`, read-only transaction (the arenas, their agents and the counter value `seq`), send it as the first message `snapshot` `{ seq, arenas[], agents[], serverTime }`, then poll `changes` for `seq > cursor` every second (`ARENA_STREAM_POLL_MS`) and send the matching messages in order. Every server instance reads the same table, so it doesn't matter which instance took a write.
- **Pruning.** The feed keeps an hour of changes. A counter records the highest pruned `seq`; a connection whose cursor falls below it (it was too slow for an hour) gets a fresh snapshot instead of a gap.
- **Time limit.** Vercel ends a function after `maxDuration` (300 s). Each stream sends `{ "type": "reconnect" }` after 240 s (`ARENA_STREAM_SECONDS`) and ends; the browser reopens it at once and starts from a fresh snapshot.

On every reconnect (EventSource's own, or after `reconnect`), the client replaces its whole state with the new `snapshot`. Messages carry no `id:` lines, so `Last-Event-ID` is never used.

- Message types: `snapshot`, `agent.upserted` (the agent JSON), `agent.removed`, `arena.upserted`, `arena.removed`, `presence` (`{ seq, arena, key, lastSeenAt, awaySince, ttlSeconds }`), `reconnect`, and a `: ping` comment every 15 s.
- **Stale-message rule:** the client drops any message at or below the snapshot's `seq`, and applies an agent message only if its `version` is higher than the one it holds. The feed already delivers in commit order; the rule keeps the client correct across snapshots and reconnects anyway. Presence fields are merged separately, and the newest `lastSeenAt` wins; presence that arrives before an agent's first upsert is held until it shows up.
- Stream messages carry `resultPreview` (the first 280 chars), `hasResult` and `resultTruncated`, not the full answer. The drawer fetches the full answer from `GET /api/arenas/:slug/agents/:key`. A snapshot of 100 agents stays small.
- The poll loop, ping, lifetime and session-expiry timers stop when `request.signal` aborts.
- **Shutdown:** Next's graceful shutdown waits for open responses. On `SIGTERM`/`SIGINT` the server ends every open stream and answers new stream requests with `503` (`Retry-After: 3`), since a browser can reconnect over a kept-alive socket while the server drains. Browsers then reconnect to the restarted server (or another instance) from a fresh snapshot.
- **Robustness:** a client that stops reading is dropped once 4 MB is queued for it (it reconnects and catches up). `HEAD /api/stream` runs the checks without opening a stream (the client uses it to tell "logged out" from "server down").
- The overview page (all arenas) and the arena page (one arena) use this one endpoint, so both get a consistent view read in one transaction.

---

## UI

### Pages
- **`/` Overview**: one card per arena with a small live scene thumbnail and the counts. The **Needs you** badge comes first. One SSE connection covers all arenas, and its snapshot includes the arena list, so arenas created or deleted during a disconnect show correctly.
- **`/arenas/[slug]`**: the scene, plus a side panel grouped as *Needs you · Working · Waiting · Done · Error · Idle*. Away agents stay in their group, dimmed, with "last seen"; `working` + away shows **Stalled?**. A **Scene / List** toggle; the list view is the accessible fallback and is better with many agents.
- **Agent drawer** (opened by clicking a sprite or a list row): status, activity, how long it has been in this state, the sanitized markdown answer with a copy button (and a "truncated" notice when needed), and an event timeline. Owner action: **Acknowledge**, which sets a `done` agent back to `idle` once you've read it. The action sends the `version` the drawer is showing and only applies if the agent is still at that version. If a newer answer arrived while the drawer was open, it is not cleared, and the drawer shows "New answer arrived" instead.
- **`/arenas/[slug]/settings`**: rename, change theme; API keys (create named keys, copy any key again, revoke one, with a ready-made curl snippet); remove agents.
- **`/arenas/new`**.
- **`/login`**: the password form, or in Supabase mode the email form. Once a link is sent, the form becomes a "check your inbox" view with a resend countdown, and the waiting tab moves on when the link signs that browser in. The emailed link lands on the route handler `/auth/confirm`.

### Scene rendering
- **DOM + CSS**, not canvas or WebGL. The scene is a fixed logical resolution (for example 384×216) scaled up by an integer factor with `image-rendering: pixelated`. Each agent is an absolutely positioned `<button>` (clickable, focusable, with an aria-label) whose sprite sheet animates with CSS `steps()`. Movement is a CSS `transform` transition, with the walk pose shown while it moves. Depth order comes from the y coordinate. This handles the expected scale (up to 100 agents) and keeps bubbles, tooltips and accessibility simple.
- **Layout is a pure function**: `layoutScene(theme, agents, now) → Placement[]` (position, pose, bubble, z, dimmed). It is unit-tested and has no DOM.
- **State → scene mapping** (the office wording is shown; each theme supplies its own wording):

| Status | Office | Kitchen | Bubble |
|---|---|---|---|
| working | at own desk, typing | at own station, chopping/stirring | activity text on hover; progress bar |
| waiting | walks to the coffee corner (spot slots; at desk if those are full) | stands at the pantry | `…` (or a red `!` for **Needs you**) + `waitingFor` |
| done | at desk, leaning back, paper on desk | plate on the pass, bell | ✓ (pulses until acknowledged) |
| error | at desk, slumped | smoke from the pan | red `!` + error |
| idle | at desk, idle | leaning on the counter | none |

**Presence on top of status:** an away agent is drawn dimmed, with "last seen" on hover, and keeps its status pose and bubble. `working` + away adds a `?` bubble (Stalled?). `idle` + away shows an empty desk or station with a dimmed nameplate, since there is nothing to show.

- **Seats:** each theme defines an ordered list of home stations. Past that capacity, the scene adds rows from a repeating desk or station strip and grows taller. Seats don't move when other agents come and go.
- `prefers-reduced-motion`: no walking or bobbing; sprites snap into place.

### Art
- A theme is data: `{ id, size, background, seats[], waitingSpots[], props[], poses, copy }` in `src/scene/themes/<id>.ts`.
- **v1 ships code-defined placeholder pixel art**: palette-indexed grids in TypeScript for one character base (16×24, poses `idle`, `walk`, `work`, `wait`, `done`, `error`) and about 12 tiles per theme. They are drawn once onto an offscreen canvas and cached as sprite-sheet URLs. Each agent's palette (skin, hair, shirt) comes from a hash of its `key`, so every agent looks different with no assets. All of it is original, with no third-party sprite licenses.
- The renderer reads a `SpriteSheet` interface (`url`, frame size, named animations), so hand-made PNG sheets (Aseprite) can replace the placeholders later without code changes.

---

## Project layout

```
src/
  app/
    page.tsx                         # overview
    login/page.tsx, login/LoginForm.tsx
    auth/confirm/route.ts            # where the emailed sign-in link lands
    arenas/new/page.tsx
    arenas/[slug]/page.tsx           # scene + panel
    arenas/[slug]/settings/page.tsx
    api/health/route.ts
    api/stream/route.ts
    api/arenas/route.ts
    api/arenas/[slug]/route.ts
    api/arenas/[slug]/keys/route.ts, keys/[id]/route.ts
    api/arenas/[slug]/agents/route.ts
    api/arenas/[slug]/agents/[key]/route.ts
    api/arenas/[slug]/agents/[key]/status/route.ts
    api/arenas/[slug]/agents/[key]/heartbeat/route.ts
    api/arenas/[slug]/events/route.ts
    api/cron/maintenance/route.ts    # daily cleanup (Vercel Cron)
  proxy.ts                           # page-only login redirect
  server/
    env.ts                           # zod-validated env, fail fast
    db/schema.ts, db/client.ts       # drizzle pg-core; postgres-js or PGlite; writeTx (counter lock)
    auth.ts                          # credential resolution, owner session
    session.ts                       # the password-mode session cookie
    supabase-auth.ts                 # Supabase sign-in links and sessions
    arenas.ts, agents.ts, events.ts, keys.ts  # services: all business rules live here
    feed.ts                          # change feed: emit in the write's transaction, read, prune
    snapshot.ts                      # the stream's REPEATABLE READ snapshot
    rate-limit.ts                    # per-token rate limit and login throttle, in Postgres
    http.ts                          # error envelope, body-size guard
    actions.ts, arena-actions.ts     # Server Actions for UI mutations (each checks the owner session)
  scene/
    themes/office.ts, themes/kitchen.ts
    sprites/                         # palette grids + sheet builder
    layout.ts                        # pure layout function
    Scene.tsx, AgentSprite.tsx, Bubble.tsx
  components/                        # panel, drawer, cards
  lib/
    schemas.ts                       # shared zod schemas + types
    client.ts                        # tiny typed client (fetch wrapper)
    safe-next.ts                     # keeps the after-login return path inside the app
drizzle/                             # migrations (Postgres)
scripts/
  simulate.ts                        # fake agents cycling through states
  migrate.ts                         # create/upgrade the database
  arena-report.mjs                   # CLI reporter (Node, no dependencies)
  install-skill.sh                   # links the skill into Claude Code and Codex
  smoke-api.sh                       # curl walk-through of the API
examples/
  claude-code-hooks/                 # settings.json + hook script
  codex-notify/                      # notify script
skills/
  arena-presence/                    # skill that teaches an agent to report for itself
```

Route handlers stay thin: parse, authenticate, call a service, serialize. Services hold all the rules, so they can be tested without HTTP.

---

## Delivery phases

Each phase ends with a demo and passing tests.

### Phase 0: Scaffold
`create-next-app` (TS, App Router, Tailwind, ESLint, `src/`), pnpm, Vitest, Playwright, Drizzle config, `env.ts`, `.env.example`, and scripts `dev`, `db:migrate`, `test`, `simulate`.
**Done when:** `pnpm dev` serves the page and `pnpm test` passes.

### Phase 1: Data + API
Schema and migrations, services, auth, every endpoint above except `/api/stream`, the error envelope, limits and the rate limiter.
**Tests:**
- Auth matrix: a token from arena A gets 403 in arena B; a cookie on a write gets 401; with an owner password set, an arena API key can still `GET` its own arena and `/api/health` stays open.
- Upsert idempotency and seat stability. Concurrent first reports: N parallel auto-registrations never share a seat and never exceed the cap.
- Ordering: no `seq`; a new session resets the watermark; a tie is superseded; a superseded report is stored with what was submitted.
- Status/field validation; a 100 KB `result` is truncated and `done` still applies; a body over 256 KB gets 413.
- Auto-registration; `leaving` heartbeat keeps status and answer; deleting an arena cascades; retention pruning.

**Done when:** a curl script creates two arenas, registers agents in both and moves them through every status, and `GET` shows the right snapshots.

### Phase 2: Live list dashboard (no art yet)
`/api/stream` with snapshot-on-connect, the overview page, the arena page in List mode, the agent drawer with sanitized markdown and the timeline, login with throttling, Server Actions, and `scripts/simulate.ts`.
**Tests:**
- Stream: connect; disconnect; meanwhile delete an agent, delete one arena, create another and send a heartbeat; reconnect → the snapshot matches the database exactly.
- Messages published out of order (version 6 before 5) leave the client at version 6.
- An unauthenticated same-origin Server Action call changes nothing, including with anonymous read on.
- Acknowledge with a stale version leaves the newer answer in place.
- A markdown XSS payload renders inert; repeated wrong passwords get throttled.
- A server restart: the page shows "reconnecting", then catches up from a fresh snapshot (Playwright, against a production build).
- The live pages read no data while rendering (it all comes from the stream), so the "data written after `next build`" check moves to Phase 4, where the settings page reads the database.

**Done when:** with the simulator running, the UI updates in under 1 s without a reload; after a server restart the client reconnects and is correct.

### Phase 3: Office scene
The sprite system and placeholder art, the office theme, `layoutScene`, animations, bubbles, the Scene/List toggle, reduced motion.
**Tests:** `layoutScene` unit tests (seat stability, waiting-spot overflow, away dimming without status loss, Stalled?, z-order). Playwright: report `waiting` with a reason → the sprite ends in the coffee-corner zone and shows the reason; then report `done` with a result → click the sprite → the drawer shows the answer.

### Phase 4: Multi-arena polish + kitchen
The kitchen theme, overview thumbnails, the settings page (Server Actions: create arena, create/copy/revoke named API keys, rename, change theme, remove agent), the new-arena page. Acknowledge shipped in Phase 2 with the drawer.
**Tests:** every settings action refuses a caller without the owner session; the settings page, rendered by a production build, shows data written after `next build`.

### Phase 5: Integrations
`lib/client.ts` (typed client; fills in `session` and a strictly increasing `seq`), the `scripts/arena-report.mjs` CLI (Node with no dependencies rather than POSIX shell, because shell can't JSON-encode arbitrary answers safely), and examples. The CLI shrinks `result` until the JSON body fits the request limit (JSON escaping can make an answer much bigger than its text) and marks it cut, so a long answer still delivers `done`. Hooks never fail or block the agent: errors go to stderr and the exit code is 0.
- **Claude Code hooks** (every report sends `session` = the hook's `session_id` and `seq` = epoch ms):
  - `UserPromptSubmit` → `working` (activity = the prompt, truncated).
  - `Notification` with matcher `permission_prompt|elicitation_dialog` → `waiting` with `waitingOn: human`. Other notification types (`idle_prompt`, `auth_success`, ...) change nothing.
  - `Stop` → `done` (result = the last assistant message).
  - `SessionEnd` → heartbeat with `{"leaving": true}`. The agent shows as away and its answer stays.
- **Codex `notify`:** `agent-turn-complete` → `done` with `last-assistant-message`.
- A README with the curl recipes.

### Phase 6: Deploy + hardening
Arena uses Drizzle with Supabase Postgres in development and on Vercel. The counter row lock serializes writes. Each stream polls the `changes` feed and sends `reconnect` before `maxDuration`. Postgres stores rate limits and the login throttle. Vercel runs migrations during the build and calls `/api/cron/maintenance` daily with `CRON_SECRET` to prune events, feed entries, and throttle records. Writes also prune old events. Arena rejects embedded databases on Vercel and logs each API request.
**Tests:** the unit suite on PGlite and on a real Postgres (`TEST_DATABASE_URL`); the stream follows writes made through another connection, resnapshots after the feed is pruned past its cursor, and sends `reconnect` at its time limit; concurrent writes never share a seat or a `seq`; Playwright against `next build && next start`, including a server restart.

---

## Deployment

**Vercel + Supabase.** Every request may run on a different, short-lived instance, so nothing lives in memory between requests:

1. **Data** is in Supabase's Postgres, reached through the transaction pooler (port 6543), which suits connections opened and dropped by serverless functions. Prepared statements are off for it; each instance opens at most `ARENA_DB_POOL_SIZE` (5) connections.
2. **Live updates** come from the `changes` feed, which every instance can read (see SSE).
3. **Long-lived streams** don't exist on Vercel: each one ends with `reconnect` after 240 s and the browser reopens it.
4. **Throttles** are rows in Postgres.
5. **Migrations** run in the build (`vercel.json`: `pnpm db:migrate && pnpm build`), before the new version goes live, so they must keep the previous version working. The app doesn't migrate on a cold start (`ARENA_AUTO_MIGRATE=1` turns that on); an embedded PGlite database migrates itself when opened.
6. **Housekeeping** is a daily Vercel Cron call to `/api/cron/maintenance` with `CRON_SECRET`.
7. **Backups** are Supabase's, plus `pg_dump` through the session pooler or a direct connection.

The app is still plain Next.js and plain Postgres, so `pnpm db:migrate && pnpm build && pnpm start` runs it on any Node host. PGlite is refused in production (and always on Vercel, whose disk doesn't last) unless `ARENA_ALLOW_EMBEDDED_DB=1`, which the e2e tests set.

## Risks

| Risk | Mitigation |
|---|---|
| Placeholder art looks rough | Art lives behind the `SpriteSheet` and theme interfaces; replace it later. The list view works whatever the art looks like |
| An agent goes quiet, or exits after finishing | Presence is separate from status: away dims the agent but never hides its answer or request; `working` + away is flagged Stalled? |
| Reports arrive out of order | The optional `session` + `seq` guard on the server; the per-agent `version` on the client |
| Changes happen while the browser is disconnected | Every connection starts from a fresh snapshot; nothing depends on replaying history |
| Sensitive answers exposed | A login (Supabase account or owner password) is required in production unless anonymous read is turned on; every Server Action checks the session; login is throttled; API keys are scoped per arena, revocable one by one, and encrypted at rest; markdown is sanitized with images off |
| Event table grows | Retention caps; history isn't used for replay, so pruning is safe; `result` is only kept on `done` reports |
| Feed table grows | An hour of retention, pruned daily; a stream that falls behind the pruned point starts over from a snapshot |
| Each open dashboard keeps a function running and polls once a second | Polls are one indexed query; streams end every 240 s; a client that stops reading is dropped at 4 MB of backlog. Raise `ARENA_STREAM_POLL_MS` to trade latency for load |
| A migration breaks the version still serving | Migrations run before the new version is live; keep them additive and drop old columns a release later |
| Preview deployments migrate a shared database | Give Preview deployments their own `DATABASE_URL` (or none) |

## Future (not v1)

- **Reply to waiting agents:** `POST /api/arenas/:slug/agents/:key/inbox` from the UI, and `GET …/inbox?wait=30` long-poll for the agent.
- Tasks as first-class objects (several jobs per agent, each with its own answer).
- Agent-to-agent handoff shown as walking between desks.
- Sound cues, desktop notifications for **Needs you**.
- More themes (workshop, lab, garden).
