import { OrthographicCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { AgentPublic } from "@/lib/domain";
import { paletteFor } from "@/lib/palette";
import {
  BASE_PLOTS,
  BASE_ROWS,
  ISO_DIR,
  MIN_PX_PER_UNIT,
  PLOT_COLS,
  WAITING_SPOTS,
  islandCenterPoint,
  islandGridSize,
  islandViewBox,
  islandViewSize,
  layoutIsland,
  plotOrigin,
  progressToBuildStage,
} from "./layout";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");

function agent(key: string, seat: number, over: Partial<AgentPublic> = {}): AgentPublic {
  return {
    id: `id-${key}`,
    arenaId: "a1",
    arena: "builder",
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

const byKey = (layout: ReturnType<typeof layoutIsland>) => new Map(layout.placements.map((p) => [p.key, p]));

describe("layoutIsland", () => {
  it("keeps each agent's plot stable when other agents come and go", () => {
    const before = byKey(layoutIsland([agent("a", 0), agent("b", 1), agent("c", 2)], NOW));
    const after = byKey(layoutIsland([agent("a", 0), agent("c", 2)], NOW));
    expect(after.get("c")!.plot).toEqual(before.get("c")!.plot);
    expect(after.get("c")!.position).toEqual(plotOrigin(2).workerSpot);
  });

  it("grows the island by adding plot rows past the base grid", () => {
    const base = islandGridSize(BASE_PLOTS - 1);
    expect(base.rows).toBe(BASE_ROWS);
    expect(base.plotCount).toBe(BASE_PLOTS);

    const expanded = islandGridSize(BASE_PLOTS);
    expect(expanded.rows).toBe(BASE_ROWS + 1);
    expect(expanded.plotCount).toBe(BASE_PLOTS + PLOT_COLS);
    expect(expanded.depth).toBeGreaterThan(base.depth);

    const overflowPlot = plotOrigin(BASE_PLOTS);
    expect(overflowPlot.row).toBe(BASE_ROWS);
    expect(overflowPlot.col).toBe(0);
    expect(overflowPlot.center.z).toBeGreaterThan(plotOrigin(BASE_PLOTS - 1).center.z);
  });

  it("sends waiting agents to the pond plaza in seat order and keeps overflow at their plots", () => {
    const waiters = Array.from({ length: WAITING_SPOTS.length + 2 }, (_, i) =>
      agent(`w${i}`, i, { status: "waiting" }),
    );
    const { placements } = layoutIsland(waiters, NOW);

    placements.slice(0, WAITING_SPOTS.length).forEach((p, i) => {
      expect(p.position).toEqual(WAITING_SPOTS[i]);
      expect(p).toMatchObject({ pose: "wait", atStation: false, bubble: "dots", buildStage: "foundation" });
    });

    const overflow = placements.at(-1)!;
    expect(overflow).toMatchObject({ pose: "wait", atStation: true, bubble: "dots" });
    expect(overflow.position).toEqual(plotOrigin(overflow.seat).workerSpot);
  });

  it("maps progress fractions to construction stages and loops when progress is absent", () => {
    expect(progressToBuildStage(0)).toBe("foundation");
    expect(progressToBuildStage(0.24)).toBe("foundation");
    expect(progressToBuildStage(0.25)).toBe("walls");
    expect(progressToBuildStage(0.54)).toBe("walls");
    expect(progressToBuildStage(0.55)).toBe("roof");
    expect(progressToBuildStage(0.84)).toBe("roof");
    expect(progressToBuildStage(0.85)).toBe("trim");
    expect(progressToBuildStage(1)).toBe("trim");

    const map = byKey(
      layoutIsland(
        [
          agent("p0", 0, { status: "working", progress: 0.1 }),
          agent("p1", 1, { status: "working", progress: 0.4 }),
          agent("p2", 2, { status: "working", progress: 0.7 }),
          agent("p3", 3, { status: "working", progress: 0.95 }),
          agent("loop", 4, { status: "working", progress: null }),
        ],
        NOW,
      ),
    );
    expect(map.get("p0")).toMatchObject({ buildStage: "foundation", loopBuild: false, progress: 0.1 });
    expect(map.get("p1")).toMatchObject({ buildStage: "walls", loopBuild: false, progress: 0.4 });
    expect(map.get("p2")).toMatchObject({ buildStage: "roof", loopBuild: false, progress: 0.7 });
    expect(map.get("p3")).toMatchObject({ buildStage: "trim", loopBuild: false, progress: 0.95 });
    expect(map.get("loop")).toMatchObject({ buildStage: "walls", loopBuild: true, progress: null });
  });

  it("maps statuses to poses, bubbles, build stages, and palette accents", () => {
    const custom = { palette: { shirt: "#ff7a59" } };
    const map = byKey(
      layoutIsland(
        [
          agent("idle", 0, { status: "idle" }),
          agent("needs", 1, { status: "waiting", waitingOn: "human" }),
          agent("done", 2, { status: "done", appearance: custom }),
          agent("err", 3, { status: "error" }),
        ],
        NOW,
      ),
    );
    expect(map.get("idle")).toMatchObject({ pose: "idle", bubble: null, buildStage: "slab", hidden: false });
    expect(map.get("needs")).toMatchObject({ pose: "wait", bubble: "alert", atStation: false });
    expect(map.get("done")).toMatchObject({
      pose: "done",
      bubble: "check",
      buildStage: "complete",
      accentColor: "#ff7a59",
    });
    expect(map.get("err")).toMatchObject({ pose: "error", bubble: "error", buildStage: "damaged" });
    expect(map.get("idle")!.palette).toEqual(paletteFor("idle", null));
  });

  it("handles away dimming, working+away Stalled?, and idle+away hiding", () => {
    const longAgo = new Date(NOW - 2 * 3600_000).toISOString();
    const map = byKey(
      layoutIsland(
        [
          agent("done", 0, { status: "done", lastSeenAt: longAgo }),
          agent("stalled", 1, { status: "working", lastSeenAt: longAgo }),
          agent("gone", 2, { status: "idle", awaySince: new Date(NOW - 1000).toISOString() }),
          agent("needs", 3, { status: "waiting", waitingOn: "human", lastSeenAt: longAgo }),
        ],
        NOW,
      ),
    );
    expect(map.get("done")).toMatchObject({ dimmed: true, pose: "done", bubble: "check", hidden: false });
    expect(map.get("stalled")).toMatchObject({ dimmed: true, pose: "work", bubble: "question", hidden: false });
    expect(map.get("gone")).toMatchObject({ dimmed: true, hidden: true, buildStage: "slab" });
    expect(map.get("needs")).toMatchObject({ dimmed: true, bubble: "alert", atStation: false, hidden: false });
  });

  it("treats an unknown clock (now = 0) as live", () => {
    const longAgo = new Date(NOW - 2 * 3600_000).toISOString();
    expect(layoutIsland([agent("x", 0, { lastSeenAt: longAgo })], 0).placements[0].dimmed).toBe(false);
  });

  it("keeps waiting spots clear of each other", () => {
    for (let i = 0; i < WAITING_SPOTS.length; i += 1) {
      for (let j = i + 1; j < WAITING_SPOTS.length; j += 1) {
        const dx = WAITING_SPOTS[i].x - WAITING_SPOTS[j].x;
        const dz = WAITING_SPOTS[i].z - WAITING_SPOTS[j].z;
        expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(2.5);
      }
    }
  });
});

describe("islandViewBox", () => {
  it("matches where three.js's camera puts the island's corners", () => {
    for (const rows of [2, 5, 34]) {
      const { width, depth } = islandGridSize(rows * PLOT_COLS - 1);
      const c = islandCenterPoint(width, depth);
      const center = new Vector3(c.x, c.y, c.z);
      const camera = new OrthographicCamera();
      camera.position.copy(center).addScaledVector(new Vector3(ISO_DIR.x, ISO_DIR.y, ISO_DIR.z), 50);
      camera.lookAt(center);
      camera.updateMatrixWorld();

      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const x of [0, width]) {
        for (const y of [-2.6, 3.6]) {
          for (const z of [0, depth]) {
            const p = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
            minU = Math.min(minU, p.x);
            maxU = Math.max(maxU, p.x);
            minV = Math.min(minV, p.y);
            maxV = Math.max(maxV, p.y);
          }
        }
      }
      const box = islandViewBox(width, depth);
      expect(box.minU).toBeCloseTo(minU, 6);
      expect(box.maxU).toBeCloseTo(maxU, 6);
      expect(box.minV).toBeCloseTo(minV, 6);
      expect(box.maxV).toBeCloseTo(maxV, 6);
    }
  });

  it("grows the framed island with rows, so big arenas need the scroll fallback", () => {
    const base = islandGridSize(BASE_PLOTS - 1);
    const full = islandGridSize(99);
    const small = islandViewSize(base.width, base.depth, true);
    const large = islandViewSize(full.width, full.depth, true);
    expect(large.width).toBeGreaterThan(small.width * 5);
    // A 100-agent island at the minimum scale is wider than any column, so the scene pans.
    expect(large.width * MIN_PX_PER_UNIT).toBeGreaterThan(2000);
    // A small island fits a desktop column above the minimum scale.
    expect(900 / small.width).toBeGreaterThan(MIN_PX_PER_UNIT);
  });
});
