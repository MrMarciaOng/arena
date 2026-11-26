"use client";

import { useSyncExternalStore } from "react";
import { groupOf, presenceOf, type AgentPublic } from "@/lib/domain";
import { plainText, since } from "@/lib/format";
import { GROUP_COLOR } from "@/components/status";
import type { BubbleKind, ThemeLayout } from "./types";

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

export const BUBBLE: Record<BubbleKind, { text: string; color: string }> = {
  dots: { text: "…", color: "var(--color-waiting)" },
  alert: { text: "!", color: "var(--color-needs-you)" },
  check: { text: "✓", color: "var(--color-done)" },
  error: { text: "!", color: "var(--color-error)" },
  question: { text: "?", color: "var(--color-waiting)" },
};

export function Bubble({ kind, pulse }: { kind: BubbleKind; pulse: boolean }) {
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
export function detailOf(agent: AgentPublic): string | null {
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

export function describe(agent: AgentPublic, theme: ThemeLayout, nowMs: number): string {
  const away = nowMs > 0 && presenceOf(agent, nowMs) === "away";
  const state = groupOf(agent) === "needsYou" ? theme.copy.needsYou : theme.copy[agent.status];
  const presence = away
    ? ` (${agent.status === "working" ? theme.copy.stalled : theme.copy.away}, last seen ${since(agent.lastSeenAt, nowMs)})`
    : "";
  const detail = detailOf(agent);
  return `${agent.displayName}: ${state}${presence}${detail ? ` · ${detail}` : ""}`;
}

export function AgentMarkers({
  agent,
  bubble,
  progress,
  walking,
  reducedMotion,
  interactive,
}: {
  agent: AgentPublic;
  bubble: BubbleKind | null;
  progress: number | null;
  walking: boolean;
  reducedMotion: boolean;
  interactive: boolean;
}) {
  const caption = detailOf(agent);
  const accent = GROUP_COLOR[groupOf(agent)];
  return (
    <>
      {bubble && !walking ? (
        <Bubble kind={bubble} pulse={!reducedMotion && (bubble === "alert" || bubble === "check")} />
      ) : null}
      {progress !== null && !walking ? (
        <span className="scene-progress" aria-hidden>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
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
    </>
  );
}
