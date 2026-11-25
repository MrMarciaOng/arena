"use client";

import { GROUPS, groupOf, presenceOf, type AgentPublic, type Group } from "@/lib/domain";
import { plainText, shortDuration, since } from "@/lib/format";
import { paletteFor } from "@/lib/palette";
import { GROUP_COLOR, GROUP_LABEL } from "../status";

export function AgentAvatar({ agent, size = 28 }: { agent: AgentPublic; size?: number }) {
  const p = paletteFor(agent.key, agent.appearance);
  return (
    <span
      aria-hidden
      className="relative inline-block shrink-0 border-2 border-line"
      style={{ width: size, height: size, background: p.shirt }}
    >
      <span className="absolute left-1/4 top-[12%] h-[45%] w-1/2" style={{ background: p.skin }} />
      <span className="absolute left-1/4 top-[6%] h-[18%] w-1/2" style={{ background: p.hair }} />
    </span>
  );
}

export function AgentDetailLine({ agent, multiline = false }: { agent: AgentPublic; multiline?: boolean }) {
  const textClass = multiline ? "line-clamp-2 wrap-anywhere" : "truncate";
  switch (agent.status) {
    case "working":
      return (
        <span className={multiline ? "flex min-w-0 flex-col items-start gap-1.5" : "flex min-w-0 items-center gap-2"}>
          <span className={textClass}>{agent.activity ?? "Working"}</span>
          {agent.progress !== null ? (
            <span
              className="inline-block h-2 w-16 shrink-0 border border-line bg-ink"
              role="progressbar"
              aria-label="Task progress"
              aria-valuenow={Math.round(agent.progress * 100)}
            >
              <span className="block h-full bg-working" style={{ width: `${agent.progress * 100}%` }} />
            </span>
          ) : null}
        </span>
      );
    case "waiting":
      return (
        <span className={textClass}>
          {agent.waitingFor ? `Waiting for ${agent.waitingFor}` : "Waiting"}
          {agent.waitingOn ? <span className="text-muted"> (on {agent.waitingOn})</span> : null}
          {agent.activity ? <span className="text-muted"> · {agent.activity}</span> : null}
        </span>
      );
    case "done":
      return (
        <span className={textClass}>
          {(agent.resultPreview && plainText(agent.resultPreview)) || agent.activity || "Finished"}
        </span>
      );
    case "error":
      return <span className={`${textClass} text-error`}>{agent.error ?? agent.activity ?? "Something went wrong"}</span>;
    default:
      return <span className={`${textClass} text-muted`}>{agent.activity ?? agent.role ?? "Idle"}</span>;
  }
}

export function PresenceBadges({ agent, nowMs }: { agent: AgentPublic; nowMs: number }) {
  if (nowMs === 0 || presenceOf(agent, nowMs) === "live") return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      {agent.status === "working" ? (
        <span className="border border-waiting px-1 font-pixel text-waiting">Stalled?</span>
      ) : null}
      <span>away · last seen {since(agent.lastSeenAt, nowMs)}</span>
    </span>
  );
}

export function AgentList({
  agents,
  nowMs,
  selectedKey,
  onSelect,
}: {
  agents: AgentPublic[];
  nowMs: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const byGroup = new Map<Group, AgentPublic[]>();
  for (const agent of agents) {
    const g = groupOf(agent);
    byGroup.set(g, [...(byGroup.get(g) ?? []), agent]);
  }
  return (
    <div className="flex flex-col gap-5">
      {GROUPS.filter((g) => byGroup.has(g)).map((group) => (
        <section key={group} aria-label={GROUP_LABEL[group]}>
          <h3 className="mb-2 font-pixel text-sm" style={{ color: GROUP_COLOR[group] }}>
            {GROUP_LABEL[group]} · {byGroup.get(group)!.length}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {byGroup.get(group)!.map((agent) => {
              const away = nowMs !== 0 && presenceOf(agent, nowMs) === "away";
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(agent.key)}
                    data-agent={agent.key}
                    aria-pressed={selectedKey === agent.key}
                    className={`flex w-full items-start gap-3 border-2 bg-panel-2 px-3 py-2 text-left text-sm hover:border-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-done ${
                      selectedKey === agent.key ? "border-text" : "border-line"
                    } ${away ? "opacity-60" : ""}`}
                  >
                    <AgentAvatar agent={agent} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2">
                        <span className="wrap-anywhere font-semibold leading-tight">{agent.displayName}</span>
                        <span className="text-xs tabular-nums text-muted" title="time in this state">
                          {nowMs ? shortDuration(nowMs - Date.parse(agent.statusChangedAt)) : ""}
                        </span>
                      </span>
                      <span className="mt-0.5 min-w-0 text-muted">
                        <AgentDetailLine agent={agent} multiline />
                      </span>
                      <PresenceBadges agent={agent} nowMs={nowMs} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
