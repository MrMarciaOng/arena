"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { groupOf, presenceOf, type AgentPublic, type ThemeId } from "@/lib/domain";
import { plainText, since } from "@/lib/format";
import { paletteFor } from "@/lib/palette";
import { GROUP_COLOR } from "@/components/status";
import { layoutScene, sceneHeight, seatPoint } from "./layout";
import { spriteSheet } from "./sprites";
import { backgroundUrl, STATION_H, STATION_W, stationUrl, type StationVariant } from "./themes/art";
import { LAYOUTS } from "./themes/layouts";
import type { BubbleKind, Placement, ThemeLayout } from "./types";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

function useFitScale(baseWidth: number, interactive: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(baseWidth);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = width / baseWidth;
  const scale = interactive ? Math.max(1.1, fit) : Math.min(1, fit);
  return { ref, scale, canPan: interactive && Math.round(baseWidth * scale) > Math.round(width) };
}

const WALK_MS = 900;
const ROOM_DESTINATIONS: Record<ThemeId, readonly [string, string]> = {
  office: ["Workstations", "Coffee corner"],
  kitchen: ["Prep stations", "Kitchen pass"],
};
const roomJumpButton = "min-h-11 rounded border border-line bg-panel-2 px-2 text-sm text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-done";

const BUBBLE: Record<BubbleKind, { text: string; color: string }> = {
  dots: { text: "…", color: "var(--color-waiting)" },
  alert: { text: "!", color: "var(--color-needs-you)" },
  check: { text: "✓", color: "var(--color-done)" },
  error: { text: "!", color: "var(--color-error)" },
  question: { text: "?", color: "var(--color-waiting)" },
};

function Bubble({ kind, pulse }: { kind: BubbleKind; pulse: boolean }) {
  const b = BUBBLE[kind];
  return (
    <span
      aria-hidden
      className={`scene-bubble ${pulse ? "animate-blink" : ""}`}
      style={{ borderColor: b.color, color: b.color }}
    >
      {b.text}
    </span>
  );
}

/** The one line of detail that matters for the agent's status. */
function detailOf(agent: AgentPublic): string | null {
  switch (agent.status) {
    case "waiting":
      return agent.waitingFor ?? agent.activity;
    case "error":
      return agent.error ?? agent.activity;
    case "done":
      return (agent.resultPreview && plainText(agent.resultPreview)) || agent.activity;
    default:
      return agent.activity;
  }
}

function describe(agent: AgentPublic, theme: ThemeLayout, nowMs: number): string {
  const away = nowMs > 0 && presenceOf(agent, nowMs) === "away";
  const state = groupOf(agent) === "needsYou" ? theme.copy.needsYou : theme.copy[agent.status];
  const presence = away
    ? ` (${agent.status === "working" ? theme.copy.stalled : theme.copy.away}, last seen ${since(agent.lastSeenAt, nowMs)})`
    : "";
  const detail = detailOf(agent);
  return `${agent.displayName}: ${state}${presence}${detail ? ` · ${detail}` : ""}`;
}

function AgentSprite({
  placement,
  agent,
  label,
  reducedMotion,
  interactive,
  selected,
  onSelect,
}: {
  placement: Placement;
  agent: AgentPublic;
  label: string;
  reducedMotion: boolean;
  interactive: boolean;
  selected: boolean;
  onSelect?: (key: string) => void;
}) {
  const { x, y, z } = placement;
  // Walk while moving between spots. Adjusting state on a prop change, per React's guidance.
  const [prev, setPrev] = useState({ x, y, z });
  const [walking, setWalking] = useState(false);
  const [walkFromZ, setWalkFromZ] = useState(z);
  if (prev.x !== x || prev.y !== y) {
    setPrev({ x, y, z });
    setWalkFromZ(prev.z);
    if (!reducedMotion) setWalking(true);
  }
  // Reduced motion switched on mid-walk cancels the transition, and transitionend never fires.
  if (walking && reducedMotion) setWalking(false);
  // A new destination mid-walk cancels the old transition and starts another (we keep walking).
  // As a backstop for a transition that ends without an event, stop shortly after it should have.
  useEffect(() => {
    if (!walking) return;
    const timer = setTimeout(() => setWalking(false), WALK_MS + 300);
    return () => clearTimeout(timer);
  }, [walking, x, y]);

  const pose = walking ? "walk" : placement.pose;
  // Held per mounted sprite, so a full shared cache can't make visible sprites redraw every render.
  const palette = paletteFor(agent.key, agent.appearance);
  const paletteKey = `${palette.skin}${palette.hair}${palette.shirt}${palette.pants}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the palette is fully described by paletteKey
  const sheet = useMemo(() => spriteSheet(palette), [paletteKey]);
  const animation = sheet.animations[pose];
  const Tag = interactive ? "button" : "span";
  const caption = detailOf(agent);
  const accent = GROUP_COLOR[groupOf(agent)];

  return (
    <Tag
      type={interactive ? "button" : undefined}
      data-agent-sprite={agent.key}
      data-pose={pose}
      data-zone={placement.atStation ? "station" : "waiting"}
      aria-label={interactive ? label : undefined}
      title={label}
      onClick={interactive ? () => onSelect?.(agent.key) : undefined}
      onTransitionEnd={() => setWalking(false)}
      className={`scene-agent ${selected ? "is-selected" : ""} ${placement.dimmed ? "is-away" : ""}`}
      style={{
        width: sheet.frameWidth,
        height: sheet.frameHeight,
        transform: `translate(${x - sheet.frameWidth / 2}px, ${y - sheet.frameHeight}px)`,
        transition: reducedMotion ? "none" : `transform ${WALK_MS}ms linear`,
        // Mid-walk the feet are somewhere between the two spots; the nearer-the-back depth keeps
        // an agent leaving its desk behind that desk until it arrives.
        zIndex: walking ? Math.min(walkFromZ, z) : z,
      }}
    >
      <span
        className={`scene-sprite ${reducedMotion ? "" : "is-animated"}`}
        style={
          {
            width: sheet.frameWidth,
            height: sheet.frameHeight,
            backgroundImage: sheet.url ? `url(${sheet.url})` : undefined,
            backgroundPositionY: -animation.row * sheet.frameHeight,
            "--frames": animation.frames,
            "--strip": `${animation.frames * sheet.frameWidth}px`,
          } as CSSProperties
        }
      />
      {placement.bubble && !walking ? (
        <Bubble kind={placement.bubble} pulse={!reducedMotion && (placement.bubble === "alert" || placement.bubble === "check")} />
      ) : null}
      {placement.progress !== null && !walking ? (
        <span className="scene-progress" aria-hidden>
          <span style={{ width: `${Math.round(placement.progress * 100)}%` }} />
        </span>
      ) : null}
      {interactive ? (
        <span className="scene-nameplate" style={{ borderColor: accent }} aria-hidden>
          <span>{agent.displayName}</span>
        </span>
      ) : null}
      {interactive && caption ? (
        <span className="scene-caption" aria-hidden>
          {caption}
        </span>
      ) : null}
    </Tag>
  );
}

function stationVariant(agent: AgentPublic | undefined): StationVariant {
  if (agent?.status === "done") return "done";
  if (agent?.status === "error") return "error";
  return "plain";
}

export function Scene({
  themeId,
  agents,
  nowMs,
  selectedKey = null,
  onSelect,
  interactive = true,
  maxHeight,
}: {
  themeId: ThemeId;
  agents: AgentPublic[];
  nowMs: number;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  interactive?: boolean;
  /** Crop the view to this many logical pixels (thumbnails); the scene itself is unchanged. */
  maxHeight?: number;
}) {
  const theme = LAYOUTS[themeId];
  const reducedMotion = useReducedMotion();
  const { ref, scale, canPan } = useFitScale(theme.width, interactive);
  const roomId = useId();
  const panHintId = useId();
  const [stationsLabel, waitingLabel] = ROOM_DESTINATIONS[themeId];

  function panTo(destination: "stations" | "waiting") {
    const room = ref.current;
    if (!room) return;
    room.scrollTo({
      left: destination === "stations" ? 0 : room.scrollWidth - room.clientWidth,
      behavior: reducedMotion ? "instant" : "smooth",
    });
  }

  const highestSeat = Math.max(theme.seats.length - 1, ...agents.map((a) => a.seat));
  const height = sceneHeight(theme, highestSeat);
  const placements = layoutScene(theme, agents, nowMs);
  const hiddenSeats = new Set(placements.filter((placement) => placement.hidden).map((placement) => placement.seat));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const background = backgroundUrl(theme, height);
  const stations = Array.from({ length: highestSeat + 1 }, (_, seat) => seatPoint(theme, seat));
  const bySeat = new Map(agents.map((a) => [a.seat, a]));

  return (
    <>
      {canPan ? (
        <div className="grid gap-2 p-2">
          <p id={panHintId} className="text-xs text-muted">
            Swipe or scroll sideways to see the whole room.
          </p>
          <div role="group" aria-label="Room navigation" className="grid grid-cols-2 gap-2">
            <button type="button" aria-controls={roomId} className={roomJumpButton} onClick={() => panTo("stations")}>
              <span aria-hidden>← </span>{stationsLabel}
            </button>
            <button type="button" aria-controls={roomId} className={roomJumpButton} onClick={() => panTo("waiting")}>
              {waitingLabel}<span aria-hidden> →</span>
            </button>
          </div>
        </div>
      ) : null}
      <div
        id={roomId}
        ref={ref}
        className={interactive ? "scene-scroll" : "w-full overflow-hidden"}
        tabIndex={canPan ? 0 : undefined}
        role={interactive ? "region" : undefined}
        aria-label={interactive ? `${theme.name} workspace` : undefined}
        aria-describedby={canPan ? panHintId : undefined}
      >
        <div
          className="relative overflow-hidden"
          style={{ width: theme.width * scale, height: Math.min(height, maxHeight ?? height) * scale }}
        >
          <div
            className="scene pixelated"
            role={interactive ? "group" : undefined}
            aria-label={interactive ? `${theme.name} scene` : undefined}
            style={{
              width: theme.width,
              height,
              transform: `scale(${scale})`,
              backgroundImage: background ? `url(${background})` : undefined,
            }}
          >
            {stations.map((p, seat) => {
              const owner = bySeat.get(seat);
              const variant = stationVariant(owner);
              const station = stationUrl(themeId, variant);
              return (
                <div key={`station-${seat}`}>
                  <span
                    aria-hidden
                    className="scene-station"
                    data-station={owner?.key}
                    data-variant={variant}
                    style={{
                      width: STATION_W,
                      height: STATION_H,
                      transform: `translate(${p.x - STATION_W / 2}px, ${p.y - STATION_H}px)`,
                      zIndex: p.y,
                      backgroundImage: station ? `url(${station})` : undefined,
                    }}
                  />
                  {owner && interactive && hiddenSeats.has(seat) ? (
                    <span
                      aria-hidden
                      className="scene-nameplate scene-nameplate-away"
                      style={{ left: p.x + 4, top: p.y + 2, zIndex: p.y }}
                    >
                      <span>{owner.displayName}</span>
                    </span>
                  ) : null}
                </div>
              );
            })}
            {placements
              .filter((p) => !p.hidden)
              .map((p) => {
                const agent = byId.get(p.agentId)!;
                return (
                  <AgentSprite
                    key={p.agentId}
                    placement={p}
                    agent={agent}
                    label={describe(agent, theme, nowMs)}
                    reducedMotion={reducedMotion}
                    interactive={interactive}
                    selected={selectedKey === agent.key}
                    onSelect={onSelect}
                  />
                );
              })}
          </div>
        </div>
      </div>
    </>
  );
}
