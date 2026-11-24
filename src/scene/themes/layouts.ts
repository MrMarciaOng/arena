import type { ThemeId } from "@/lib/domain";
import type { ThemeLayout } from "../types";

// Layout data only (pure, testable without a canvas). Drawing lives in ./art.ts.

const STATION_COLUMNS = [48, 126, 204, 282];

const WAITING_SPOTS = [
  { x: 364, y: 111 },
  { x: 442, y: 111 },
  { x: 364, y: 179 },
  { x: 442, y: 179 },
  { x: 364, y: 247 },
  { x: 442, y: 247 },
];

const ROOM = {
  width: 480,
  baseHeight: 284,
  seats: [124, 211].flatMap((y) => STATION_COLUMNS.map((x) => ({ x, y }))),
  overflowColumns: STATION_COLUMNS,
  overflowRowGap: 87,
  waitingSpots: WAITING_SPOTS,
};

export const OFFICE: ThemeLayout = {
  ...ROOM,
  id: "office",
  name: "Office",
  copy: {
    idle: "At the desk",
    working: "Typing away",
    waiting: "Coffee break, waiting",
    needsYou: "Needs you",
    done: "Shipped it",
    error: "Hit a snag",
    away: "Gone quiet",
    stalled: "Stalled?",
  },
};

export const KITCHEN: ThemeLayout = {
  ...ROOM,
  id: "kitchen",
  name: "Kitchen",
  copy: {
    idle: "Wiping the counter",
    working: "Cooking",
    waiting: "Waiting on an order",
    needsYou: "Needs you",
    done: "Order up!",
    error: "Something's burning",
    away: "Off shift",
    stalled: "Stalled?",
  },
};

export const LAYOUTS: Record<ThemeId, ThemeLayout> = { office: OFFICE, kitchen: KITCHEN };
