"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { THEMES, type AgentPublic, type ApiKeyPublic, type ArenaPublic } from "@/lib/domain";
import { deleteArenaAction, removeAgentAction, updateArenaAction, type FormState } from "@/server/arena-actions";
import { ApiKeys } from "./ApiKeys";
import { inputClass } from "./NewArenaForm";

function Result({ state, okText }: { state: FormState; okText?: string }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-error">
        {state.error}
      </p>
    );
  }
  if (state.ok && okText) return <p className="text-sm text-working">{okText}</p>;
  return null;
}

/** Re-reads the server-rendered settings after a successful change. */
function useRefreshOnSuccess(state: FormState) {
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);
}

function RenameForm({ arena }: { arena: ArenaPublic }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateArenaAction, {});
  useRefreshOnSuccess(state);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="slug" value={arena.slug} />
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" defaultValue={arena.name} required maxLength={80} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Theme
        <select name="theme" defaultValue={arena.theme} className={inputClass}>
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <Result state={state} okText="Saved." />
      <button type="submit" className="pixel-button self-start" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function AgentSettingsRow({ arena, agent }: { arena: ArenaPublic; agent: AgentPublic }) {
  const [state, action, pending] = useActionState<FormState, FormData>(removeAgentAction, {});
  const [confirming, setConfirming] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useRefreshOnSuccess(state);

  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      removeButton.current?.focus();
    }
  }, [confirming]);

  return (
    <li className="text-sm" data-settings-agent={agent.key}>
      <form action={action} onSubmit={(event) => { if (!confirming || pending) event.preventDefault(); }}>
        <input type="hidden" name="slug" value={arena.slug} />
        <input type="hidden" name="key" value={agent.key} />
        <input type="hidden" name="agentId" value={agent.id} />
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 wrap-anywhere">
            {agent.displayName} <code className="text-muted">({agent.key})</code>
          </span>
          {!confirming ? (
            <button ref={removeButton} type="button" className="pixel-button text-xs" aria-label={`Remove ${agent.displayName}`} onClick={() => setConfirming(true)}>
              Remove
            </button>
          ) : null}
        </div>
        {confirming ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 border border-line bg-ink p-2">
            <p className="w-full wrap-anywhere">Remove {agent.displayName} (<code>{agent.key}</code>) from this arena?</p>
            <button
              ref={cancelButton}
              type="button"
              className="pixel-button text-xs"
              disabled={pending}
              onClick={() => {
                restoreFocus.current = true;
                setConfirming(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="pixel-button text-xs text-error" disabled={pending}>
              {pending ? "Removing…" : "Confirm removal"}
            </button>
          </div>
        ) : null}
        {state.error ? <p role="alert" className="mt-2 text-xs text-error">{state.error}</p> : null}
      </form>
    </li>
  );
}

function DeleteForm({ arena }: { arena: ArenaPublic }) {
  const [state, action, pending] = useActionState<FormState, FormData>(deleteArenaAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="slug" value={arena.slug} />
      <input type="hidden" name="arenaId" value={arena.id} />
      <label className="flex flex-col gap-1 text-sm">
        Type <code>{arena.slug}</code> to delete this arena, its agents and their history.
        <input name="confirm" autoComplete="off" className={inputClass} />
      </label>
      <Result state={state} />
      <button type="submit" className="pixel-button self-start border-error text-error" disabled={pending}>
        {pending ? "Deleting…" : "Delete arena"}
      </button>
    </form>
  );
}

export function SettingsForms({
  arena,
  agents,
  keys,
}: {
  arena: ArenaPublic;
  agents: AgentPublic[];
  /** null when the viewer isn't the owner: keys are never sent to anyone else. */
  keys: ApiKeyPublic[] | null;
}) {
  return (
    <>
      <section className="pixel-panel p-5">
        <h2 className="mb-3 font-pixel text-lg">Name and theme</h2>
        <RenameForm key={`${arena.name}-${arena.theme}`} arena={arena} />
      </section>
      <section id="api-keys" className="pixel-panel p-5">
        <h2 className="mb-3 font-pixel text-lg">API keys{keys ? ` · ${keys.length}` : ""}</h2>
        {keys ? (
          <ApiKeys slug={arena.slug} keys={keys} />
        ) : (
          <p className="text-sm text-muted">Only the owner can see and manage this arena&apos;s API keys.</p>
        )}
      </section>
      <section className="pixel-panel p-5">
        <h2 className="mb-3 font-pixel text-lg">Agents · {agents.length}</h2>
        {agents.length === 0 ? (
          <p className="text-sm text-muted">No agents yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {agents.map((agent) => (
              <AgentSettingsRow key={agent.id} arena={arena} agent={agent} />
            ))}
          </ul>
        )}
      </section>
      <section className="pixel-panel border-error p-5">
        <h2 className="mb-3 font-pixel text-lg text-error">Danger zone</h2>
        <DeleteForm arena={arena} />
      </section>
    </>
  );
}
