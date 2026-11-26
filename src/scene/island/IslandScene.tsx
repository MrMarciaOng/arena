"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentPublic } from "@/lib/domain";
import { AgentMarkers, describe, useReducedMotion } from "../shared";
import { ISLAND } from "../themes/layouts";
import { ISLAND_BACKDROP, IslandEngine, type ProjectionSnapshot } from "./engine";
import { islandViewSize, layoutIsland, MIN_PX_PER_UNIT } from "./layout";

/** Tallest the interactive island gets relative to its width before it fits by height instead. */
const MAX_ASPECT = 0.6;
/** Restarts after a lost WebGL context before giving up on the 3D view. */
const MAX_RESTARTS = 3;
/** An engine that runs this long without losing its context resets the restart count. */
const HEALTHY_MS = 30_000;

type Failure = "unavailable" | "lost";

export function IslandScene({
  agents,
  nowMs,
  selectedKey = null,
  onSelect,
  interactive = true,
  maxHeight,
  fallback,
}: {
  agents: AgentPublic[];
  nowMs: number;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  interactive?: boolean;
  maxHeight?: number;
  /** Shown instead of the 3D island when WebGL is unavailable or its context is lost. */
  fallback: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const layout = useMemo(() => layoutIsland(agents, nowMs), [agents, nowMs]);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const hintId = useId();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<IslandEngine | null>(null);
  const agentNodesRef = useRef(new Map<string, HTMLElement>());
  const hiddenLabelNodesRef = useRef(new Map<number, HTMLElement>());

  const [failure, setFailure] = useState<Failure | null>(null);
  const [restarts, setRestarts] = useState(0);
  /** Bumped to tear down the engine and build a fresh one (after a lost context). */
  const [generation, setGeneration] = useState(0);
  const [walkingKeys, setWalkingKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** Width available to the interactive island (the scroll container's), 0 until measured. */
  const [available, setAvailable] = useState(0);

  const measure = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !interactive) return;
      const observer = new ResizeObserver(([entry]) => setAvailable(Math.round(entry.contentRect.width)));
      observer.observe(node);
      return () => observer.disconnect();
    },
    [interactive],
  );

  const applyProjection = useCallback((snapshot: ProjectionSnapshot) => {
    for (const a of snapshot.agents) {
      const el = agentNodesRef.current.get(a.key);
      if (!el) continue;
      el.style.width = `${a.width}px`;
      el.style.height = `${a.height}px`;
      el.style.transform = `translate3d(${Math.round(a.x - a.width / 2)}px, ${Math.round(a.y - a.height)}px, 0)`;
      el.style.zIndex = String(a.zIndex);
      el.dataset.projected = "";
    }
    for (const label of snapshot.hiddenLabels) {
      const el = hiddenLabelNodesRef.current.get(label.seat);
      if (!el) continue;
      el.style.transform = `translate3d(${Math.round(label.x)}px, ${Math.round(label.y)}px, 0) translateX(-50%)`;
      el.dataset.projected = "";
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const canvasHost = canvasHostRef.current;
    if (!container || !canvasHost) return;

    let cancelled = false;
    let engine: IslandEngine;
    try {
      engine = new IslandEngine({
        container: canvasHost,
        interactive,
        reducedMotion,
        onProject: applyProjection,
        onWalkingChange: setWalkingKeys,
        onContextLost: () => {
          if (!cancelled) setFailure("lost");
        },
      });
    } catch {
      queueMicrotask(() => {
        if (!cancelled) setFailure("unavailable");
      });
      return () => {
        cancelled = true;
      };
    }
    engineRef.current = engine;

    const rect = container.getBoundingClientRect();
    engine.resize(rect.width || 480, rect.height || 284);

    let inView = true;
    const syncVisibility = () => engine.setVisible(inView && document.visibilityState === "visible");

    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) engine.resize(width, height);
    });
    resizeObserver.observe(container);

    const intersectionObserver =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            syncVisibility();
          })
        : null;
    intersectionObserver?.observe(container);

    document.addEventListener("visibilitychange", syncVisibility);
    const healthy = setTimeout(() => setRestarts(0), HEALTHY_MS);

    return () => {
      cancelled = true;
      clearTimeout(healthy);
      document.removeEventListener("visibilitychange", syncVisibility);
      intersectionObserver?.disconnect();
      resizeObserver.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
    // Reduced motion and the layout reach the engine through the effects below; the engine is
    // rebuilt only for a new mode or a restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, applyProjection, generation]);

  // A lost context (GPU reset, sleep, too many contexts) is usually temporary: try a fresh engine.
  useEffect(() => {
    if (failure !== "lost" || restarts >= MAX_RESTARTS) return;
    const timer = setTimeout(
      () => {
        setRestarts((n) => n + 1);
        setFailure(null);
        setGeneration((g) => g + 1);
      },
      2000 * (restarts + 1),
    );
    return () => clearTimeout(timer);
  }, [failure, restarts]);

  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, generation]);

  useEffect(() => {
    engineRef.current?.update(layout, selectedKey);
  }, [layout, selectedKey, generation]);

  if (failure) {
    const restarting = failure === "lost" && restarts < MAX_RESTARTS;
    return (
      <div>
        {interactive ? (
          <p role="status" className="px-2 pb-2 text-xs text-muted">
            {restarting
              ? "The 3D island stopped drawing. Showing the 2D view while it restarts."
              : "This browser can't draw the 3D island, so it's shown in 2D."}
          </p>
        ) : null}
        {fallback}
      </div>
    );
  }

  const visiblePlacements = layout.placements.filter((p) => !p.hidden);
  const hiddenPlacements = interactive ? layout.placements.filter((p) => p.hidden) : [];

  // Interactive: fit the island to the column, but never below MIN_PX_PER_UNIT. A big island keeps
  // that scale and the scene scrolls sideways, like the 2D rooms, instead of shrinking past legible.
  const view = islandViewSize(layout.width, layout.depth, interactive);
  let size: { width: number; height: number } | null = null;
  if (interactive && available > 0) {
    const scale = Math.max(
      MIN_PX_PER_UNIT,
      Math.min(available / view.width, (available * MAX_ASPECT) / view.height),
    );
    size = {
      width: Math.max(available, Math.round(view.width * scale)),
      height: Math.round(view.height * scale),
    };
  }
  const canPan = size !== null && size.width > available + 1;
  const sceneStyle = interactive
    ? size
      ? { width: size.width, height: size.height }
      : { width: "100%", aspectRatio: `${view.width} / ${Math.min(view.height, view.width * MAX_ASPECT)}` }
    : {
        width: "100%",
        aspectRatio: `${ISLAND.width} / ${maxHeight ?? ISLAND.baseHeight}`,
        maxHeight: maxHeight ? `${maxHeight}px` : undefined,
      };

  return (
    <>
      {canPan ? (
        <p id={hintId} className="p-2 text-xs text-muted">
          Swipe or scroll sideways to see the whole island.
        </p>
      ) : null}
      <div
        ref={measure}
        role={interactive ? "region" : undefined}
        aria-label={interactive ? `${ISLAND.name} workspace` : undefined}
        aria-describedby={canPan ? hintId : undefined}
        tabIndex={canPan ? 0 : undefined}
        className={interactive ? "scene-scroll rounded" : "w-full overflow-hidden"}
        style={{ background: ISLAND_BACKDROP }}
      >
        <div
          // Keyed by generation so a restart gets a clean host for the new canvas.
          key={generation}
          ref={containerRef}
          role={interactive ? "group" : undefined}
          aria-label={interactive ? `${ISLAND.name} scene` : undefined}
          // `isolate`: the overlay's z-indexes stay inside the scene, under the agent drawer.
          className={`scene-island relative isolate overflow-hidden ${interactive ? "" : "scene-island-thumb"}`}
          style={sceneStyle}
        >
          <div ref={canvasHostRef} className="absolute inset-0" />
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {hiddenPlacements.map((p) => {
              const agent = byId.get(p.agentId)!;
              return (
                <span
                  key={`away-${p.seat}`}
                  ref={(node) => {
                    if (node) hiddenLabelNodesRef.current.set(p.seat, node);
                    else hiddenLabelNodesRef.current.delete(p.seat);
                  }}
                  aria-hidden
                  className="scene-nameplate scene-nameplate-away scene-nameplate-3d"
                >
                  <span>{agent.displayName}</span>
                </span>
              );
            })}
            {visiblePlacements.map((p) => {
              const agent = byId.get(p.agentId)!;
              const walking = walkingKeys.has(agent.key);
              const pose = walking ? "walk" : p.pose;
              const label = describe(agent, ISLAND, nowMs);
              const Tag = interactive ? "button" : "span";
              return (
                <Tag
                  key={p.agentId}
                  ref={(node: HTMLElement | null) => {
                    if (node) agentNodesRef.current.set(agent.key, node);
                    else agentNodesRef.current.delete(agent.key);
                  }}
                  type={interactive ? "button" : undefined}
                  data-agent-sprite={agent.key}
                  data-pose={pose}
                  data-zone={p.atStation ? "station" : "waiting"}
                  aria-label={interactive ? label : undefined}
                  title={label}
                  onClick={interactive ? () => onSelect?.(agent.key) : undefined}
                  className={`scene-agent scene-agent-3d ${interactive ? "pointer-events-auto" : "pointer-events-none"} ${selectedKey === agent.key ? "is-selected" : ""} ${p.dimmed ? "is-away" : ""}`}
                >
                  <AgentMarkers
                    agent={agent}
                    bubble={p.bubble}
                    progress={p.progress}
                    walking={walking}
                    reducedMotion={reducedMotion}
                    interactive={interactive}
                  />
                </Tag>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
