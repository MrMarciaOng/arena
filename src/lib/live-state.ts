import type { AgentPublic, ArenaPublic, PresenceMessage, StreamMessage } from "./domain";

/**
 * The browser's copy of what the stream has told it. Pure, so it is unit-tested directly.
 *
 * Rules (docs/PLAN.md, "SSE stream"):
 * - A snapshot replaces everything, and its seq is a floor: any later message at or below it is
 *   already reflected in the snapshot and is dropped.
 * - An agent message applies only if its version is higher than the one held (or than a removal seen for that slot).
 * - Presence fields merge separately: the newest lastSeenAt wins. Presence that arrives before the
 *   agent's first upsert is kept and applied when the agent shows up.
 */
export type LiveState = {
  connection: "connecting" | "live" | "reconnecting" | "failed";
  hasSnapshot: boolean;
  snapshotSeq: number;
  /** serverTime − client clock at the last snapshot, so presence uses the server's clock. */
  clockOffsetMs: number;
  arenas: Record<string, ArenaPublic>;
  /** Keyed by `${arenaId}/${key}`: one agent per key per arena. */
  agents: Record<string, AgentPublic>;
  agentTombstones: Record<string, number>;
  arenaTombstones: Record<string, number>;
  /** Presence for agents not seen yet, keyed by agent id. */
  pendingPresence: Record<string, PresenceMessage>;
};

export const initialLiveState: LiveState = {
  connection: "connecting",
  hasSnapshot: false,
  snapshotSeq: 0,
  clockOffsetMs: 0,
  arenas: {},
  agents: {},
  agentTombstones: {},
  arenaTombstones: {},
  pendingPresence: {},
};

export const agentSlot = (arenaId: string, key: string) => `${arenaId}/${key}`;

const time = (iso: string) => Date.parse(iso);

type PresenceFields = Pick<AgentPublic, "lastSeenAt" | "awaySince" | "ttlSeconds">;

function newer(a: PresenceFields, b: PresenceFields | undefined): PresenceFields {
  if (!b || time(a.lastSeenAt) >= time(b.lastSeenAt)) return a;
  return b;
}

function withNewestPresence(incoming: AgentPublic, held: AgentPublic | undefined, pending?: PresenceMessage): AgentPublic {
  let presence: PresenceFields = incoming;
  if (held && held.id === incoming.id) presence = newer(presence, held);
  if (pending) presence = newer(presence, pending);
  return { ...incoming, lastSeenAt: presence.lastSeenAt, awaySince: presence.awaySince, ttlSeconds: presence.ttlSeconds };
}

export type LiveAction =
  | { type: "message"; message: StreamMessage; clientNowMs: number }
  | { type: "disconnected" }
  | { type: "retry" }
  | { type: "failed" };

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  if (action.type === "disconnected") {
    return state.connection === "reconnecting" ? state : { ...state, connection: "reconnecting" };
  }
  if (action.type === "failed") return { ...state, connection: "failed" };
  if (action.type === "retry") return { ...state, connection: state.hasSnapshot ? "reconnecting" : "connecting" };
  const msg = action.message;
  if (msg.type !== "snapshot" && "seq" in msg && msg.seq <= state.snapshotSeq) return state;
  switch (msg.type) {
    case "reconnect":
      // Handled by the connection (it reopens at once); the state stays as it is.
      return state;
    case "snapshot": {
      const arenas: Record<string, ArenaPublic> = {};
      for (const arena of msg.arenas) arenas[arena.id] = arena;
      const agents: Record<string, AgentPublic> = {};
      for (const agent of msg.agents) agents[agentSlot(agent.arenaId, agent.key)] = agent;
      return {
        connection: "live",
        hasSnapshot: true,
        snapshotSeq: msg.seq,
        clockOffsetMs: time(msg.serverTime) - action.clientNowMs,
        arenas,
        agents,
        agentTombstones: {},
        arenaTombstones: {},
        pendingPresence: {},
      };
    }
    case "agent.upserted": {
      const agent = msg.agent;
      const tomb = state.arenaTombstones[agent.arenaId];
      if (tomb !== undefined && agent.version <= tomb) return state;
      const slot = agentSlot(agent.arenaId, agent.key);
      const held = state.agents[slot];
      const removedAt = state.agentTombstones[slot];
      if (removedAt !== undefined && agent.version <= removedAt) return state;
      if (held && agent.version <= held.version) return state;
      const agentTombstones = { ...state.agentTombstones };
      delete agentTombstones[slot];
      const pendingPresence = { ...state.pendingPresence };
      const pending = pendingPresence[agent.id];
      delete pendingPresence[agent.id];
      return {
        ...state,
        agents: { ...state.agents, [slot]: withNewestPresence(agent, held, pending) },
        agentTombstones,
        pendingPresence,
      };
    }
    case "agent.removed": {
      const slot = agentSlot(msg.arenaId, msg.key);
      const held = state.agents[slot];
      // A re-registration newer than this removal is already here: keep it.
      if (held && held.version > msg.seq) return state;
      const agents = { ...state.agents };
      delete agents[slot];
      return {
        ...state,
        agents,
        agentTombstones: {
          ...state.agentTombstones,
          [slot]: Math.max(msg.seq, state.agentTombstones[slot] ?? 0),
        },
      };
    }
    case "arena.upserted": {
      const arena = msg.arena;
      const tomb = state.arenaTombstones[arena.id];
      if (tomb !== undefined && arena.version <= tomb) return state;
      const held = state.arenas[arena.id];
      if (held && arena.version <= held.version) return state;
      return { ...state, arenas: { ...state.arenas, [arena.id]: arena } };
    }
    case "arena.removed": {
      const held = state.arenas[msg.arenaId];
      if (held && held.version > msg.seq) return state;
      const arenas = { ...state.arenas };
      delete arenas[msg.arenaId];
      const agents: Record<string, AgentPublic> = {};
      for (const [slot, agent] of Object.entries(state.agents)) {
        if (agent.arenaId !== msg.arenaId) agents[slot] = agent;
      }
      return {
        ...state,
        arenas,
        agents,
        arenaTombstones: { ...state.arenaTombstones, [msg.arenaId]: msg.seq },
      };
    }
    case "presence": {
      const slot = agentSlot(msg.arenaId, msg.key);
      const held = state.agents[slot];
      if (!held || held.id !== msg.agentId) {
        // Its upsert may still be on the way; keep the newest presence until it lands.
        const prior = state.pendingPresence[msg.agentId];
        if (prior && time(prior.lastSeenAt) > time(msg.lastSeenAt)) return state;
        return { ...state, pendingPresence: { ...state.pendingPresence, [msg.agentId]: msg } };
      }
      if (time(msg.lastSeenAt) < time(held.lastSeenAt)) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [slot]: { ...held, lastSeenAt: msg.lastSeenAt, awaySince: msg.awaySince, ttlSeconds: msg.ttlSeconds },
        },
      };
    }
  }
}

export function agentsOf(state: LiveState, arenaId: string): AgentPublic[] {
  return Object.values(state.agents)
    .filter((a) => a.arenaId === arenaId)
    .sort((a, b) => a.seat - b.seat);
}
