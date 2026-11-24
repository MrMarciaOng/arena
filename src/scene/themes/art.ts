import type { ThemeId } from "@/lib/domain";
import type { ThemeLayout } from "../types";

type Ctx = CanvasRenderingContext2D;

export const STATION_W = 46;
export const STATION_H = 35;

export type StationVariant = "plain" | "done" | "error";

const WALL_BOTTOM = 64;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function windowView(ctx: Ctx, x: number, y: number, width: number) {
  rect(ctx, x + 3, y + 4, width, 43, "#17293455");
  rect(ctx, x, y, width, 42, "#21343e");
  rect(ctx, x + 2, y + 2, width - 4, 11, "#77a9c7");
  rect(ctx, x + 2, y + 13, width - 4, 11, "#99bdd0");
  rect(ctx, x + 2, y + 24, width - 4, 16, "#dfc7ae");
  rect(ctx, x + 7, y + 9, 19, 3, "#dce1db");
  rect(ctx, x + 12, y + 6, 8, 3, "#dce1db");
  rect(ctx, x + width - 31, y + 14, 21, 2, "#f1d8be");
  rect(ctx, x + width - 24, y + 11, 9, 3, "#f1d8be");
  for (let left = 4, index = 0; left < width - 8; left += 10, index += 1) {
    const height = 3 + ((index * 7 + x) % 13);
    rect(ctx, x + left, y + 40 - height, 7, height, index % 2 ? "#6d8e9b" : "#8b9ea3");
    rect(ctx, x + left + 2, y + 42 - height, 1, 1, "#f2dfb0");
    rect(ctx, x + left + 4, y + 45 - height, 1, 1, "#a9bdc3");
  }
  for (let pane = 1; pane < 3; pane += 1) {
    const divider = x + Math.round((pane * width) / 3);
    rect(ctx, divider, y + 2, 2, 38, "#324953");
    rect(ctx, divider + 2, y + 2, 1, 38, "#d2e0dd50");
  }
  rect(ctx, x + 2, y + 22, width - 4, 1, "#516a75");
  rect(ctx, x - 3, y + 41, width + 6, 2, "#e2b28a");
  rect(ctx, x - 3, y + 43, width + 6, 2, "#a07360");
}

function plant(ctx: Ctx, x: number, y: number, pot: string) {
  rect(ctx, x - 2, y + 24, 23, 3, "#241d2555");
  rect(ctx, x + 1, y + 17, 17, 3, "#f5bc95");
  rect(ctx, x + 3, y + 20, 13, 5, pot);
  rect(ctx, x + 3, y + 20, 3, 5, "#ffddaa40");
  rect(ctx, x + 8, y + 3, 2, 14, "#4d7553");
  rect(ctx, x + 11, y + 7, 2, 10, "#44674e");
  rect(ctx, x + 5, y, 7, 4, "#91ab68");
  rect(ctx, x + 2, y + 5, 7, 5, "#5d915e");
  rect(ctx, x, y + 6, 3, 3, "#a5ba76");
  rect(ctx, x + 11, y + 4, 6, 5, "#75a364");
  rect(ctx, x + 14, y + 10, 6, 4, "#487956");
  rect(ctx, x + 4, y + 12, 6, 4, "#749b58");
}

function rug(ctx: Ctx, x: number, y: number, width: number, height: number, base: string, trim: string) {
  rect(ctx, x + 3, y + 4, width, height, "#23182748");
  rect(ctx, x, y, width, height, base);
  rect(ctx, x + 3, y + 3, width - 6, 1, trim);
  rect(ctx, x + 3, y + height - 4, width - 6, 1, trim);
  rect(ctx, x + 3, y + 4, 1, height - 8, trim);
  rect(ctx, x + width - 4, y + 4, 1, height - 8, trim);
  for (let stripe = x + 5; stripe < x + width - 4; stripe += 4) {
    rect(ctx, stripe, y - 2, 2, 2, trim);
    rect(ctx, stripe, y + height, 2, 2, trim);
  }
  for (let row = y + 8; row < y + height - 6; row += 8) {
    rect(ctx, x + 9, row + 1, width - 18, 1, "#f8e5e30a");
    rect(ctx, x + 7, row, 2, 3, trim);
    rect(ctx, x + width - 9, row, 2, 3, trim);
  }
}

function roomEdges(ctx: Ctx, width: number, height: number, trim: string) {
  rect(ctx, 0, 0, width, 4, "#19242e");
  rect(ctx, 0, 4, width, 2, trim);
  rect(ctx, 0, 6, 5, height - 6, "#1d2631");
  rect(ctx, width - 5, 6, 5, height - 6, "#1d2631");
  rect(ctx, 5, WALL_BOTTOM, 2, height - WALL_BOTTOM, "#261e2e50");
  rect(ctx, width - 7, WALL_BOTTOM, 2, height - WALL_BOTTOM, "#261e2e50");
  rect(ctx, 5, height - 4, width - 10, 4, "#272532");
  rect(ctx, 5, height - 5, width - 10, 1, trim);
}

function officeFloor(ctx: Ctx, width: number, height: number) {
  const boards = ["#ae805e", "#a77859", "#b28460", "#a47757", "#aa7a58"];
  for (let row = 0, y = WALL_BOTTOM; y < height; row += 1, y += 9) {
    rect(ctx, 0, y, width, 9, boards[row % boards.length]);
    rect(ctx, 0, y, width, 1, "#70524180");
    rect(ctx, 0, y + 1, width, 1, "#f5bf8728");
    for (let x = (row * 23) % 63; x < width; x += 63) {
      const grain = 6 + ((x + row * 7) % 20);
      rect(ctx, x, y, 1, 9, "#76523e99");
      rect(ctx, x + 5, y + 4, grain, 1, "#65473722");
      rect(ctx, x + 24, y + 6, 12, 1, "#fddaac33");
      rect(ctx, x + 43, y + 3, 8, 1, "#65473722");
    }
  }
  for (let row = 0; row < 32; row += 1) {
    const y = WALL_BOTTOM + row * 2;
    const shift = row * 2;
    rect(ctx, 29 + shift, y, 78, 2, "#ffe4ac20");
    rect(ctx, 141 + shift, y, 78, 2, "#ffe4ac20");
  }
}

function officeShelf(ctx: Ctx) {
  rect(ctx, 232, 19, 78, 35, "#2a3640");
  rect(ctx, 234, 21, 74, 31, "#3c4950");
  const spines = ["#ce886d", "#91aa8d", "#ddbc81", "#798eaa", "#b38c9d"];
  for (let i = 0; i < 10; i += 1) {
    const x = 238 + i * 5;
    const h = 7 + (i * 3) % 6;
    rect(ctx, x, 36 - h, 4, h, spines[i % spines.length]);
    rect(ctx, x + 1, 34, 2, 1, "#fff1cb77");
  }
  rect(ctx, 235, 36, 72, 2, "#9c765f");
  rect(ctx, 240, 43, 15, 6, "#c8926d");
  rect(ctx, 241, 42, 15, 2, "#e0ad80");
  rect(ctx, 263, 41, 17, 8, "#8b9e99");
  rect(ctx, 267, 43, 7, 1, "#d7e0cf");
  rect(ctx, 288, 45, 16, 4, "#c1a27f");
  rect(ctx, 232, 50, 78, 4, "#c58f6e");
}

function coffeeBar(ctx: Ctx) {
  rect(ctx, 333, 56, 136, 28, "#20233155");
  rect(ctx, 330, 54, 136, 25, "#45605e");
  rect(ctx, 330, 53, 136, 4, "#e8bd98");
  rect(ctx, 330, 56, 136, 2, "#997c69");
  for (let x = 332; x < 462; x += 26) {
    rect(ctx, x, 60, 23, 15, "#51716a");
    rect(ctx, x + 7, 63, 9, 1, "#b1aaa0");
    rect(ctx, x, 75, 23, 1, "#304849");
  }
  rect(ctx, 344, 35, 27, 18, "#25343e");
  rect(ctx, 346, 36, 23, 4, "#57747c");
  rect(ctx, 349, 41, 17, 9, "#111e28");
  rect(ctx, 352, 45, 4, 6, "#fcdfad");
  rect(ctx, 360, 44, 4, 7, "#ef9e8b");
  rect(ctx, 365, 37, 2, 1, "#e6ad68");
  rect(ctx, 381, 49, 21, 4, "#9f7264");
  for (let x = 383; x < 402; x += 6) {
    rect(ctx, x, 44, 4, 5, "#e8ddc5");
    rect(ctx, x + 4, 45, 1, 2, "#e8ddc5");
  }
  plant(ctx, 440, 28, "#c77d65");
}

function drawOffice(ctx: Ctx, theme: ThemeLayout, height: number) {
  const { width } = theme;
  officeFloor(ctx, width, height);
  rect(ctx, 0, 4, width, 60, "#476a72");
  rect(ctx, 0, 49, width, 12, "#3a555c");
  for (let x = 10; x < width; x += 21) rect(ctx, x, 50, 1, 11, "#304751");
  rect(ctx, 0, 48, width, 2, "#718a88");
  rect(ctx, 0, 61, width, 3, "#31414a");
  rect(ctx, 0, 64, width, 3, "#322c3350");
  windowView(ctx, 17, 8, 96);
  windowView(ctx, 123, 8, 96);
  officeShelf(ctx);
  rect(ctx, 346, 13, 100, 15, "#263d49");
  rect(ctx, 348, 15, 96, 10, "#365360");
  for (let x = 357; x < 438; x += 23) {
    rect(ctx, x, 19, 8, 2, "#c99f7f");
    rect(ctx, x + 9, 18, 5, 3, "#aecca8");
  }
  rug(ctx, 327, 87, 145, 186, "#6c515e", "#a27d7d");
  coffeeBar(ctx);
  rect(ctx, 392, 132, 23, 12, "#30293366");
  rect(ctx, 391, 128, 21, 9, "#a77b66");
  rect(ctx, 391, 128, 21, 2, "#d1a488");
  rect(ctx, 397, 130, 5, 3, "#cbd8c9");
  rect(ctx, 377, 217, 51, 6, "#2e273555");
  rect(ctx, 375, 204, 51, 15, "#394b53");
  rect(ctx, 377, 200, 47, 9, "#6d8b86");
  rect(ctx, 380, 208, 41, 7, "#53716f");
  rect(ctx, 398, 207, 2, 9, "#3f575b");
  rect(ctx, 380, 204, 8, 5, "#ba886e");
  rect(ctx, 412, 204, 8, 5, "#c9ae83");
  plant(ctx, 307, 57, "#ad6f58");
  plant(ctx, 12, 239, "#af775d");
  plant(ctx, 298, 240, "#a66358");
  roomEdges(ctx, width, height, "#cda17d");
}

function kitchenFloor(ctx: Ctx, width: number, height: number) {
  for (let y = WALL_BOTTOM; y < height; y += 12) {
    for (let x = 0; x < width; x += 12) {
      const alternate = (x / 12 + (y - WALL_BOTTOM) / 12) % 2;
      rect(ctx, x, y, 12, 12, alternate ? "#a78c75" : "#cfb397");
      rect(ctx, x, y, 12, 1, "#725e59a0");
      rect(ctx, x, y + 1, 1, 11, "#86716280");
      rect(ctx, x + 1, y + 1, 10, 1, "#f7dfb050");
    }
  }
}

function kitchenPass(ctx: Ctx) {
  rect(ctx, 330, 54, 137, 27, "#2b2933");
  rect(ctx, 330, 53, 137, 5, "#dbc4a4");
  rect(ctx, 330, 58, 137, 2, "#a68c78");
  for (let x = 333; x < 462; x += 26) {
    rect(ctx, x, 61, 24, 17, "#754f48");
    rect(ctx, x + 3, 63, 18, 1, "#a1715d");
    rect(ctx, x + 9, 67, 7, 1, "#d9af89");
  }
  for (const x of [346, 393, 440]) {
    rect(ctx, x + 6, 6, 2, 10, "#543d40");
    rect(ctx, x + 2, 15, 10, 3, "#9f593e");
    rect(ctx, x, 18, 14, 3, "#c98154");
    rect(ctx, x + 2, 21, 10, 2, "#ffd28f");
    for (let row = 0; row < 14; row += 1) {
      rect(ctx, x + 3 - row, 23 + row * 2, 8 + row * 2, 2, "#ffcd8525");
    }
  }
  rect(ctx, 350, 50, 19, 3, "#e0ddd0");
  rect(ctx, 353, 47, 12, 3, "#b86d46");
  rect(ctx, 356, 46, 5, 1, "#8e9a52");
  rect(ctx, 393, 49, 9, 4, "#c88e41");
  rect(ctx, 396, 45, 3, 4, "#ebba72");
  rect(ctx, 394, 49, 7, 1, "#f1c67f");
  rect(ctx, 431, 48, 20, 5, "#d0c0b5");
  rect(ctx, 435, 47, 13, 2, "#efe0c9");
}

function drawKitchen(ctx: Ctx, theme: ThemeLayout, height: number) {
  const { width } = theme;
  kitchenFloor(ctx, width, height);
  rect(ctx, 0, 4, width, 60, "#a97f68");
  for (let row = 0, y = 7; y < 61; row += 1, y += 8) {
    for (let x = row % 2 ? -8 : 0; x < width; x += 16) {
      rect(ctx, x, y, 15, 7, (row + x) % 3 ? "#c69476" : "#bc896f");
      rect(ctx, x, y, 15, 1, "#f8c29d4e");
    }
  }
  rect(ctx, 0, 57, width, 6, "#66524e");
  rect(ctx, 0, 63, width, 4, "#47374053");
  rect(ctx, 18, 12, 47, 65, "#4d504f");
  rect(ctx, 19, 13, 45, 62, "#a4a99e");
  rect(ctx, 20, 14, 4, 59, "#d0d2bf");
  rect(ctx, 23, 37, 41, 2, "#68716e");
  rect(ctx, 54, 24, 3, 9, "#3f4c51");
  rect(ctx, 54, 45, 3, 13, "#3f4c51");
  rect(ctx, 31, 21, 9, 8, "#e8c984");
  rect(ctx, 33, 23, 5, 1, "#af795f");
  rect(ctx, 76, 12, 112, 4, "#79554e");
  rect(ctx, 76, 12, 112, 1, "#e4b698");
  for (const [i, x] of [85, 107, 129, 150, 171].entries()) {
    rect(ctx, x + 4, 16, 2, 10, "#59545b");
    rect(ctx, x, 25, 10, 10, i % 2 ? "#866659" : "#514e57");
    rect(ctx, x + 1, 26, 8, 1, "#c3a692");
    rect(ctx, x + 2, 34, 6, 1, "#353945");
  }
  rect(ctx, 77, 44, 112, 19, "#53636a");
  rect(ctx, 77, 43, 112, 3, "#d9c5af");
  for (let x = 81; x < 182; x += 26) {
    rect(ctx, x, 48, 22, 11, "#738187");
    rect(ctx, x + 6, 50, 10, 1, "#bac0b9");
  }
  windowView(ctx, 202, 8, 94);
  rug(ctx, 327, 87, 145, 186, "#5b6358", "#93a087");
  kitchenPass(ctx);
  plant(ctx, 306, 56, "#b47956");
  plant(ctx, 12, 239, "#bb7052");
  roomEdges(ctx, width, height, "#d2a38a");
}

function drawDesk(ctx: Ctx, variant: StationVariant) {
  rect(ctx, 3, 29, 42, 6, "#24243172");
  rect(ctx, 3, 21, 40, 12, "#715042");
  rect(ctx, 5, 22, 36, 9, "#926348");
  rect(ctx, 7, 24, 16, 9, "#47393a");
  rect(ctx, 25, 24, 14, 3, "#ad7955");
  rect(ctx, 25, 28, 14, 3, "#ad7955");
  rect(ctx, 29, 25, 6, 1, "#ddaa79");
  rect(ctx, 29, 29, 6, 1, "#ddaa79");
  rect(ctx, 0, 17, 46, 5, "#ca966e");
  rect(ctx, 2, 15, 42, 3, "#e8b185");
  rect(ctx, 0, 20, 46, 2, "#ae775a");
  rect(ctx, 3, 3, 18, 11, "#29333f");
  rect(ctx, 4, 4, 16, 8, variant === "error" ? "#612d3e" : "#345666");
  rect(ctx, 5, 5, 6, 1, variant === "error" ? "#f68886" : "#98c8c2");
  rect(ctx, 8, 7, 9, 1, variant === "error" ? "#e3a19c" : "#7ebbb0");
  rect(ctx, 6, 9, 8, 1, "#d3bc93");
  rect(ctx, 11, 13, 2, 2, "#29333f");
  rect(ctx, 8, 15, 8, 1, "#29333f");
  rect(ctx, 18, 17, 13, 2, "#f0d7b8");
  rect(ctx, 19, 17, 11, 1, "#ffead2");
  rect(ctx, 39, 12, 4, 5, "#9ccaad");
  rect(ctx, 43, 13, 2, 2, "#a9cfb6");
  if (variant === "done") {
    rect(ctx, 29, 13, 8, 5, "#fff3d7");
    rect(ctx, 30, 14, 5, 1, "#87a195");
    rect(ctx, 30, 16, 4, 1, "#87a195");
  }
}

function drawCounter(ctx: Ctx, variant: StationVariant) {
  rect(ctx, 3, 29, 42, 6, "#30303a66");
  rect(ctx, 2, 19, 42, 14, "#626e73");
  rect(ctx, 4, 21, 38, 10, "#8d9c9d");
  rect(ctx, 6, 22, 23, 9, "#37464e");
  rect(ctx, 8, 24, 19, 5, "#684f48");
  rect(ctx, 12, 26, 11, 2, "#b57351");
  rect(ctx, 11, 22, 14, 1, "#c8c8b5");
  rect(ctx, 31, 22, 9, 3, "#c4c7b8");
  rect(ctx, 31, 27, 9, 2, "#c4c7b8");
  rect(ctx, 0, 16, 46, 5, "#acb8b6");
  rect(ctx, 1, 15, 44, 2, "#e2dfca");
  rect(ctx, 0, 19, 46, 2, "#8a9a9d");
  rect(ctx, 4, 11, 16, 4, "#444a53");
  rect(ctx, 5, 8, 14, 6, variant === "error" ? "#585057" : "#889594");
  rect(ctx, 5, 8, 14, 1, "#e6e1ce");
  rect(ctx, 2, 9, 3, 2, "#4c555c");
  rect(ctx, 19, 9, 3, 2, "#4c555c");
  rect(ctx, 10, 6, 4, 2, "#5f686c");
  rect(ctx, 28, 15, 14, 3, "#a66d49");
  rect(ctx, 31, 14, 8, 2, "#85a469");
  rect(ctx, 35, 13, 4, 2, "#c47756");
  if (variant === "done") {
    rect(ctx, 28, 14, 14, 3, "#eee4ca");
    rect(ctx, 31, 13, 8, 2, "#d49662");
    rect(ctx, 34, 12, 4, 1, "#87a96c");
  } else if (variant === "error") {
    rect(ctx, 7, 4, 4, 4, "#a59b9a");
    rect(ctx, 11, 1, 5, 4, "#b6aaa3");
    rect(ctx, 15, 4, 5, 3, "#c2b9aa");
  }
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 32;

function toUrl(key: string, w: number, h: number, draw: (ctx: Ctx) => void): string {
  if (typeof document === "undefined") return "";
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  draw(ctx);
  const url = canvas.toDataURL("image/png");
  cache.set(key, url);
  // Backgrounds vary with scene height; keep only the most recent few.
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return url;
}

export function backgroundUrl(theme: ThemeLayout, height: number): string {
  return toUrl(`bg:${theme.id}:${height}`, theme.width, height, (ctx) =>
    theme.id === "kitchen" ? drawKitchen(ctx, theme, height) : drawOffice(ctx, theme, height),
  );
}

export function stationUrl(themeId: ThemeId, variant: StationVariant = "plain"): string {
  return toUrl(`station:${themeId}:${variant}`, STATION_W, STATION_H, (ctx) =>
    themeId === "kitchen" ? drawCounter(ctx, variant) : drawDesk(ctx, variant),
  );
}
