"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { countAgents } from "@/lib/domain";
import { agentsOf } from "@/lib/live-state";
import { Scene } from "@/scene/Scene";
import { useLiveStream, useNow } from "../live/useLiveStream";
import { CountChips } from "../status";
import { AgentDrawer } from "./AgentDrawer";
import { AgentList } from "./AgentList";
import { ConnectionDot } from "./ConnectionDot";

export function ArenaView({ slug }: { slug: string }) {
  const arenas = useMemo(() => [slug], [slug]);
  const live = useLiveStream(arenas);
  const nowMs = useNow(5000, live.clockOffsetMs);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<"scene" | "list">("scene");

  const arena = Object.values(live.arenas).find((a) => a.slug === slug) ?? null;
  const agents = arena ? agentsOf(live, arena.id) : [];
  const selected = selectedKey ? (agents.find((a) => a.key === selectedKey) ?? null) : null;

  if (live.connection === "failed") {
    return <p className="font-pixel text-error">Can&apos;t load this arena.</p>;
  }
  if (!live.hasSnapshot) {
    return <p className="font-pixel text-muted">Connecting…</p>;
  }
  if (!arena) {
    return (
      <div className="pixel-panel p-6">
        <h1 className="font-pixel text-2xl">No arena called “{slug}”</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been deleted. <Link href="/" className="underline">Back to the overview</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-5" data-arena-view={arena.slug}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">{arena.theme}</span>
            <ConnectionDot state={live.connection} />
          </div>
          <h1 className="mt-1 break-words font-pixel text-4xl leading-none sm:text-5xl">{arena.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-1" role="group" aria-label="View">
            {(["scene", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className="workspace-view-button capitalize"
              >
                {v}
              </button>
            ))}
          </div>
          <Link href={`/arenas/${arena.slug}/settings`} className="text-sm text-muted underline underline-offset-4 hover:text-text">
            Settings
          </Link>
        </div>
      </div>
      <CountChips counts={countAgents(agents, nowMs)} />
      {view === "scene" ? (
        <div className="grid min-w-0 gap-4 min-[1150px]:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_330px]">
          <div className="workspace-frame min-w-0 self-start">
            <Scene
              themeId={arena.theme}
              agents={agents}
              nowMs={nowMs}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
            />
          </div>
          <aside className="workspace-agents min-w-0" aria-label="Agents">
            <div className="workspace-agents-content">
              <div className="mb-4 flex shrink-0 items-center justify-between gap-2 border-b border-line pb-3">
                <h2 className="font-pixel text-xl">Agents</h2>
                <span className="text-sm tabular-nums text-muted">{agents.length}</span>
              </div>
              <div className="workspace-agents-list">
                <AgentList agents={agents} nowMs={nowMs} selectedKey={selectedKey} onSelect={setSelectedKey} />
              </div>
            </div>
          </aside>
        </div>
      ) : (
        <div className="pixel-panel p-4">
          <AgentList agents={agents} nowMs={nowMs} selectedKey={selectedKey} onSelect={setSelectedKey} />
        </div>
      )}
      {selected ? (
        <AgentDrawer key={selected.id} slug={slug} agent={selected} nowMs={nowMs} onClose={() => setSelectedKey(null)} />
      ) : null}
    </div>
  );
}
