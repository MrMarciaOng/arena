---
name: arena-presence
description: Puts you on the user's Arena dashboard (a pixel-art board of their AI agents) while you work: registers you as an agent, keeps your status text current (working on X, waiting on the user, blocked, done with the answer, error, standing by), and removes you from the arena when the session is finished. Use it whenever Arena is configured (ARENA_URL / ARENA_TOKEN / ARENA_SLUG in the environment, or ~/.config/arena/env exists), whenever the user mentions Arena, the arena or agent dashboard, or asks you to report your status, show what you're working on, check in to their career/personal arena, or leave/clean up the arena, and when wrapping up a session in which you have been reporting.
---

# Arena presence

Arena is the user's dashboard of AI agents. Each arena (for example a "Career" office or a "Personal" kitchen) shows every agent as a character: at its desk while **working**, at the coffee corner while **waiting**, with a ✓ and its answer when **done**, with a red **!** when it **needs the user**. The user glances at it to see, across all their sessions, who is busy, who is blocked on them, and what each one produced.

Your job with this skill is to keep your own card truthful with a few cheap calls, and to never let reporting get in the way of the actual work.

## The tool

Everything goes through one script in this skill's directory. Call it by its full path every time:

```bash
node <this skill's directory>/scripts/arena-report.mjs <agent-key> <command> [options]
```

Below, `arena-report` is short for that whole `node .../scripts/arena-report.mjs` command. Write it out in full in each call: don't put it in a shell variable (`$ARENA ...` fails in zsh, which doesn't split it into words), and don't rely on shell variables, functions or `export` at all, because each of your tool calls usually runs in a fresh shell. For the same reason, remember your agent key yourself and type it literally in each command. If the user gave you a config file path, put `ARENA_CONFIG=<path>` in front of each call.

It needs Node 18+ and nothing else. It exits 0 even when a call fails (it prints the problem to stderr), so a broken dashboard can't break your work. Add `--strict` only when you want a non-zero exit, as in the setup check below.

## 1. Check the setup, once per session

```bash
arena-report check --strict
# ok: arena "Career" (career), 3 agents
```

If it isn't configured or can't connect, tell the user once, in one or two lines, how to fix it (see `references/setup.md`), then carry on with the task without reporting. Don't keep retrying or asking.

**Codex:** a sandbox without network access makes every call fail with "could not reach Arena". Ask once to run the check with network access; if that's not allowed, skip reporting for this session.

## 2. Pick your agent key and register

```bash
arena-report new-key --tool claude          # or --tool codex; prints e.g. claude-arena-k3x9
arena-report claude-arena-k3x9 register --name "Claude · arena" --role "Adding the kitchen theme"
```

Make one key per session (run `new-key` from the project folder, which it names the key after), note it, and reuse it for every call; the random suffix keeps two sessions in the same folder from overwriting each other. If `ARENA_AGENT_KEY` is set, use that instead (the user's hooks may already be reporting this session under it). The name is what the user reads on the board: say which tool you are and which project you're in. The role is a one-line description of the job.

Pass `--session <your key>` on every status report. With a session, reports carry an increasing sequence number, so a slow report that arrives late never overwrites a newer one.

## 3. Keep the status true

| When | `arena-report <key> ...` (plus `--session <key>`) | The board shows |
|---|---|---|
| You start a task | `working --activity "Reading the auth module"` | working at the desk |
| You move to a new phase of it | `working --activity "Writing the migration" --progress 0.5` | the new activity, a progress bar |
| You need the user: a question, an approval, a choice. Report **right before** you ask | `waiting --waiting-on human --waiting-for "approve dropping the legacy table"` | **Needs you**, red ! |
| You're blocked on something else | `waiting --waiting-on external --waiting-for "CI run #812"` (or `--waiting-on agent`) | waiting at the coffee corner |
| Something failed and you can't go on | `error --error "3 tests fail in auth.spec.ts"` | error, red ! |
| You finished the task | `done --result-file /tmp/arena-answer.md` (or `--result "..."`) | ✓ and your answer |
| Between tasks, session still open ("lingering") | `idle --activity "Standing by for the next task"` | idle at the desk |
| A long stretch with no report (10+ minutes) | `heartbeat --ttl 1800` | stays live instead of "Stalled?" |
| The session is over | `remove` (see section 5) | the card leaves the arena |

Report at the moments the user would care about, roughly once per phase, not on every file read or command. Six to ten reports for a substantial task is plenty. When the user answers your question and you resume, report `working` again so the red ! goes away.

An agent the board hasn't heard from in 15 minutes is drawn as away, and one that was working is flagged **Stalled?**. That's why long silent work deserves a heartbeat.

## 4. Writing the text

- **activity**: present tense, specific, at most 200 characters. "Tailoring the resume to the Acme job description", not "Working on stuff".
- **waiting-for**: the question in a few words, so the user can decide from the board.
- **result**: a markdown answer the size of a good chat reply: what you did, the outcome, anything the user must do next, and where the files are. Long logs belong in files you point to. Write it to a temp file and use `--result-file` rather than quoting markdown on the command line.
- Never put secrets, tokens, credentials or private data in any of these. The dashboard keeps a history and may be shown to others. Summarise the user's private instructions rather than pasting them.

## 5. Finishing: remove yourself

The session is over when the user says so ("that's all", "thanks, we're done", "wrap up"), asks you to leave or clean up the arena, or you've delivered the last task and the user is closing out. Then:

1. Report `done` with the final answer, if you haven't already for this task. The answer stays in the arena's history after the card goes.
2. Run `arena-report <key> remove`. The character leaves and its seat frees up.

If the user wants the last answer to stay visible on the board, use `heartbeat --leaving` instead of `remove`: the card stays, dimmed as away, with its answer.

You get no turn after the user exits the app, so you can't remove yourself after the fact. If the user wants it to happen on exit automatically, point them to the Claude Code hook in `references/setup.md` (`ARENA_ON_SESSION_END=remove`).

## 6. Keep reporting out of the way

- A failed report isn't worth more than one line to the user. Note it once and keep working; don't retry in a loop.
- Don't wait on the dashboard to make a decision, and don't change your plan to make the board look busier.
- To report to a different arena than the configured one, add `--arena <slug>`. The key must belong to that arena.

## Example: a whole session

Each line is a separate tool call; `S` stands for the full path `<skill-dir>/scripts/arena-report.mjs`.

```bash
node S check --strict
node S new-key --tool claude                          # → claude-arena-k3x9 (remember it)
node S claude-arena-k3x9 register --name "Claude · arena" --role "Fix the flaky login test"
node S claude-arena-k3x9 working --session claude-arena-k3x9 --activity "Reproducing the flaky login test"
node S claude-arena-k3x9 working --session claude-arena-k3x9 --activity "Fixing a race in the session refresh" --progress 0.6
node S claude-arena-k3x9 waiting --session claude-arena-k3x9 --waiting-on human --waiting-for "OK to change the retry timeout to 5 s?"
# ...the user says yes...
node S claude-arena-k3x9 working --session claude-arena-k3x9 --activity "Applying the timeout change, running the suite"
node S claude-arena-k3x9 done --session claude-arena-k3x9 --result-file /tmp/arena-answer.md
# ...the user: "great, that's all for today"
node S claude-arena-k3x9 remove
```
