// Shared by the server, the browser and the scripts. Keep it free of Node-only imports.

export const STATUSES = ["idle", "working", "waiting", "done", "error"] as const;
export type Status = (typeof STATUSES)[number];

export const WAITING_ON = ["human", "agent", "external"] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

export const THEMES = ["office", "kitchen"] as const;
export type ThemeId = (typeof THEMES)[number];

export const EVENT_TYPES = [
  "agent.registered",
  "agent.status",
  "agent.updated",
  "agent.acknowledged",
  "agent.removed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const LIMITS = {
  bodyBytes: 256 * 1024,
  resultBytes: 64 * 1024,
  resultPreviewChars: 280,
  activityChars: 200,
  waitingForChars: 200,
  errorBytes: 2048,
  displayNameChars: 80,
  roleChars: 200,
  arenaNameChars: 80,
  metadataBytes: 4096,
  arenasPerUser: 8,
  agentsPerArena: 100,
  keysPerArena: 50,
  keyNameChars: 40,
  eventsPerAgent: 100,
  eventMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_TTL_SECONDS = 900;
export const MIN_TTL_SECONDS = 10;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** `/arenas/new` is the creation page, so no arena may take that slug. */
export const RESERVED_SLUGS: readonly string[] = ["new"];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Appearance = {
  seed?: string;
  palette?: Partial<Record<"skin" | "hair" | "shirt" | "pants", string>>;
};

export type ArenaPublic = {
  id: string;
  slug: string;
  name: string;
  theme: ThemeId;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentPublic = {
  id: string;
  arenaId: string;
  arena: string;
  key: string;
  displayName: string;
  role: string | null;
  appearance: Appearance | null;
  status: Status;
  activity: string | null;
  waitingOn: WaitingOn | null;
  waitingFor: string | null;
  progress: number | null;
  hasResult: boolean;
  resultPreview: string | null;
  resultTruncated: boolean;
  error: string | null;
  seat: number;
  /** Rises on every applied change. Comes from one global counter, so it also orders a re-registration after a removal. */
  version: number;
  ttlSeconds: number;
  lastSeenAt: string;
  awaySince: string | null;
  statusChangedAt: string;
  createdAt: string;
  metadata: JsonValue | null;
};

export type AgentDetail = AgentPublic & { result: string | null };

export type AgentEvent = {
  id: number;
  agentKey: string;
  type: EventType;
  applied: boolean;
  report: Record<string, unknown> | null;
  agentVersion: number | null;
  createdAt: string;
};

export type StatusCounts = {
  needsYou: number;
  working: number;
  waiting: number;
  done: number;
  error: number;
  idle: number;
  away: number;
  total: number;
};

export type ArenaSummary = ArenaPublic & { counts: StatusCounts };

/** An API key as listed: never includes the key itself. */
export type ApiKeyPublic = {
  id: string;
  name: string;
  /** The key's first characters, e.g. "arena_x7Kd…". */
  prefix: string;
  /** False when the key can't be shown again (see the api_keys table). */
  copyable: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export type StreamSnapshot = {
  type: "snapshot";
  seq: number;
  serverTime: string;
  arenas: ArenaPublic[];
  agents: AgentPublic[];
};

export type PresenceMessage = {
  type: "presence";
  seq: number;
  arenaId: string;
  agentId: string;
  key: string;
  lastSeenAt: string;
  awaySince: string | null;
  ttlSeconds: number;
};

export type StreamMessage =
  | StreamSnapshot
  | { type: "agent.upserted"; seq: number; agent: AgentPublic }
  | { type: "agent.removed"; seq: number; arenaId: string; agentId: string; key: string }
  | { type: "arena.upserted"; seq: number; arena: ArenaPublic }
  | { type: "arena.removed"; seq: number; arenaId: string; slug: string }
  | PresenceMessage
  /** The server is about to end this connection (a platform time limit): reconnect now, quietly. */
  | { type: "reconnect" };

export type Presence = "live" | "away";

export function presenceOf(
  agent: Pick<AgentPublic, "lastSeenAt" | "awaySince" | "ttlSeconds">,
  nowMs: number,
): Presence {
  if (agent.awaySince) return "away";
  return nowMs - Date.parse(agent.lastSeenAt) > agent.ttlSeconds * 1000 ? "away" : "live";
}

/** The panel groups. Every agent is in exactly one; presence is shown on top, never as a group. */
export const GROUPS = ["needsYou", "working", "waiting", "done", "error", "idle"] as const;
export type Group = (typeof GROUPS)[number];

export function groupOf(agent: Pick<AgentPublic, "status" | "waitingOn">): Group {
  if (agent.status === "waiting" && agent.waitingOn === "human") return "needsYou";
  return agent.status;
}

export type CountableAgent = Pick<AgentPublic, "status" | "waitingOn" | "lastSeenAt" | "awaySince" | "ttlSeconds">;

export function countAgents(agents: CountableAgent[], nowMs: number): StatusCounts {
  const counts: StatusCounts = {
    needsYou: 0,
    working: 0,
    waiting: 0,
    done: 0,
    error: 0,
    idle: 0,
    away: 0,
    total: agents.length,
  };
  for (const agent of agents) {
    counts[groupOf(agent)] += 1;
    if (presenceOf(agent, nowMs) === "away") counts.away += 1;
  }
  return counts;
}
