import type { Palette } from "@/lib/palette";
import { FRAMES, POSES, SPRITE_H, SPRITE_W, type Pose } from "./types";

type Px = (x: number, y: number, w: number, h: number, color: string) => void;

const EYE = "#1a1626";
const SHOE = "#2a2233";
const MOUTH = "#8a3a3a";

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + amount))));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function drawCharacter(px: Px, pose: Pose, frame: number, p: Palette) {
  const shirtDark = shade(p.shirt, -0.25);
  const shirtLight = shade(p.shirt, 0.24);
  const pantsDark = shade(p.pants, -0.2);
  const skinShadow = shade(p.skin, -0.18);
  // Vertical offset for the upper body: a breathing bob, a hop, a slump.
  let bob = 0;
  let shake = 0;
  if (pose === "idle" && frame === 1) bob = 1;
  if (pose === "done" && frame === 1) bob = -1;
  if (pose === "error") bob = 1;
  if (pose === "error" && frame === 1) shake = 1;
  if (pose === "walk") bob = frame === 0 ? 0 : -1;

  const u = (x: number, y: number, w: number, h: number, c: string) => px(x + shake, y + bob, w, h, c);
  px(2, 22, 12, 2, "#22243254");

  // Legs and shoes (not bobbed).
  if (pose === "walk") {
    const a = frame === 0;
    px(5, 17, 6, 2, p.pants);
    px(a ? 4 : 5, 19, 2, 3, p.pants);
    px(a ? 10 : 9, 19, 2, 2, pantsDark);
    px(a ? 3 : 4, 22, 3, 1, SHOE);
    px(a ? 10 : 9, 21, 3, 1, SHOE);
  } else {
    px(5, 17, 6, 2, p.pants);
    px(5, 19, 2, 3, p.pants);
    px(9, 19, 2, 3, p.pants);
    px(7, 19, 2, 1, pantsDark);
    const tap = pose === "wait" && frame === 1 ? -1 : 0;
    px(4, 22, 3, 1, SHOE);
    px(9, 22 + tap, 3, 1, SHOE);
  }

  // Body.
  u(3, 12, 10, 5, "#31303b");
  u(4, 11, 8, 6, p.shirt);
  u(5, 12, 6, 1, shirtLight);
  u(10, 13, 1, 2, shirtLight);
  u(4, 16, 8, 1, shirtDark);
  u(7, 10, 2, 1, p.skin);

  // Head and hair.
  u(4, 4, 8, 6, skinShadow);
  u(5, 4, 5, 5, p.skin);
  u(6, 9, 4, 1, p.skin);
  u(5, 2, 6, 1, p.hair);
  u(4, 3, 8, 2, p.hair);
  u(5, 3, 4, 1, shade(p.hair, 0.28));
  u(4, 5, 1, 3, p.hair);
  u(11, 5, 1, 3, p.hair);

  // Face.
  if (pose === "error") {
    u(6, 7, 2, 1, EYE);
    u(9, 7, 2, 1, EYE);
    u(7, 9, 2, 1, MOUTH);
    u(12, 3, 1, 2, "#7fd4ff"); // sweat drop
  } else if (pose === "work") {
    u(6, 8, 1, 1, EYE);
    u(9, 8, 1, 1, EYE);
  } else if (pose === "wait") {
    u(7, 7, 1, 1, EYE);
    u(10, 7, 1, 1, EYE);
  } else {
    u(6, 7, 1, 1, EYE);
    u(9, 7, 1, 1, EYE);
    if (pose === "done") u(7, 9, 2, 1, MOUTH);
  }

  // Arms and hands.
  switch (pose) {
    case "work": {
      const up = frame === 0;
      u(3, 11, 1, 3, p.shirt);
      u(12, 11, 1, 3, p.shirt);
      u(4, up ? 13 : 14, 2, 1, p.skin);
      u(10, up ? 14 : 13, 2, 1, p.skin);
      break;
    }
    case "done":
      u(3, 7, 1, 4, p.shirt);
      u(12, 7, 1, 4, p.shirt);
      u(3, 6, 1, 1, p.skin);
      u(12, 6, 1, 1, p.skin);
      break;
    case "wait":
      u(3, 11, 1, 5, p.shirt);
      u(3, 16, 1, 1, p.skin);
      // Checking a watch.
      u(12, 11, 1, 2, p.shirt);
      u(10, 12, 2, 1, p.shirt);
      u(9, 12, 1, 1, p.skin);
      if (frame === 1) u(9, 11, 1, 1, "#ffcc4d");
      break;
    case "walk": {
      const a = frame === 0;
      u(3, a ? 11 : 12, 1, 4, p.shirt);
      u(12, a ? 12 : 11, 1, 4, p.shirt);
      u(3, a ? 15 : 16, 1, 1, p.skin);
      u(12, a ? 16 : 15, 1, 1, p.skin);
      break;
    }
    default:
      u(3, 11, 1, 5, p.shirt);
      u(12, 11, 1, 5, p.shirt);
      u(3, 16, 1, 1, p.skin);
      u(12, 16, 1, 1, p.skin);
  }
}

/**
 * A sprite sheet and the frame geometry the renderer uses.
 */
export type SpriteSheet = {
  url: string;
  frameWidth: number;
  frameHeight: number;
  /** Per pose: its row and how many frames it has. */
  animations: Record<Pose, { row: number; frames: number }>;
};

const SPRITE_ANIMATIONS = Object.fromEntries(POSES.map((pose, row) => [pose, { row, frames: FRAMES }])) as SpriteSheet["animations"];

const sheetCache = new Map<string, SpriteSheet>();
/** Palettes can be overridden per agent; keep the cache bounded over a long-running tab. */
const SHEET_CACHE_LIMIT = 300;

/** This palette's sprite sheet. Browser only; the url is "" during server rendering. */
export function spriteSheet(palette: Palette): SpriteSheet {
  const empty: SpriteSheet = { url: "", frameWidth: SPRITE_W, frameHeight: SPRITE_H, animations: SPRITE_ANIMATIONS };
  if (typeof document === "undefined") return empty;
  const cacheKey = `${palette.skin}${palette.hair}${palette.shirt}${palette.pants}`;
  const cached = sheetCache.get(cacheKey);
  if (cached) {
    // Refresh its place so the least recently used sheet is evicted first.
    sheetCache.delete(cacheKey);
    sheetCache.set(cacheKey, cached);
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_W * FRAMES;
  canvas.height = SPRITE_H * POSES.length;
  const ctx = canvas.getContext("2d");
  if (!ctx) return empty;
  POSES.forEach((pose, row) => {
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const ox = frame * SPRITE_W;
      const oy = row * SPRITE_H;
      drawCharacter(
        (x, y, w, h, color) => {
          ctx.fillStyle = color;
          ctx.fillRect(ox + x, oy + y, w, h);
        },
        pose,
        frame,
        palette,
      );
    }
  });
  const sheet: SpriteSheet = { ...empty, url: canvas.toDataURL("image/png") };
  sheetCache.set(cacheKey, sheet);
  if (sheetCache.size > SHEET_CACHE_LIMIT) sheetCache.delete(sheetCache.keys().next().value!);
  return sheet;
}
