import { groupOf, presenceOf, type AgentPublic } from "@/lib/domain";
import { STATION_DEPTH, type Placement, type Point, type ThemeLayout } from "./types";

/** Station anchor for a seat index; past the theme's seats, rows repeat downward. */
export function seatPoint(theme: ThemeLayout, seat: number): Point {
  if (seat < theme.seats.length) return theme.seats[seat];
  const extra = seat - theme.seats.length;
  const cols = theme.overflowColumns.length;
  const lastY = Math.max(...theme.seats.map((s) => s.y));
  return {
    x: theme.overflowColumns[extra % cols],
    y: lastY + theme.overflowRowGap * (Math.floor(extra / cols) + 1),
  };
}

/** Scene height needed to fit every seat in use (never below the theme's base height). */
export function sceneHeight(theme: ThemeLayout, highestSeat: number): number {
  if (highestSeat < theme.seats.length) return theme.baseHeight;
  return Math.max(theme.baseHeight, seatPoint(theme, highestSeat).y + 32);
}

/**
 * Where each agent stands and how it looks. Pure: same input, same output.
 *
 * - working / done / error / idle: at its own station (seats never move when others come and go).
 * - waiting: walks to a waiting spot, filled in seat order; if the spots are full, waits at the desk.
 * - away: drawn dimmed with its status kept; working + away adds a "?"; idle + away is hidden.
 */
export function layoutScene(theme: ThemeLayout, agents: AgentPublic[], nowMs: number): Placement[] {
  const ordered = [...agents].sort((a, b) => a.seat - b.seat);
  let nextSpot = 0;
  return ordered.map((agent) => {
    const station = seatPoint(theme, agent.seat);
    const away = nowMs > 0 && presenceOf(agent, nowMs) === "away";
    const group = groupOf(agent);
    const atDesk = { x: station.x + 4, y: station.y - STATION_DEPTH };

    let spot: Point = atDesk;
    let atStation = true;
    if (agent.status === "waiting" && nextSpot < theme.waitingSpots.length) {
      spot = theme.waitingSpots[nextSpot];
      nextSpot += 1;
      atStation = false;
    }

    const pose =
      agent.status === "working"
        ? "work"
        : agent.status === "waiting"
          ? "wait"
          : agent.status === "done"
            ? "done"
            : agent.status === "error"
              ? "error"
              : "idle";

    let bubble: Placement["bubble"] = null;
    if (group === "needsYou") bubble = "alert";
    else if (agent.status === "waiting") bubble = "dots";
    else if (agent.status === "done") bubble = "check";
    else if (agent.status === "error") bubble = "error";
    if (away && agent.status === "working") bubble = "question";

    return {
      agentId: agent.id,
      key: agent.key,
      x: spot.x,
      y: spot.y,
      pose,
      bubble,
      z: spot.y,
      dimmed: away,
      hidden: away && agent.status === "idle",
      atStation,
      seat: agent.seat,
      station,
      progress: agent.status === "working" ? agent.progress : null,
    };
  });
}
