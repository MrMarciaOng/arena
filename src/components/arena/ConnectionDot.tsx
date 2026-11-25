import type { LiveState } from "@/lib/live-state";

const LABEL: Record<LiveState["connection"], string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  failed: "can't connect",
};

export function ConnectionDot({ state }: { state: LiveState["connection"] }) {
  const color =
    state === "live" ? "var(--color-working)" : state === "failed" ? "var(--color-error)" : "var(--color-waiting)";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted" role="status" aria-live="polite">
      <span
        aria-hidden
        className={`inline-block h-2.5 w-2.5 ${state === "live" || state === "failed" ? "" : "animate-blink"}`}
        style={{ background: color }}
      />
      {LABEL[state]}
    </span>
  );
}

export function ConnectionFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="pixel-panel flex flex-wrap items-center gap-3 p-4 text-sm">
      <p role="alert" className="text-error">Couldn’t connect to live updates.</p>
      <button type="button" className="pixel-button" onClick={onRetry}>Retry</button>
    </div>
  );
}
