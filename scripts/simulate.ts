/**
 * Fake agents for development: creates a "career" office and a "personal" kitchen (if missing) and
 * keeps their agents cycling through working → waiting → done (and the odd error).
 *
 *   ARENA_URL=http://localhost:3000 ARENA_ADMIN_TOKEN=... pnpm simulate [--once] [--fast]
 *
 * --once seeds one state per agent and exits. --fast speeds everything up (for demos and e2e tests).
 * Reads .env / .env.local like Next does, so ARENA_ADMIN_TOKEN can live there.
 */
import { loadEnvConfig } from "@next/env";

// Same files `next dev` reads (or `next start` when NODE_ENV=production).
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

type Status = "idle" | "working" | "waiting" | "done" | "error";

const BASE = (process.env.ARENA_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = process.env.ARENA_ADMIN_TOKEN;
// The admin token is rate limited like any token; space requests out a little when seeding.
const once = process.argv.includes("--once");
const fast = process.argv.includes("--fast");

if (!ADMIN) {
  console.error("Set ARENA_ADMIN_TOKEN (the admin token can report for any arena).");
  process.exit(2);
}

const ARENAS = [
  {
    slug: "career",
    name: "Career",
    theme: "office",
    agents: [
      ["resume-writer", "Resume Writer", "Tailors your resume to each job"],
      ["job-scout", "Job Scout", "Finds roles that match your profile"],
      ["interview-coach", "Interview Coach", "Prepares answers and mock questions"],
      ["email-drafter", "Email Drafter", "Writes follow-ups and thank-you notes"],
      ["linkedin-polisher", "LinkedIn Polisher", "Keeps your profile sharp"],
    ],
  },
  {
    slug: "personal",
    name: "Personal",
    theme: "kitchen",
    agents: [
      ["meal-planner", "Meal Planner", "Plans the week's dinners"],
      ["budget-bot", "Budget Bot", "Tracks spending against the budget"],
      ["travel-agent", "Travel Agent", "Finds trips and books them"],
      ["gardener", "Gardener", "Reminds you what to water"],
    ],
  },
] as const;

const ACTIVITIES = [
  "Reading the job description",
  "Comparing three options",
  "Drafting the first version",
  "Checking facts",
  "Summarising findings",
  "Searching listings",
  "Polishing the wording",
];
const WAITS: Array<[string, string]> = [
  ["human", "your approval to send"],
  ["human", "which option you prefer"],
  ["agent", "Job Scout's shortlist"],
  ["external", "the API rate limit to reset"],
  ["external", "CI to finish"],
];

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function answerFor(name: string): string {
  return [
    `## ${name}: done`,
    "",
    `Finished at ${new Date().toLocaleTimeString()}.`,
    "",
    "- Looked at **3** options",
    "- Picked the one with the best fit",
    "- Notes are below",
    "",
    "| Option | Score |",
    "|---|---|",
    "| A | 8/10 |",
    "| B | 6/10 |",
    "",
    "```",
    "next step: review and approve",
    "```",
  ].join("\n");
}

async function report(slug: string, key: string, name: string, status: Status, { strict = false } = {}) {
  const body: Record<string, unknown> = { status, displayName: name, session: "simulator", seq: Date.now() };
  if (status === "working") {
    body.activity = pick(ACTIVITIES);
    body.progress = Math.round(Math.random() * 100) / 100;
  } else if (status === "waiting") {
    const [on, why] = pick(WAITS);
    body.waitingOn = on;
    body.waitingFor = why;
  } else if (status === "done") {
    body.activity = "Finished";
    body.result = answerFor(name);
  } else if (status === "error") {
    body.error = "Upstream API returned 503";
  }
  const res = await api("POST", `/api/arenas/${slug}/agents/${key}/status`, body);
  if (res.ok) {
    console.log(`${slug}/${key} → ${status}`);
    return;
  }
  const message = `${slug}/${key} ${status}: HTTP ${res.status} ${await res.text()}`;
  // Seeding must succeed; once it is running, one failed report shouldn't stop the show.
  if (strict) throw new Error(message);
  console.error(message);
}

const NEXT: Record<Status, Status[]> = {
  idle: ["working"],
  working: ["working", "waiting", "done", "done", "error"],
  waiting: ["working", "done"],
  done: ["idle", "working"],
  error: ["working", "idle"],
};

async function main() {
  for (const arena of ARENAS) {
    const res = await api("POST", "/api/arenas", { slug: arena.slug, name: arena.name, theme: arena.theme });
    if (res.status === 201) console.log(`created arena ${arena.slug}`);
    else if (res.status !== 409) throw new Error(`creating ${arena.slug}: HTTP ${res.status} ${await res.text()}`);
    for (const [key, name, role] of arena.agents) {
      const res = await api("PUT", `/api/arenas/${arena.slug}/agents/${key}`, { displayName: name, role });
      if (!res.ok) throw new Error(`registering ${arena.slug}/${key}: HTTP ${res.status} ${await res.text()}`);
    }
  }

  const state = new Map<string, Status>();
  const all = ARENAS.flatMap((a) => a.agents.map(([key, name]) => ({ slug: a.slug, key, name })));
  for (const agent of all) {
    const status = pick<Status>(["working", "working", "waiting", "done", "idle"]);
    state.set(`${agent.slug}/${agent.key}`, status);
    await report(agent.slug, agent.key, agent.name, status, { strict: true });
  }
  if (once) return;

  for (;;) {
    await sleep(fast ? 300 + Math.random() * 400 : 1500 + Math.random() * 2500);
    const agent = pick(all);
    const id = `${agent.slug}/${agent.key}`;
    const next = pick(NEXT[state.get(id) ?? "idle"]);
    state.set(id, next);
    await report(agent.slug, agent.key, agent.name, next);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
