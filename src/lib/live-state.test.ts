import { describe, expect, it } from "vitest";
import type { AgentPublic, ArenaPublic, StreamMessage } from "./domain";
import { agentSlot, initialLiveState, liveReducer, type LiveState } from "./live-state";

const arena: ArenaPublic = {
  id: "a1",
  slug: "career",
  name: "Career",
  theme: "office",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function agent(over: Partial<AgentPublic> = {}): AgentPublic {
  return {
    id: "ag1",
    arenaId: "a1",
    arena: "career",
    key: "bot",
    displayName: "Bot",
    role: null,
    appearance: null,
    status: "working",
    activity: null,
    waitingOn: null,
    waitingFor: null,
    progress: null,
    hasResult: false,
    resultPreview: null,
    resultTruncated: false,
    error: null,
    seat: 0,
    version: 5,
    ttlSeconds: 900,
    lastSeenAt: "2026-01-01T00:00:05.000Z",
    awaySince: null,
    statusChangedAt: "2026-01-01T00:00:05.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: null,
    ...over,
  };
}

const apply = (state: LiveState, ...messages: StreamMessage[]) =>
  messages.reduce((s, message) => liveReducer(s, { type: "message", message, clientNowMs: 0 }), state);

const snap = (agents: AgentPublic[], arenas = [arena], seq = 0): StreamMessage => ({
  type: "snapshot",
  seq,
  serverTime: "2026-01-01T00:00:10.000Z",
  arenas,
  agents,
});

const slot = agentSlot("a1", "bot");

describe("liveReducer", () => {
  it("keeps the newer version when messages arrive out of order", () => {
    const s = apply(
      initialLiveState,
      snap([]),
      { type: "agent.upserted", seq: 6, agent: agent({ version: 6, status: "done" }) },
      { type: "agent.upserted", seq: 5, agent: agent({ version: 5, status: "working" }) },
    );
    expect(s.agents[slot].status).toBe("done");
    expect(s.agents[slot].version).toBe(6);
  });

  it("a snapshot replaces everything, including agents that vanished", () => {
    let s = apply(initialLiveState, snap([agent()]));
    expect(Object.keys(s.agents)).toEqual([slot]);
    s = apply(s, snap([], []));
    expect(s.agents).toEqual({});
    expect(s.arenas).toEqual({});
  });

  it("ignores a stale upsert that arrives after a removal", () => {
    const s = apply(
      initialLiveState,
      snap([agent({ version: 5 })]),
      { type: "agent.removed", seq: 7, arenaId: "a1", agentId: "ag1", key: "bot" },
      { type: "agent.upserted", seq: 6, agent: agent({ version: 6 }) },
    );
    expect(s.agents[slot]).toBeUndefined();
  });

  it("keeps a re-registration that is newer than a late removal", () => {
    const s = apply(
      initialLiveState,
      snap([]),
      { type: "agent.upserted", seq: 9, agent: agent({ id: "ag2", version: 9 }) },
      { type: "agent.removed", seq: 7, arenaId: "a1", agentId: "ag1", key: "bot" },
    );
    expect(s.agents[slot].id).toBe("ag2");
  });

  it("removing an arena removes its agents and blocks stale upserts", () => {
    const s = apply(
      initialLiveState,
      snap([agent()]),
      { type: "arena.removed", seq: 11, arenaId: "a1", slug: "career" },
      { type: "agent.upserted", seq: 8, agent: agent({ version: 8 }) },
    );
    expect(s.arenas).toEqual({});
    expect(s.agents).toEqual({});
  });

  it("merges presence by newest lastSeenAt, independent of version", () => {
    let s = apply(initialLiveState, snap([agent()]), {
      type: "presence", seq: 101,
      arenaId: "a1",
      agentId: "ag1",
      key: "bot",
      lastSeenAt: "2026-01-01T00:01:00.000Z",
      awaySince: "2026-01-01T00:01:00.000Z",
      ttlSeconds: 60,
    });
    expect(s.agents[slot]).toMatchObject({ awaySince: "2026-01-01T00:01:00.000Z", ttlSeconds: 60 });
    // An older presence message doesn't roll it back...
    s = apply(s, {
      type: "presence", seq: 102,
      arenaId: "a1",
      agentId: "ag1",
      key: "bot",
      lastSeenAt: "2026-01-01T00:00:30.000Z",
      awaySince: null,
      ttlSeconds: 900,
    });
    expect(s.agents[slot].ttlSeconds).toBe(60);
    // ...and a newer upsert with older presence keeps the newer presence.
    s = apply(s, { type: "agent.upserted", seq: 12, agent: agent({ version: 12, lastSeenAt: "2026-01-01T00:00:40.000Z" }) });
    expect(s.agents[slot]).toMatchObject({ version: 12, lastSeenAt: "2026-01-01T00:01:00.000Z" });
  });

  it("records the server clock offset from the snapshot", () => {
    const s = liveReducer(initialLiveState, {
      type: "message",
      message: snap([]),
      clientNowMs: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    expect(s.clockOffsetMs).toBe(10_000);
  });

  it("drops sequenced messages at or below the snapshot's seq", () => {
    const s = apply(initialLiveState, snap([], [arena], 10), { type: "agent.upserted", seq: 8, agent: agent({ version: 8 }) });
    expect(s.agents[slot]).toBeUndefined();
    const t = apply(s, { type: "agent.upserted", seq: 11, agent: agent({ version: 11 }) });
    expect(t.agents[slot].version).toBe(11);
  });

  it("keeps presence that arrives before the agent's first upsert", () => {
    const s = apply(
      initialLiveState,
      snap([]),
      { type: "presence", seq: 103, arenaId: "a1", agentId: "ag1", key: "bot", lastSeenAt: "2026-01-01T00:02:00.000Z", awaySince: "2026-01-01T00:02:00.000Z", ttlSeconds: 900 },
      { type: "agent.upserted", seq: 11, agent: agent({ version: 11, lastSeenAt: "2026-01-01T00:01:00.000Z" }) },
    );
    expect(s.agents[slot]).toMatchObject({ awaySince: "2026-01-01T00:02:00.000Z", lastSeenAt: "2026-01-01T00:02:00.000Z" });
    expect(s.pendingPresence).toEqual({});
  });
});
