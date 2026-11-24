import { describe, expect, it } from "vitest";
import type { AgentPublic } from "@/lib/domain";
import { layoutScene, sceneHeight, seatPoint } from "./layout";
import { KITCHEN, OFFICE } from "./themes/layouts";
import { STATION_DEPTH } from "./types";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");

function agent(key: string, seat: number, over: Partial<AgentPublic> = {}): AgentPublic {
  return {
    id: `id-${key}`,
    arenaId: "a1",
    arena: "career",
    key,
    displayName: key,
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
    seat,
    version: 1,
    ttlSeconds: 900,
    lastSeenAt: new Date(NOW - 1000).toISOString(),
    awaySince: null,
    statusChangedAt: new Date(NOW - 1000).toISOString(),
    createdAt: new Date(NOW - 1000).toISOString(),
    metadata: null,
    ...over,
  };
}

const byKey = (placements: ReturnType<typeof layoutScene>) => new Map(placements.map((p) => [p.key, p]));

describe("layoutScene", () => {
  it("keeps each agent at its own seat when others come and go", () => {
    const before = byKey(layoutScene(OFFICE, [agent("a", 0), agent("b", 1), agent("c", 2)], NOW));
    const after = byKey(layoutScene(OFFICE, [agent("a", 0), agent("c", 2)], NOW));
    expect(after.get("c")).toMatchObject({ x: before.get("c")!.x, y: before.get("c")!.y });
    expect(after.get("c")!.station).toEqual(seatPoint(OFFICE, 2));
    expect(after.get("c")!.y).toBe(seatPoint(OFFICE, 2).y - STATION_DEPTH);
  });

  it("sends waiting agents to waiting spots in seat order, and keeps the overflow at their desks", () => {
    const waiters = Array.from({ length: OFFICE.waitingSpots.length + 2 }, (_, i) => agent(`w${i}`, i, { status: "waiting" }));
    const placed = layoutScene(OFFICE, waiters, NOW);
    placed.slice(0, OFFICE.waitingSpots.length).forEach((p, i) => {
      expect({ x: p.x, y: p.y }).toEqual(OFFICE.waitingSpots[i]);
      expect(p).toMatchObject({ pose: "wait", atStation: false, bubble: "dots" });
    });
    const overflow = placed.at(-1)!;
    expect(overflow).toMatchObject({ pose: "wait", atStation: true });
    expect(overflow.x).toBe(seatPoint(OFFICE, overflow.seat).x + 4);
  });

  it("maps statuses to poses and bubbles", () => {
    const p = byKey(
      layoutScene(
        OFFICE,
        [
          agent("w", 0, { status: "working", progress: 0.5 }),
          agent("h", 1, { status: "waiting", waitingOn: "human" }),
          agent("d", 2, { status: "done" }),
          agent("e", 3, { status: "error" }),
          agent("i", 4, { status: "idle" }),
        ],
        NOW,
      ),
    );
    expect(p.get("w")).toMatchObject({ pose: "work", bubble: null, progress: 0.5 });
    expect(p.get("h")).toMatchObject({ pose: "wait", bubble: "alert" });
    expect(p.get("d")).toMatchObject({ pose: "done", bubble: "check" });
    expect(p.get("e")).toMatchObject({ pose: "error", bubble: "error" });
    expect(p.get("i")).toMatchObject({ pose: "idle", bubble: null, hidden: false });
  });

  it("dims away agents without losing their status; flags working + away; hides idle + away", () => {
    const longAgo = new Date(NOW - 2 * 3600_000).toISOString();
    const p = byKey(
      layoutScene(
        OFFICE,
        [
          agent("done", 0, { status: "done", lastSeenAt: longAgo }),
          agent("stalled", 1, { status: "working", lastSeenAt: longAgo }),
          agent("gone", 2, { status: "idle", awaySince: new Date(NOW - 1000).toISOString() }),
          agent("needs", 3, { status: "waiting", waitingOn: "human", lastSeenAt: longAgo }),
        ],
        NOW,
      ),
    );
    expect(p.get("done")).toMatchObject({ dimmed: true, pose: "done", bubble: "check", hidden: false });
    expect(p.get("stalled")).toMatchObject({ dimmed: true, pose: "work", bubble: "question" });
    expect(p.get("gone")).toMatchObject({ dimmed: true, hidden: true });
    expect(p.get("needs")).toMatchObject({ dimmed: true, bubble: "alert", atStation: false });
  });

  it("orders depth by feet position", () => {
    const p = byKey(layoutScene(OFFICE, [agent("front", 4), agent("back", 0)], NOW));
    expect(p.get("front")!.z).toBeGreaterThan(p.get("back")!.z);
    expect(p.get("back")!.z).toBe(p.get("back")!.y);
  });

  it("adds rows past the base seats and grows the scene", () => {
    const last = OFFICE.seats.length;
    expect(seatPoint(OFFICE, last).y).toBeGreaterThan(Math.max(...OFFICE.seats.map((s) => s.y)));
    expect(seatPoint(OFFICE, last).x).toBe(OFFICE.overflowColumns[0]);
    expect(sceneHeight(OFFICE, last - 1)).toBe(OFFICE.baseHeight);
    expect(sceneHeight(OFFICE, last)).toBeGreaterThan(OFFICE.baseHeight);
    expect(sceneHeight(OFFICE, 99)).toBeGreaterThan(seatPoint(OFFICE, 99).y);
  });

  it("treats an unknown clock (now = 0) as live", () => {
    const longAgo = new Date(NOW - 2 * 3600_000).toISOString();
    expect(layoutScene(OFFICE, [agent("x", 0, { lastSeenAt: longAgo })], 0)[0].dimmed).toBe(false);
  });

  it("leaves room for bubbles: no waiting agent's sprite or bubble covers another's", () => {
    for (const theme of [OFFICE, KITCHEN]) {
      // Sprite 16x24 above the feet, bubble up to 38 px above the feet and 12 px wide.
      type Box = { left: number; right: number; top: number; bottom: number };
      const sprite = (p: { x: number; y: number }) => ({ left: p.x - 8, right: p.x + 8, top: p.y - 24, bottom: p.y });
      const bubble = (p: { x: number; y: number }) => ({ left: p.x - 6, right: p.x + 6, top: p.y - 38, bottom: p.y - 27 });
      const hit = (a: Box, b: Box) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      for (const a of theme.waitingSpots) {
        for (const b of theme.waitingSpots) {
          if (a === b) continue;
          expect(hit(bubble(a), sprite(b)), `${theme.id}: bubble at ${a.x},${a.y} over sprite at ${b.x},${b.y}`).toBe(false);
          expect(hit(sprite(a), sprite(b)), `${theme.id}: sprites at ${a.x},${a.y} and ${b.x},${b.y}`).toBe(false);
        }
      }
    }
  });
});
