"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { countAgents, GROUPS, groupOf, type Group } from "@/lib/domain";
import { agentsOf } from "@/lib/live-state";
import { Scene } from "@/scene/Scene";
import { useLiveStream, useNow } from "../live/useLiveStream";
import { CountChips, GROUP_LABEL } from "../status";
import { AgentDrawer } from "./AgentDrawer";
import { AgentList } from "./AgentList";
import { ConnectionDot } from "./ConnectionDot";

const filterField = "h-9 min-w-0 rounded border border-line bg-ink px-2 text-sm text-text";

export function ArenaView({ slug }: { slug: string }) {
  const arenas = useMemo(() => [slug], [slug]);
  const live = useLiveStream(arenas);
  const nowMs = useNow(5000, live.clockOffsetMs);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<"scene" | "list">("scene");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Group | "all">("all");
  const searchInput = useRef<HTMLInputElement>(null);
  const rosterList = useRef<HTMLDivElement>(null);

  const arena = Object.values(live.arenas).find((a) => a.slug === slug) ?? null;
  const agents = arena ? agentsOf(live, arena.id) : [];
  const selected = selectedKey ? (agents.find((a) => a.key === selectedKey) ?? null) : null;
  const isScene = view === "scene";
  const query = search.trim().toLowerCase();
  const filtering = search.length > 0 || statusFilter !== "all";
  const matching = agents.filter((agent) =>
    (statusFilter === "all" || groupOf(agent) === statusFilter) &&
    (!query || [agent.displayName, agent.key, agent.role].some((value) => value?.toLowerCase().includes(query))),
  );

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    rosterList.current?.scrollTo({ top: 0 });
    searchInput.current?.focus();
  }

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
      <div className={isScene ? "grid min-w-0 gap-4 min-[1150px]:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_330px]" : undefined}>
        {isScene ? (
          <div className="workspace-frame min-w-0 self-start">
            <Scene
              themeId={arena.theme}
              agents={agents}
              nowMs={nowMs}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
            />
          </div>
        ) : null}
        <aside className={isScene ? "workspace-agents min-w-0" : "pixel-panel p-4"} aria-label="Agents">
          <div className={isScene ? "workspace-agents-content" : undefined}>
            <div className="mb-4 shrink-0 border-b border-line pb-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="font-pixel text-xl">Agents</h2>
                <span role="status" className="ml-auto text-xs tabular-nums text-muted">
                  {filtering ? `${matching.length} of ${agents.length} agents` : agents.length}
                </span>
              </div>
              <div className="mt-3 grid max-w-md grid-cols-[minmax(0,1fr)_7.25rem] gap-2">
                <input
                  ref={searchInput}
                  type="search"
                  aria-label="Search agents"
                  placeholder="Find agents"
                  className={filterField}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.currentTarget.value);
                    rosterList.current?.scrollTo({ top: 0 });
                  }}
                />
                <select
                  aria-label="Agent status"
                  className={filterField}
                  value={statusFilter}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setStatusFilter(GROUPS.find((group) => group === value) ?? "all");
                    rosterList.current?.scrollTo({ top: 0 });
                  }}
                >
                  <option value="all">All statuses</option>
                  {GROUPS.map((group) => <option key={group} value={group}>{GROUP_LABEL[group]}</option>)}
                </select>
              </div>
              {filtering ? (
                <button type="button" onClick={clearFilters} className="mt-2 text-xs text-muted underline underline-offset-4 hover:text-text">
                  Clear filters
                </button>
              ) : null}
            </div>
            <div ref={rosterList} className={isScene ? "workspace-agents-list" : undefined}>
              {agents.length > 0 && matching.length === 0 ? (
                <p className="text-sm text-muted">No agents match these filters.</p>
              ) : (
                <AgentList agents={matching} nowMs={nowMs} selectedKey={selectedKey} onSelect={setSelectedKey} />
              )}
            </div>
          </div>
        </aside>
      </div>
      {selected ? (
        <AgentDrawer key={selected.id} slug={slug} agent={selected} nowMs={nowMs} onClose={() => setSelectedKey(null)} />
      ) : null}
    </div>
  );
}
