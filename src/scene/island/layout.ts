import { groupOf, presenceOf, type AgentPublic } from "@/lib/domain";
import { paletteFor, type Palette } from "@/lib/palette";
import type { BubbleKind, Pose } from "../types";

// Pure, DOM-free, three-free state → voxel-island mapping.

export type Vec3 = { x: number; y: number; z: number };

export const BUILD_STAGES = [
  "slab",
  "foundation",
  "walls",
  "roof",
  "trim",
  "complete",
  "damaged",
] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export const PLOT_COLS = 3;
export const BASE_ROWS = 2;
export const BASE_PLOTS = PLOT_COLS * BASE_ROWS;
export const PLOT_SIZE = 4;
export const PLOT_PITCH_X = 6;
export const PLOT_PITCH_Z = 8;
export const PLOT_START_X = 2;
export const PLOT_START_Z = 2;
export const ISLAND_WIDTH = 27;

/** Pond bounds in voxel coordinates (inclusive start, exclusive end). */
export const POND_BOUNDS = { minX: 20, maxX: 24, minZ: 6, maxZ: 10 } as const;

/** Six well-spaced waiting spots around the pond & benches on the right side of the island. */
export const WAITING_SPOTS: readonly Vec3[] = [
  { x: 20.7, y: 0, z: 5.25 },
  { x: 23.3, y: 0, z: 5.25 },
  { x: 19.3, y: 0, z: 8.0 },
  { x: 24.7, y: 0, z: 8.0 },
  { x: 20.7, y: 0, z: 10.85 },
  { x: 23.3, y: 0, z: 10.85 },
];

export type PlotCoord = {
  seat: number;
  col: number;
  row: number;
  /** Center of the 4×4 paved building plot in voxel world coordinates. */
  center: Vec3;
  /** Worker standing position on the front apron of the plot. */
  workerSpot: Vec3;
};

/** Stable 3D plot geometry for a seat index; seats never move when agents come or go. */
export function plotOrigin(seat: number): PlotCoord {
  const col = seat % PLOT_COLS;
  const row = Math.floor(seat / PLOT_COLS);
  const cx = PLOT_START_X + col * PLOT_PITCH_X + PLOT_SIZE / 2;
  const cz = PLOT_START_Z + row * PLOT_PITCH_Z + PLOT_SIZE / 2;
  return {
    seat,
    col,
    row,
    center: { x: cx, y: 0, z: cz },
    workerSpot: { x: cx + 0.55, y: 0, z: cz + PLOT_SIZE / 2 + 0.55 },
  };
}

export type IslandGridSize = {
  width: number;
  depth: number;
  rows: number;
  plotCount: number;
};

/** Voxel footprint of the floating island needed to fit `highestSeat` (never below the base grid). */
export function islandGridSize(highestSeat: number): IslandGridSize {
  const rows = Math.max(BASE_ROWS, Math.floor(Math.max(0, highestSeat) / PLOT_COLS) + 1);
  return {
    width: ISLAND_WIDTH,
    depth: PLOT_START_Z + rows * PLOT_PITCH_Z + 1,
    rows,
    plotCount: rows * PLOT_COLS,
  };
}

/** From the island toward the orthographic camera (isometric-style view). */
export const ISO_DIR: Vec3 = (() => {
  const length = Math.hypot(1, 0.86, 1);
  return { x: 1 / length, y: 0.86 / length, z: 1 / length };
})();

/** Island centre the camera looks at. */
export function islandCenterPoint(width: number, depth: number): Vec3 {
  return { x: width / 2, y: 0.6, z: depth / 2 };
}

/** Breathing room around the island in the frame. */
export const VIEW_PADDING = {
  interactive: { x: 1.05, y: 1.08 },
  thumbnail: { x: 1.03, y: 1.04 },
} as const;

/**
 * The island's extent on screen, in world units, as the camera frames it: `u` runs right and `v`
 * up, both relative to the island centre. Pure, so the component can size the canvas before
 * three.js loads and the engine frames the camera from the same numbers.
 */
export function islandViewBox(width: number, depth: number) {
  const d = ISO_DIR;
  // Camera basis, as Object3D.lookAt builds it with world up (0, 1, 0).
  const rightLength = Math.hypot(d.z, d.x);
  const right = { x: d.z / rightLength, y: 0, z: -d.x / rightLength };
  const up = {
    x: d.y * right.z - d.z * right.y,
    y: d.z * right.x - d.x * right.z,
    z: d.x * right.y - d.y * right.x,
  };
  const c = islandCenterPoint(width, depth);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const x of [0, width]) {
    for (const y of [-2.6, 3.6]) {
      for (const z of [0, depth]) {
        const p = { x: x - c.x, y: y - c.y, z: z - c.z };
        const u = p.x * right.x + p.y * right.y + p.z * right.z;
        const v = p.x * up.x + p.y * up.y + p.z * up.z;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  return { minU, maxU, minV, maxV };
}

/** Framed size of the island in world units, padding included. */
export function islandViewSize(width: number, depth: number, interactive: boolean) {
  const box = islandViewBox(width, depth);
  const pad = interactive ? VIEW_PADDING.interactive : VIEW_PADDING.thumbnail;
  return { width: (box.maxU - box.minU) * pad.x, height: (box.maxV - box.minV) * pad.y };
}

/**
 * Smallest on-screen scale for the interactive island, in CSS pixels per world unit (workers stay
 * about 24 px tall). Past it, the island keeps this scale and the scene scrolls sideways, as the
 * 2D rooms do, instead of shrinking until workers and labels are unreadable.
 */
export const MIN_PX_PER_UNIT = 15;

/** Maps a 0–1 working progress fraction to a discrete building construction stage. */
export function progressToBuildStage(progress: number): BuildStage {
  const p = Math.max(0, Math.min(1, progress));
  if (p < 0.25) return "foundation";
  if (p < 0.55) return "walls";
  if (p < 0.85) return "roof";
  return "trim";
}

export type IslandPlacement = {
  agentId: string;
  key: string;
  seat: number;
  plot: PlotCoord;
  /** Target worker position in voxel world coordinates (feet at y = 0). */
  position: Vec3;
  pose: Pose;
  bubble: BubbleKind | null;
  dimmed: boolean;
  hidden: boolean;
  atStation: boolean;
  progress: number | null;
  buildStage: BuildStage;
  /** True when working without explicit progress: the renderer loops the build animation. */
  loopBuild: boolean;
  palette: Palette;
  accentColor: string;
};

export type IslandLayout = IslandGridSize & {
  placements: IslandPlacement[];
};

/**
 * Pure state → island diorama mapping. Mirrors `layoutScene` for seat stability, waiting overflow,
 * bubbles, away dimming, stalled warning, and idle+away hiding.
 */
export function layoutIsland(agents: AgentPublic[], nowMs: number): IslandLayout {
  const ordered = [...agents].sort((a, b) => a.seat - b.seat);
  const highestSeat = Math.max(BASE_PLOTS - 1, ...ordered.map((a) => a.seat));
  const size = islandGridSize(highestSeat);

  let nextSpot = 0;
  const placements: IslandPlacement[] = ordered.map((agent) => {
    const plot = plotOrigin(agent.seat);
    const away = nowMs > 0 && presenceOf(agent, nowMs) === "away";
    const group = groupOf(agent);
    const palette = paletteFor(agent.key, agent.appearance);

    let position: Vec3 = plot.workerSpot;
    let atStation = true;
    if (agent.status === "waiting" && nextSpot < WAITING_SPOTS.length) {
      position = WAITING_SPOTS[nextSpot];
      nextSpot += 1;
      atStation = false;
    }

    const pose: Pose =
      agent.status === "working"
        ? "work"
        : agent.status === "waiting"
          ? "wait"
          : agent.status === "done"
            ? "done"
            : agent.status === "error"
              ? "error"
              : "idle";

    let bubble: BubbleKind | null = null;
    if (group === "needsYou") bubble = "alert";
    else if (agent.status === "waiting") bubble = "dots";
    else if (agent.status === "done") bubble = "check";
    else if (agent.status === "error") bubble = "error";
    if (away && agent.status === "working") bubble = "question";

    let buildStage: BuildStage = "slab";
    let loopBuild = false;
    switch (agent.status) {
      case "idle":
        buildStage = "slab";
        break;
      case "working":
        if (agent.progress !== null) {
          buildStage = progressToBuildStage(agent.progress);
        } else {
          buildStage = "walls";
          loopBuild = true;
        }
        break;
      case "waiting":
        buildStage = "foundation";
        break;
      case "done":
        buildStage = "complete";
        break;
      case "error":
        buildStage = "damaged";
        break;
    }

    return {
      agentId: agent.id,
      key: agent.key,
      seat: agent.seat,
      plot,
      position,
      pose,
      bubble,
      dimmed: away,
      hidden: away && agent.status === "idle",
      atStation,
      progress: agent.status === "working" ? agent.progress : null,
      buildStage,
      loopBuild,
      palette,
      accentColor: palette.shirt,
    };
  });

  return { ...size, placements };
}
