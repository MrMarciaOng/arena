"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { groupOf, type AgentDetail, type AgentEvent, type AgentPublic } from "@/lib/domain";
import { shortDuration, since } from "@/lib/format";
import { acknowledgeAction } from "@/server/actions";
import { Markdown } from "../Markdown";
import { StatusChip } from "../status";
import { AgentAvatar, AgentDetailLine, PresenceBadges } from "./AgentList";
import { useAgentDetail } from "./useAgentDetail";

/** The answer on screen. It stays put until the reader asks for a newer one or dismisses it. */
type ShownAnswer = { version: number; result: string | null; truncated: boolean };

const mobileDrawerQuery = "(width < 40rem)";

function subscribeToDrawerSize(callback: () => void) {
  const query = window.matchMedia(mobileDrawerQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function eventLabel(e: AgentEvent): string {
  const r = (e.report ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "agent.registered":
      return "registered";
    case "agent.updated":
      return "profile updated";
    case "agent.acknowledged":
      return "answer acknowledged";
    case "agent.removed":
      return "removed";
    case "agent.status": {
      const text = [r.status, r.activity ?? r.waitingFor ?? r.error].filter(Boolean).join(" · ");
      return e.applied ? String(text) : `${text} (arrived late, ignored)`;
    }
  }
}

const answerOf = (agent: AgentDetail | undefined): ShownAnswer | null =>
  agent?.status === "done" ? { version: agent.version, result: agent.result, truncated: agent.resultTruncated } : null;

const sameAnswer = (a: ShownAnswer, b: ShownAnswer) => a.result === b.result && a.truncated === b.truncated;

/**
 * What to show next. The first answer seen is pinned. The same text under a newer version (a
 * profile change) is adopted silently; a different answer, or the agent moving on, leaves the
 * pinned one in place for the reader to replace or dismiss.
 */
function nextShown(pinned: ShownAnswer | null, latest: ShownAnswer | null): ShownAnswer | null {
  if (!pinned) return latest;
  if (latest && sameAnswer(pinned, latest)) return latest;
  return pinned;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Render with `key={agent.id}` so switching agents starts from a clean state. */
export function AgentDrawer({
  slug,
  agent,
  nowMs,
  onClose,
}: {
  slug: string;
  agent: AgentPublic;
  nowMs: number;
  onClose: () => void;
}) {
  const { detail, error: loadError, load } = useAgentDetail(slug, agent.id, agent.key, agent.version, agent.lastSeenAt);
  const [pinned, setPinned] = useState<ShownAnswer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkCopy, setLinkCopy] = useState<{ href: string; copied: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const [retrying, setRetrying] = useState(false);
  const mobile = useSyncExternalStore(subscribeToDrawerSize, () => window.matchMedia(mobileDrawerQuery).matches, () => false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Keyboard: move focus into the drawer on open, back to whatever opened it on close; Escape closes.
  useLayoutEffect(() => {
    const drawer = closeButton.current?.closest("[data-agent-drawer]");
    const scope = drawer?.closest("[data-arena-view]");
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && scope?.contains(active) ? active : null;
    const dialog = drawer instanceof HTMLDialogElement ? drawer : null;
    const overflow = document.documentElement.style.overflow;
    if (dialog) {
      dialog.showModal();
      document.documentElement.style.overflow = "hidden";
    }
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key !== "Tab" || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), summary")]
        .filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      const focused = document.activeElement;
      if (e.shiftKey ? focused === first : focused === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const agentKey = opener?.getAttribute("data-agent") ?? opener?.getAttribute("data-agent-sprite");
    const attr = opener?.hasAttribute("data-agent") ? "data-agent" : "data-agent-sprite";
    return () => {
      document.removeEventListener("keydown", onKey);
      if (dialog) {
        dialog.close();
        document.documentElement.style.overflow = overflow;
      }
      const focused = document.activeElement;
      if (focused && scope?.contains(focused) && !drawer?.contains(focused)) return;
      if (opener?.isConnected && opener.getClientRects().length > 0) {
        opener.focus();
        return;
      }
      // The row that opened us moved (e.g. Done → Idle re-renders it in another group): find this
      // agent's control again by its key.
      if (agentKey && scope?.isConnected) {
        // The same kind of control first; if it's gone (a sprite hides when its agent goes home),
        // the agent's other control.
        const other = attr === "data-agent" ? "data-agent-sprite" : "data-agent";
        const target =
          scope.querySelector<HTMLElement>(`button[${attr}="${CSS.escape(agentKey)}"]`) ??
          scope.querySelector<HTMLElement>(`button[${other}="${CSS.escape(agentKey)}"]`);
        if (target?.getClientRects().length) {
          target.focus();
          return;
        }
      }
      scope?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    };
  }, [mobile]);

  // Fold each fetched detail into the pinned answer (adjusting state on new data, during render).
  const [seenDetail, setSeenDetail] = useState(detail);
  if (detail !== seenDetail) {
    setSeenDetail(detail);
    setPinned((p) => nextShown(p, answerOf(detail?.agent)));
  }

  const latest = answerOf(detail?.agent);
  const shown = pinned;
  const newer = shown && latest && !sameAnswer(shown, latest) ? latest : null;
  const movedOn = shown !== null && detail !== null && latest === null;
  const canAcknowledge = shown !== null && latest !== null && shown.version === latest.version;

  const acknowledge = () => {
    if (!shown) return;
    startTransition(async () => {
      const result = await acknowledgeAction({ slug, key: agent.key, version: shown.version });
      if (!result.ok) {
        setNotice(result.code === "unauthorized" ? "Log in as the owner to acknowledge." : result.error);
      } else if (result.status === "stale") {
        // Something changed on the server first. Show its newer answer if there is one; if the
        // agent has moved on (or the refresh failed), keep this answer on screen.
        const fresh = answerOf((await load())?.agent);
        if (fresh) {
          setPinned(fresh);
          setNotice("A newer answer arrived, so nothing was acknowledged. It's shown now.");
        } else {
          setNotice("The agent has changed since you opened this, so nothing was acknowledged.");
        }
      } else if (result.status === "not_done") {
        setNotice("This agent has moved on; nothing to acknowledge.");
      } else {
        setPinned(null);
        setNotice(null);
      }
    });
  };

  const copy = (text: string) => {
    void copyText(text).then((ok) =>
      setNotice(ok ? "Copied." : "Copying isn't available here (it needs HTTPS). Select the text and copy it instead."),
    );
  };

  async function copyAgentLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("agent", agent.key);
    setLinkCopy({ href: url.href, copied: await copyText(url.href) });
  }

  async function retryDetails() {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  }

  const Drawer = mobile ? "dialog" : "aside";
  return (
    <Drawer
      data-agent-drawer
      aria-label={`${agent.displayName} details`}
      aria-modal={mobile || undefined}
      className="pixel-panel fixed inset-y-0 right-0 z-30 m-0 flex max-h-none w-full max-w-xl flex-col overflow-hidden text-text max-sm:h-full max-sm:max-w-none max-sm:not-open:hidden sm:inset-y-4 sm:right-4"
    >
      <div className="border-b-2 border-line p-4">
        <div className="flex items-start gap-3">
          <AgentAvatar agent={agent} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="wrap-anywhere font-pixel text-xl">{agent.displayName}</h2>
            {agent.role ? <p className="wrap-anywhere text-sm text-muted">{agent.role}</p> : null}
            <p className="wrap-anywhere text-xs text-muted"><code>{agent.key}</code></p>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} className="pixel-button shrink-0 text-sm" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <button type="button" onClick={() => void copyAgentLink()} className="text-muted underline underline-offset-4 hover:text-text">
            Copy agent link
          </button>
          <span role="status" className="text-muted">
            {linkCopy ? (linkCopy.copied ? "Agent link copied." : "Couldn’t copy the link. Select it below.") : null}
          </span>
        </div>
        {linkCopy && !linkCopy.copied ? (
          <input
            type="text"
            readOnly
            aria-label="Agent link"
            value={linkCopy.href}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-2 w-full rounded border border-line bg-ink px-2 py-1 text-sm text-text"
          />
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip group={groupOf(agent)} />
          {nowMs ? (
            <span className="text-xs text-muted">for {shortDuration(nowMs - Date.parse(agent.statusChangedAt))}</span>
          ) : null}
          <PresenceBadges agent={agent} nowMs={nowMs} />
        </div>
        <p className="mt-3 flex min-w-0 items-center gap-2 text-sm">
          <AgentDetailLine agent={agent} />
        </p>

        {shown ? (
          <section className="mt-5">
            {newer ? (
              <div role="status" className="mb-2 flex items-center gap-2 border-2 border-done p-2 text-sm">
                <span className="flex-1">A newer answer arrived.</span>
                <button type="button" className="pixel-button text-xs" onClick={() => setPinned(newer)}>
                  Show it
                </button>
              </div>
            ) : null}
            {movedOn ? (
              <div role="status" className="mb-2 flex items-center gap-2 border-2 border-line p-2 text-sm">
                <span className="flex-1">The agent has started something else. This is its previous answer.</span>
                <button type="button" className="pixel-button text-xs" onClick={() => setPinned(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-pixel text-done">Answer</h3>
              {shown.result ? (
                <button type="button" className="pixel-button ml-auto text-xs" onClick={() => copy(shown.result!)}>
                  Copy
                </button>
              ) : null}
              <button
                type="button"
                className={`pixel-button text-xs ${shown.result ? "" : "ml-auto"}`}
                onClick={acknowledge}
                disabled={pending || !canAcknowledge}
                title={canAcknowledge ? "Mark as read and set the agent back to idle" : "Only the latest answer can be acknowledged"}
              >
                {pending ? "…" : "Acknowledge"}
              </button>
            </div>
            {shown.truncated ? (
              <p className="mb-2 text-xs text-waiting">This answer was cut to 64 KB when it arrived.</p>
            ) : null}
            {shown.result ? (
              <div className="select-text border-2 border-line bg-ink p-3 text-sm">
                <Markdown text={shown.result} />
              </div>
            ) : (
              <p className="text-sm text-muted">No answer text was sent.</p>
            )}
          </section>
        ) : agent.status === "done" && !detail && !loadError ? (
          <p className="mt-5 text-sm text-muted">Loading the answer…</p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-2 text-sm text-waiting">
            {notice}
          </p>
        ) : null}
        {loadError ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <p role="alert" className="wrap-anywhere text-error">Couldn&apos;t load details: {loadError}</p>
            <button type="button" className="pixel-button text-xs" disabled={retrying} onClick={() => void retryDetails()}>
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : null}

        {agent.metadata !== null ? (
          <details className="mt-6 text-sm">
            <summary className="cursor-pointer font-pixel text-muted">Metadata</summary>
            <pre className="mt-2 overflow-x-auto bg-ink p-3 text-xs">{JSON.stringify(agent.metadata, null, 2)}</pre>
          </details>
        ) : null}

        <section className="mt-6">
          <h3 className="mb-2 font-pixel text-muted">Timeline</h3>
          <ol className="flex flex-col gap-1 text-sm">
            {(detail?.events ?? []).map((e) => (
              <li key={e.id} className={`flex gap-3 ${e.applied ? "" : "text-muted line-through decoration-muted/40"}`}>
                <span className="w-20 shrink-0 text-xs leading-5 text-muted">{nowMs ? since(e.createdAt, nowMs) : ""}</span>
                <span className="min-w-0 break-words">{eventLabel(e)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Drawer>
  );
}
