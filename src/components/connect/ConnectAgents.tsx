"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CONNECT_TOOLS,
  TOOL_LABEL,
  assistantPrompt,
  curlExample,
  installCommand,
  reporterExamples,
  uninstallCommand,
  type ConnectTool,
  type ConnectValues,
} from "@/lib/connect";
import type { ApiKeyPublic } from "@/lib/domain";
import { since } from "@/lib/format";
import { agentsOf } from "@/lib/live-state";
import { createKeyAction, revealKeyAction } from "@/server/arena-actions";
import { useLiveStream, useNow } from "../live/useLiveStream";
import { inputClass } from "../settings/NewArenaForm";

const noop = () => () => {};
const SUGGESTED_KEY_NAME: Record<ConnectTool, string> = {
  claude: "claude-code",
  codex: "codex",
  assistant: "assistant",
  shell: "scripts",
};

function defaultKeyId(keys: ApiKeyPublic[], wanted: string | null): string | null {
  const copyable = keys.filter((k) => k.copyable);
  if (wanted && copyable.some((k) => k.id === wanted)) return wanted;
  return [...copyable].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ?? null;
}

/** A snippet shown with the masked key and copied with the real one (null until the key is loaded). */
type Snippet = { display: string; copy: string | null };

function CopyBlock({ id, title, children, snippet }: { id: string; title: string; children?: ReactNode; snippet: Snippet }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    if (!snippet.copy) return;
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(snippet.copy);
      setResult("copied");
      timer.current = setTimeout(() => setResult(null), 2500);
    } catch {
      // No clipboard (plain HTTP, or permission refused): show the text to select by hand.
      setResult("failed");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-snippet={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        <button
          type="button"
          className="pixel-button text-xs"
          onClick={() => void copy()}
          disabled={!snippet.copy}
          aria-label={`Copy: ${title}`}
        >
          {result === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {children}
      {result === "failed" && snippet.copy ? (
        <textarea
          aria-label={title}
          readOnly
          rows={Math.min(14, snippet.copy.split("\n").length + 1)}
          value={snippet.copy}
          onFocus={(event) => event.currentTarget.select()}
          autoFocus
          className="w-full bg-ink p-3 font-mono text-xs"
        />
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere bg-ink p-3 text-xs">{snippet.display}</pre>
      )}
      <p role="status" className="min-h-4 text-xs text-muted">
        {result === "copied" ? "Copied." : result === "failed" ? "Copying isn't available here. Select the text and copy it." : ""}
      </p>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

export function ConnectAgents({
  slug,
  keys,
  initialKeyId,
}: {
  slug: string;
  keys: ApiKeyPublic[];
  initialKeyId: string | null;
}) {
  const router = useRouter();
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "");
  const [keyId, setKeyId] = useState(() => defaultKeyId(keys, initialKeyId));
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [tokenErrors, setTokenErrors] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState(false);
  const [tool, setTool] = useState<ConnectTool>("claude");
  const [creating, startCreate] = useTransition();
  const [createError, setCreateError] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const ids = useId();

  // Load the chosen key (the owner's own, fetched on demand and never put in the page's HTML).
  useEffect(() => {
    if (!keyId || tokens[keyId] || tokenErrors[keyId]) return;
    let cancelled = false;
    revealKeyAction({ slug, id: keyId }).then(
      (result) => {
        if (cancelled) return;
        if (result.token) setTokens((t) => ({ ...t, [keyId]: result.token! }));
        else setTokenErrors((e) => ({ ...e, [keyId]: result.error ?? "Couldn't load this key." }));
      },
      () => {
        if (!cancelled) setTokenErrors((e) => ({ ...e, [keyId]: "Couldn't load this key." }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [keyId, slug, tokens, tokenErrors]);

  function createKey(form: FormData) {
    startCreate(async () => {
      const result = await createKeyAction({}, form);
      if (result.ok && result.keyId && result.token) {
        setTokens((t) => ({ ...t, [result.keyId!]: result.token! }));
        setKeyId(result.keyId);
        setCreateError(null);
        router.refresh();
      } else {
        setCreateError(result.error ?? "Couldn't create the key.");
      }
    });
  }

  const selected = keys.find((k) => k.id === keyId);
  const realToken = keyId ? tokens[keyId] : undefined;
  const masked = selected?.prefix ?? (realToken ? `${realToken.slice(0, 10)}…` : "arena_…");
  const display: ConnectValues = { origin, slug, token: showKey && realToken ? realToken : masked };
  const real: ConnectValues | null = realToken && origin ? { origin, slug, token: realToken } : null;
  const snippet = (build: (v: ConnectValues) => string): Snippet => ({ display: build(display), copy: real ? build(real) : null });
  const plain = (text: string): Snippet => ({ display: text, copy: text });

  // Live: agents appear here as they first report.
  const arenas = useMemo(() => [slug], [slug]);
  const live = useLiveStream(arenas);
  const nowMs = useNow(5000, live.clockOffsetMs);
  const liveArena = Object.values(live.arenas).find((a) => a.slug === slug);
  const agents = liveArena ? agentsOf(live, liveArena.id) : [];
  const latest = [...agents].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const n = CONNECT_TOOLS.length;
    const next =
      event.key === "ArrowRight" ? (index + 1) % n
        : event.key === "ArrowLeft" ? (index - 1 + n) % n
          : event.key === "Home" ? 0
            : event.key === "End" ? n - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTool(CONNECT_TOOLS[next]);
    tabRefs.current[next]?.focus();
  }

  const copyable = keys.filter((k) => k.copyable);
  const installer = `${origin}/api/connect/install.js`;
  const installNote = (
    <Note>
      Run it in a terminal on macOS or Linux (on Windows, in WSL). It needs Node.js 18 or newer, saves the key in{" "}
      <code>~/.config/arena/env</code> where only you can read it, and backs up any settings file before changing it.{" "}
      <a href={installer} target="_blank" rel="noreferrer" className="underline">
        Read the installer
      </a>{" "}
      before you run it.
    </Note>
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="pixel-panel p-5" aria-labelledby={`${ids}-key`}>
        <h2 id={`${ids}-key`} className="mb-1 font-pixel text-lg">
          1. Choose a key
        </h2>
        <p className="mb-3 text-sm text-muted">
          The commands below use this key. Give each machine or tool its own, so you can revoke one without breaking the
          rest.
        </p>
        {copyable.length === 0 ? (
          <p className="mb-3 text-sm text-waiting">This arena has no key that can be copied. Create one to continue.</p>
        ) : null}
        {keys.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">API key</legend>
            {keys.map((k) => (
              <label
                key={k.id}
                data-key-option={k.name}
                className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-2 p-2 text-sm ${k.id === keyId ? "border-muted bg-panel-2" : "border-line"} ${k.copyable ? "cursor-pointer" : "opacity-60"}`}
              >
                <input
                  type="radio"
                  name={`${ids}-key-choice`}
                  value={k.id}
                  checked={k.id === keyId}
                  disabled={!k.copyable}
                  onChange={() => setKeyId(k.id)}
                />
                <span className="font-semibold">{k.name}</span>
                <code className="text-xs text-muted">{k.prefix}</code>
                <span className="ml-auto text-xs text-muted">
                  {!k.copyable
                    ? "can't be shown again"
                    : k.lastUsedAt
                      ? `last used ${nowMs ? since(k.lastUsedAt, nowMs) : ""}`
                      : "never used"}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs" role="status">
          {keyId && tokenErrors[keyId] ? (
            <span className="text-error">{tokenErrors[keyId]}</span>
          ) : keyId && !realToken ? (
            <span className="text-muted">Loading the key…</span>
          ) : realToken ? (
            <>
              <span className="text-working">Ready: Copy puts the full key in each command.</span>
              <button type="button" className="underline underline-offset-4" onClick={() => setShowKey((s) => !s)}>
                {showKey ? "Hide key" : "Show key"}
              </button>
            </>
          ) : null}
        </div>
        <form action={createKey} className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="slug" value={slug} />
          <label className="flex flex-col gap-1 text-sm">
            New key
            <input key={tool} name="name" required maxLength={40} defaultValue={SUGGESTED_KEY_NAME[tool]} className={inputClass} />
          </label>
          <button type="submit" className="pixel-button" disabled={creating}>
            {creating ? "Creating…" : "Create key"}
          </button>
          {createError ? (
            <p role="alert" className="w-full text-sm text-error">
              {createError}
            </p>
          ) : null}
        </form>
      </section>

      <section className="pixel-panel p-5" aria-labelledby={`${ids}-tool`}>
        <h2 id={`${ids}-tool`} className="mb-3 font-pixel text-lg">
          2. Pick your tool
        </h2>
        <div role="tablist" aria-label="Tool" className="mb-4 flex flex-wrap gap-1.5">
          {CONNECT_TOOLS.map((t, i) => (
            <button
              key={t}
              ref={(node) => {
                tabRefs.current[i] = node;
              }}
              type="button"
              role="tab"
              id={`${ids}-tab-${t}`}
              aria-selected={tool === t}
              aria-controls={`${ids}-panel`}
              tabIndex={tool === t ? 0 : -1}
              onClick={() => setTool(t)}
              onKeyDown={(event) => onTabKey(event, i)}
              className="workspace-view-button"
            >
              {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tool}`} className="flex flex-col gap-5">
          {tool === "claude" ? (
            <>
              <CopyBlock id="claude-skill" title="Let Claude report for itself (recommended)" snippet={snippet((v) => installCommand(v, ["skill"]))}>
                <Note>
                  Installs the <code>arena-presence</code> skill. Claude keeps its own card current: what it&apos;s working
                  on, how far along it is, when it needs you, and its answer when it&apos;s done.
                </Note>
              </CopyBlock>
              <CopyBlock id="claude-hooks" title="Or report every session automatically" snippet={snippet((v) => installCommand(v, ["claude-hooks"]))}>
                <Note>
                  Adds hooks to <code>~/.claude/settings.json</code>. Every session shows your prompt while it works,{" "}
                  <strong>Needs you</strong> at permission prompts, and Claude&apos;s last message when it stops. Claude
                  doesn&apos;t have to do anything. Pick one of the two, or each session gets two cards.
                </Note>
              </CopyBlock>
              {installNote}
            </>
          ) : tool === "codex" ? (
            <>
              <CopyBlock id="codex" title="Install the skill and Codex's notify" snippet={snippet((v) => installCommand(v, ["skill", "codex"]))}>
                <Note>
                  The skill lets Codex report for itself while it works, and <code>notify</code> in{" "}
                  <code>~/.codex/config.toml</code> reports each finished turn with its answer. Codex runs only one notify
                  program, so the installer won&apos;t replace one you already have. In a sandbox without network access,
                  allow it for Arena&apos;s URL.
                </Note>
              </CopyBlock>
              {installNote}
            </>
          ) : tool === "assistant" ? (
            <CopyBlock id="assistant" title="Paste this into your AI assistant" snippet={snippet(assistantPrompt)}>
              <Note>
                For assistants that can run commands or make web requests, such as Cursor, Windsurf, ChatGPT in agent mode,
                or your own agents. No install needed. A chat that can&apos;t reach the internet can&apos;t report.
              </Note>
              <p className="border-2 border-waiting p-2 text-xs text-waiting">
                Pasting this shares the key with that AI service. Use a key made just for it (create one above), so you
                can revoke it on its own.
              </p>
            </CopyBlock>
          ) : (
            <>
              <CopyBlock id="reporter" title="Install the reporter" snippet={snippet((v) => installCommand(v, ["reporter"]))}>
                <Note>
                  Puts <code>arena-report.mjs</code> in <code>~/.config/arena/bin</code>. It never fails the job that
                  calls it, and never prints the key.
                </Note>
              </CopyBlock>
              <CopyBlock id="reporter-examples" title="Then report from any script or cron job" snippet={plain(reporterExamples())} />
              <CopyBlock id="curl" title="Or call the API directly" snippet={snippet((v) => curlExample(v))}>
                <Note>
                  The first report adds the agent. Statuses: <code>idle</code>, <code>working</code> (
                  <code>activity</code>, <code>progress</code> 0–1), <code>waiting</code> (<code>waitingOn</code>:{" "}
                  <code>human</code>, <code>agent</code> or <code>external</code>; <code>waitingFor</code>),{" "}
                  <code>done</code> (<code>result</code>, markdown) and <code>error</code> (<code>error</code>).
                </Note>
              </CopyBlock>
              {installNote}
            </>
          )}
        </div>
      </section>

      <section className="pixel-panel p-5" aria-labelledby={`${ids}-check`}>
        <h2 id={`${ids}-check`} className="mb-2 font-pixel text-lg">
          3. Watch it arrive
        </h2>
        <p role="status" className="text-sm" data-connect-status>
          {agents.length === 0 ? (
            <span className="text-muted">No agents yet. This updates as soon as one reports.</span>
          ) : (
            <>
              <span className="text-working">
                {agents.length} agent{agents.length === 1 ? "" : "s"} on this arena.
              </span>{" "}
              {latest ? (
                <span className="text-muted">
                  Latest: {latest.displayName}
                  {nowMs ? `, ${since(latest.lastSeenAt, nowMs)}` : ""}.
                </span>
              ) : null}
            </>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link href={`/arenas/${slug}`} className="pixel-button inline-block">
            Open the arena
          </Link>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Remove it from this machine later</summary>
            <div className="mt-2">
              <CopyBlock id="uninstall" title="Uninstall" snippet={plain(uninstallCommand(origin))}>
                <Note>
                  Removes the skill, the hooks, Codex&apos;s notify line, the scripts and <code>~/.config/arena/env</code>.
                </Note>
              </CopyBlock>
            </div>
          </details>
        </div>
      </section>
    </div>
  );
}
