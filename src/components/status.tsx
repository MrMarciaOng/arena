import type { Group } from "@/lib/domain";

export const GROUP_LABEL: Record<Group, string> = {
  needsYou: "Needs you",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  error: "Error",
  idle: "Idle",
};

export const GROUP_COLOR: Record<Group, string> = {
  needsYou: "var(--color-needs-you)",
  working: "var(--color-working)",
  waiting: "var(--color-waiting)",
  done: "var(--color-done)",
  error: "var(--color-error)",
  idle: "var(--color-idle)",
};

export function StatusChip({ group, label }: { group: Group; label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 border-2 px-1.5 py-0 font-pixel text-xs leading-5"
      style={{ borderColor: GROUP_COLOR[group], color: GROUP_COLOR[group] }}
    >
      <span aria-hidden className={group === "needsYou" ? "animate-blink" : undefined}>
        ■
      </span>
      {label ?? GROUP_LABEL[group]}
    </span>
  );
}

export function CountChips({
  counts,
  compact = false,
  onSelect,
  selected,
}: {
  counts: Record<Group, number> & { away: number };
  compact?: boolean;
  onSelect?: (group: Group) => void;
  selected?: Group;
}) {
  const order: Group[] = ["needsYou", "working", "waiting", "done", "error", "idle"];
  const shown = order.filter((g) => counts[g] > 0);
  if (shown.length === 0) return <span className="text-sm text-muted">No agents yet</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((g) => {
        const chip = <StatusChip group={g} label={`${counts[g]} ${compact ? "" : GROUP_LABEL[g].toLowerCase()}`.trim()} />;
        return onSelect ? (
          <button
            key={g}
            type="button"
            aria-pressed={selected === g}
            onClick={() => onSelect(g)}
            className="cursor-pointer hover:bg-panel-2 aria-pressed:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-done"
          >
            {chip}
          </button>
        ) : <span key={g}>{chip}</span>;
      })}
      {counts.away > 0 ? <span className="px-1 text-xs leading-6 text-muted">{counts.away} away</span> : null}
    </div>
  );
}
