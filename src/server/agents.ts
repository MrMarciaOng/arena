import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  DEFAULT_TTL_SECONDS,
  LIMITS,
  type AgentDetail,
  type AgentEvent,
  type AgentPublic,
} from "@/lib/domain";
import type { HeartbeatInput, RegisterAgentInput, StatusInput } from "@/lib/schemas";
import { getDb, nextSeq, writeTx, type Tx } from "./db/client";
import { agents, arenas, events, type AgentRow, type ArenaRow } from "./db/schema";
import { ApiError, notFound } from "./errors";
import { appendEvent, maybePruneArena } from "./events";
import { emit } from "./feed";
import { toAgentDetail, toAgentPublic, toEvent, toPresence } from "./serialize";

// ---------- pure helpers (unit-tested directly) ----------

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // bytes[end] is the first byte left out. If it continues a character, back up to that character's start.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export type OrderingState = { session: string | null; seqWatermark: number | null };

/**
 * The ordering guard (see docs/PLAN.md, "Status update semantics"):
 * 1. no seq: apply, watermark unchanged;
 * 2. different session: apply, watermark resets to this seq;
 * 3. same session, seq above the watermark: apply, watermark = seq;
 * 4. same session, seq at or below the watermark (ties included): superseded.
 */
export function decideOrdering(
  current: OrderingState,
  report: { session?: string; seq?: number },
): OrderingState & { applied: boolean } {
  if (report.seq === undefined) return { applied: true, ...current };
  const session = report.session ?? null;
  if (session !== current.session) return { applied: true, session, seqWatermark: report.seq };
  if (current.seqWatermark === null || report.seq > current.seqWatermark) {
    return { applied: true, session, seqWatermark: report.seq };
  }
  return { applied: false, ...current };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// ---------- internals ----------

async function findAgentTx(tx: Tx, arenaId: string, key: string): Promise<AgentRow | undefined> {
  const rows = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.arenaId, arenaId), eq(agents.key, key)))
    .for("update");
  return rows[0];
}

/**
 * Re-reads the arena inside the write transaction. Deleting an arena also takes the write lock,
 * so once this succeeds the arena can't disappear before we commit.
 */
async function lockedArena(tx: Tx, arenaId: string): Promise<ArenaRow> {
  const rows = await tx.select().from(arenas).where(eq(arenas.id, arenaId));
  if (!rows[0]) throw notFound("arena");
  return rows[0];
}

async function allocateSeat(tx: Tx, arenaId: string): Promise<number> {
  const taken = await tx
    .select({ seat: agents.seat })
    .from(agents)
    .where(eq(agents.arenaId, arenaId))
    .orderBy(asc(agents.seat));
  if (taken.length >= LIMITS.agentsPerArena) {
    throw new ApiError(409, "arena_full", `an arena holds at most ${LIMITS.agentsPerArena} agents`);
  }
  let seat = 0;
  for (const row of taken) {
    if (row.seat !== seat) break;
    seat += 1;
  }
  return seat;
}

type Profile = {
  displayName: string;
  role: string | null;
  appearance: AgentRow["appearance"];
  ttlSeconds: number;
  metadata: AgentRow["metadata"];
};

function profileFrom(key: string, input: RegisterAgentInput): Profile {
  return {
    displayName: input.displayName ?? key,
    role: input.role ?? null,
    appearance: input.appearance ?? null,
    ttlSeconds: input.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    metadata: input.metadata ?? null,
  };
}

function profileOf(row: AgentRow): Profile {
  return {
    displayName: row.displayName,
    role: row.role,
    appearance: row.appearance,
    ttlSeconds: row.ttlSeconds,
    metadata: row.metadata,
  };
}

/**
 * Registers a new agent. Runs inside the caller's writeTx(), which holds the global write lock,
 * so the seat and cap checks can't race another registration.
 * `submitted` is what the caller sent (the PUT body), or null when a status report auto-registered it.
 */
async function insertAgent(
  tx: Tx,
  arena: ArenaRow,
  key: string,
  profile: Profile,
  submitted: Record<string, unknown> | null,
  nowMs: number,
): Promise<AgentRow> {
  const seat = await allocateSeat(tx, arena.id);
  const version = await nextSeq(tx);
  const row: AgentRow = {
    id: randomUUID(),
    arenaId: arena.id,
    key,
    ...profile,
    status: "idle",
    activity: null,
    waitingOn: null,
    waitingFor: null,
    progress: null,
    result: null,
    resultTruncated: false,
    error: null,
    seat,
    version,
    session: null,
    seqWatermark: null,
    lastSeenAt: nowMs,
    awaySince: null,
    statusChangedAt: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  await tx.insert(agents).values(row);
  await appendEvent(tx, {
    arenaId: arena.id,
    agentKey: key,
    type: "agent.registered",
    applied: true,
    report: submitted,
    agentVersion: version,
    createdAt: nowMs,
  });
  return row;
}

/** Records the change for live dashboards: the whole agent if it changed, else just its presence. */
async function emitAgent(tx: Tx, arena: ArenaRow, row: AgentRow, changed: boolean, nowMs: number): Promise<void> {
  if (changed) {
    await emit(tx, arena.id, { type: "agent.upserted", seq: row.version, agent: toAgentPublic(row, arena.slug) }, nowMs);
  } else {
    await emit(tx, arena.id, toPresence(row, await nextSeq(tx)), nowMs);
  }
}

// ---------- public service API ----------

/** The id of the agent registered under `key`, without loading its answer. */
export async function agentIdFor(arena: ArenaRow, key: string): Promise<string | undefined> {
  const rows = await (await getDb())
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.arenaId, arena.id), eq(agents.key, key)));
  return rows[0]?.id;
}

export async function listAgents(arena: ArenaRow): Promise<AgentPublic[]> {
  const rows = await (await getDb()).select().from(agents).where(eq(agents.arenaId, arena.id)).orderBy(asc(agents.seat));
  return rows.map((row) => toAgentPublic(row, arena.slug));
}

export async function getAgentDetail(
  arena: ArenaRow,
  key: string,
): Promise<{ agent: AgentDetail; events: AgentEvent[] }> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.arenaId, arena.id), eq(agents.key, key)));
  if (!rows[0]) throw notFound(`agent '${key}'`);
  const recent = await db
    .select()
    .from(events)
    .where(and(eq(events.arenaId, arena.id), eq(events.agentKey, key)))
    .orderBy(desc(events.id))
    .limit(20);
  return { agent: toAgentDetail(rows[0], arena.slug), events: recent.map(toEvent) };
}

/** PUT: registers the agent or replaces its profile. Idempotent: an unchanged profile writes no event. */
export async function registerAgent(
  arenaRef: ArenaRow,
  key: string,
  input: RegisterAgentInput,
  nowMs: number,
  submitted: Record<string, unknown> = { ...input },
): Promise<{ created: boolean; agent: AgentPublic }> {
  const profile = profileFrom(key, input);
  const { row, arena, created } = await writeTx(async (tx) => {
    const arena = await lockedArena(tx, arenaRef.id);
    const current = await findAgentTx(tx, arena.id, key);
    if (!current) {
      const row = await insertAgent(tx, arena, key, profile, submitted, nowMs);
      await emitAgent(tx, arena, row, true, nowMs);
      return { row, arena, created: true };
    }
    const presence = { lastSeenAt: nowMs, awaySince: null, updatedAt: nowMs };
    if (stableStringify(profileOf(current)) === stableStringify(profile)) {
      await tx.update(agents).set(presence).where(eq(agents.id, current.id));
      const row = { ...current, ...presence };
      await emitAgent(tx, arena, row, false, nowMs);
      return { row, arena, created: false };
    }
    const version = await nextSeq(tx);
    await tx.update(agents).set({ ...profile, ...presence, version }).where(eq(agents.id, current.id));
    await appendEvent(tx, {
      arenaId: arena.id,
      agentKey: key,
      type: "agent.updated",
      applied: true,
      report: submitted,
      agentVersion: version,
      createdAt: nowMs,
    });
    const row = { ...current, ...profile, ...presence, version };
    await emitAgent(tx, arena, row, true, nowMs);
    return { row, arena, created: false };
  });
  await maybePruneArena(arena.id, nowMs);
  return { created, agent: toAgentPublic(row, arena.slug) };
}

/** Reports state. Replaces the current state fields; auto-registers an unknown key. */
export async function reportStatus(
  arenaRef: ArenaRow,
  key: string,
  input: StatusInput,
  nowMs: number,
  submitted: Record<string, unknown> = { ...input },
): Promise<{ applied: boolean; created: boolean; agent: AgentPublic }> {
  // Only the agent row is truncated; history keeps the report exactly as submitted, applied or not.
  const answer =
    input.status === "done" && input.result !== undefined
      ? truncateUtf8(input.result, LIMITS.resultBytes)
      : null;
  const report = submitted;

  const { row, arena, applied, created } = await writeTx(async (tx) => {
    const arena = await lockedArena(tx, arenaRef.id);
    let current = await findAgentTx(tx, arena.id, key);
    const created = !current;
    if (!current) {
      current = await insertAgent(
        tx,
        arena,
        key,
        profileFrom(key, { displayName: input.displayName, ttlSeconds: input.ttlSeconds }),
        null,
        nowMs,
      );
    }
    const ordering = decideOrdering(current, input);
    if (!ordering.applied) {
      const presence = { lastSeenAt: nowMs, awaySince: null, updatedAt: nowMs };
      await tx.update(agents).set(presence).where(eq(agents.id, current.id));
      await appendEvent(tx, {
        arenaId: arena.id,
        agentKey: key,
        type: "agent.status",
        applied: false,
        report,
        agentVersion: null,
        createdAt: nowMs,
      });
      const row = { ...current, ...presence };
      await emitAgent(tx, arena, row, created, nowMs);
      return { row, arena, applied: false, created };
    }
    const version = await nextSeq(tx);
    const next = {
      status: input.status,
      activity: input.activity ?? null,
      waitingOn: input.status === "waiting" ? (input.waitingOn ?? null) : null,
      waitingFor: input.status === "waiting" ? (input.waitingFor ?? null) : null,
      progress: input.status === "working" ? (input.progress ?? null) : null,
      result: answer ? answer.text : null,
      resultTruncated: answer?.truncated ?? false,
      error: input.status === "error" ? (input.error ?? null) : null,
      session: ordering.session,
      seqWatermark: ordering.seqWatermark,
      ttlSeconds: input.ttlSeconds ?? current.ttlSeconds,
      lastSeenAt: nowMs,
      awaySince: null,
      statusChangedAt: input.status === current.status ? current.statusChangedAt : nowMs,
      version,
      updatedAt: nowMs,
    } satisfies Partial<AgentRow>;
    await tx.update(agents).set(next).where(eq(agents.id, current.id));
    await appendEvent(tx, {
      arenaId: arena.id,
      agentKey: key,
      type: "agent.status",
      applied: true,
      report,
      agentVersion: version,
      createdAt: nowMs,
    });
    const row = { ...current, ...next } as AgentRow;
    await emitAgent(tx, arena, row, true, nowMs);
    return { row, arena, applied: true, created };
  });
  await maybePruneArena(arena.id, nowMs);
  return { applied, created, agent: toAgentPublic(row, arena.slug) };
}

/** Refreshes presence. `leaving` marks the agent away now; status and answer stay. */
export async function heartbeat(
  arenaRef: ArenaRow,
  key: string,
  input: HeartbeatInput,
  nowMs: number,
): Promise<AgentPublic> {
  const { row, arena } = await writeTx(async (tx) => {
    const arena = await lockedArena(tx, arenaRef.id);
    const current = await findAgentTx(tx, arena.id, key);
    if (!current) throw notFound(`agent '${key}'`);
    const presence = {
      lastSeenAt: nowMs,
      awaySince: input.leaving ? nowMs : null,
      ttlSeconds: input.ttlSeconds ?? current.ttlSeconds,
      updatedAt: nowMs,
    };
    await tx.update(agents).set(presence).where(eq(agents.id, current.id));
    const row = { ...current, ...presence };
    await emitAgent(tx, arena, row, false, nowMs);
    return { row, arena };
  });
  await maybePruneArena(arena.id, nowMs);
  return toAgentPublic(row, arena.slug);
}

export async function removeAgent(arenaRef: ArenaRow, key: string, nowMs: number): Promise<void> {
  const arenaId = await writeTx(async (tx) => {
    const arena = await lockedArena(tx, arenaRef.id);
    const current = await findAgentTx(tx, arena.id, key);
    if (!current) throw notFound(`agent '${key}'`);
    const seq = await nextSeq(tx);
    await tx.delete(agents).where(eq(agents.id, current.id));
    await appendEvent(tx, {
      arenaId: arena.id,
      agentKey: key,
      type: "agent.removed",
      applied: true,
      report: null,
      agentVersion: seq,
      createdAt: nowMs,
    });
    await emit(tx, arena.id, { type: "agent.removed", seq, arenaId: arena.id, agentId: current.id, key }, nowMs);
    return arena.id;
  });
  await maybePruneArena(arenaId, nowMs);
}

export type AcknowledgeResult =
  | { ok: true; agent: AgentPublic }
  | { ok: false; reason: "stale" | "not_done"; agent: AgentPublic };

/**
 * Sets a `done` agent back to `idle`, but only if it is still at `expectedVersion`:
 * a newer answer that arrived while the owner was reading is never cleared unseen.
 */
export async function acknowledgeAgent(
  arenaRef: ArenaRow,
  key: string,
  expectedVersion: number,
  nowMs: number,
): Promise<AcknowledgeResult> {
  const outcome = await writeTx(async (tx) => {
    const arena = await lockedArena(tx, arenaRef.id);
    const current = await findAgentTx(tx, arena.id, key);
    if (!current) throw notFound(`agent '${key}'`);
    if (current.version !== expectedVersion) return { ok: false as const, reason: "stale" as const, row: current, arena };
    if (current.status !== "done") return { ok: false as const, reason: "not_done" as const, row: current, arena };
    const version = await nextSeq(tx);
    const next = {
      status: "idle" as const,
      activity: null,
      waitingOn: null,
      waitingFor: null,
      progress: null,
      result: null,
      resultTruncated: false,
      error: null,
      statusChangedAt: nowMs,
      version,
      updatedAt: nowMs,
    };
    await tx.update(agents).set(next).where(eq(agents.id, current.id));
    await appendEvent(tx, {
      arenaId: arena.id,
      agentKey: key,
      type: "agent.acknowledged",
      applied: true,
      report: { expectedVersion },
      agentVersion: version,
      createdAt: nowMs,
    });
    const row = { ...current, ...next };
    await emitAgent(tx, arena, row, true, nowMs);
    return { ok: true as const, row, arena };
  });
  const agent = toAgentPublic(outcome.row, outcome.arena.slug);
  if (!outcome.ok) return { ok: false, reason: outcome.reason, agent };
  await maybePruneArena(outcome.arena.id, nowMs);
  return { ok: true, agent };
}
