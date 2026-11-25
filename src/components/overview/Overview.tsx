"use client";

import Link from "next/link";
import { countAgents, groupOf, presenceOf, type AgentPublic } from "@/lib/domain";
import { agentsOf } from "@/lib/live-state";
import { AgentAvatar, AgentDetailLine } from "../arena/AgentList";
import { ConnectionDot, ConnectionFailure } from "../arena/ConnectionDot";
import { Scene } from "@/scene/Scene";
import { LAYOUTS } from "@/scene/themes/layouts";
import { useLiveStream, useNow } from "../live/useLiveStream";
import { CountChips, StatusChip } from "../status";

/** Most urgent first: needs you, error, done, working, waiting, idle. */
const URGENCY = ["needsYou", "error", "done", "working", "waiting", "idle"] as const;

function urgent(agents: AgentPublic[], n: number): AgentPublic[] {
  return [...agents]
    .sort((a, b) => URGENCY.indexOf(groupOf(a)) - URGENCY.indexOf(groupOf(b)) || a.seat - b.seat)
    .slice(0, n);
}

export function Overview() {
  const live = useLiveStream(null);
  const nowMs = useNow(5000, live.clockOffsetMs);
  const arenas = Object.values(live.arenas).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (live.connection === "failed") return <ConnectionFailure onRetry={live.retry} />;
  if (!live.hasSnapshot) return <p className="font-pixel text-muted">Connecting…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="font-pixel text-3xl">Your arenas</h1>
        <ConnectionDot state={live.connection} />
      </div>
      {arenas.length === 0 ? (
        <div className="pixel-panel p-6 text-sm">
          <p className="font-pixel text-lg">No arenas yet.</p>
          <p className="mt-2 text-muted">
            <Link href="/arenas/new" className="underline">
              Create one
            </Link>{" "}
            (you&apos;ll need the owner login), or use the admin API:
          </p>
          <pre className="mt-2 overflow-x-auto bg-ink p-3 text-xs">{`curl -X POST $ARENA_URL/api/arenas \\
  -H "Authorization: Bearer $ARENA_ADMIN_TOKEN" -H "Content-Type: application/json" \\
  -d '{"slug":"career","name":"Career","theme":"office"}'`}</pre>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {arenas.map((arena) => {
            const agents = agentsOf(live, arena.id);
            const counts = countAgents(agents, nowMs);
            return (
              <article
                key={arena.id}
                className="pixel-panel min-w-0 p-4"
                data-arena={arena.slug}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 wrap-anywhere font-pixel text-xl">
                    <Link href={`/arenas/${arena.slug}`} className="hover:underline">{arena.name}</Link>
                  </h2>
                  <span className="border border-line px-1.5 text-xs uppercase tracking-wider text-muted">
                    {arena.theme}
                  </span>
                  {counts.needsYou > 0 ? (
                    <span className="ml-auto">
                      <StatusChip group="needsYou" label={`${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you`} />
                    </span>
                  ) : null}
                </div>
                <Link href={`/arenas/${arena.slug}`} aria-label={`Open the ${arena.name} room`} className="mt-3 block max-w-[480px] overflow-hidden border-2 border-line hover:border-muted">
                  <Scene themeId={arena.theme} agents={agents} nowMs={nowMs} interactive={false} maxHeight={LAYOUTS[arena.theme].baseHeight} />
                </Link>
                <div className="mt-3">
                  <CountChips counts={counts} />
                </div>
                <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                  {urgent(agents, 4).map((agent) => (
                    <li key={agent.id}>
                      <Link
                        href={`/arenas/${arena.slug}?agent=${encodeURIComponent(agent.key)}`}
                        className={`flex min-w-0 items-start gap-2 rounded px-1 py-0.5 hover:bg-panel-2 ${nowMs && presenceOf(agent, nowMs) === "away" ? "opacity-60" : ""}`}
                      >
                        <AgentAvatar agent={agent} size={20} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">{agent.displayName}</span>
                          <span className="block min-w-0 text-muted"><AgentDetailLine agent={agent} /></span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
