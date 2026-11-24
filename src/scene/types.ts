import type { Status, ThemeId } from "@/lib/domain";

/** Logical scene pixels. The scene is drawn at this resolution and scaled up by a whole number. */
export type Point = { x: number; y: number };

export const POSES = ["idle", "walk", "work", "wait", "done", "error"] as const;
export type Pose = (typeof POSES)[number];

export type BubbleKind = "dots" | "alert" | "check" | "error" | "question";

/** Where and how one agent is drawn. Produced by layoutScene; no DOM involved. */
export type Placement = {
  agentId: string;
  key: string;
  /** Feet position (bottom centre of the sprite). */
  x: number;
  y: number;
  pose: Pose;
  bubble: BubbleKind | null;
  /** Higher draws in front. */
  z: number;
  dimmed: boolean;
  /** idle + away: the agent has gone home; only the empty station and nameplate remain. */
  hidden: boolean;
  /** At its own station (so the station's front is drawn over its legs). */
  atStation: boolean;
  seat: number;
  station: Point;
  progress: number | null;
};

export type ThemeCopy = Record<Status | "needsYou" | "away" | "stalled", string>;

export type ThemeLayout = {
  id: ThemeId;
  name: string;
  width: number;
  /** Height with only the base seats; overflow rows make the scene taller. */
  baseHeight: number;
  /** Station anchors (bottom centre of the desk or counter), in fill order. */
  seats: Point[];
  /** Extra rows past the base seats repeat these x positions every `overflowRowGap` pixels. */
  overflowColumns: number[];
  overflowRowGap: number;
  waitingSpots: Point[];
  copy: ThemeCopy;
};

export const SPRITE_W = 16;
export const SPRITE_H = 24;
export const FRAMES = 2;
/** How far behind its station anchor an agent stands, so the station hides its legs. */
export const STATION_DEPTH = 7;
