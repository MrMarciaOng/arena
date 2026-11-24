"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
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

function RemoveAgentButton({ arena, agent }: { arena: ArenaPublic; agent: AgentPublic }) {
  const [state, action, pending] = useActionState<FormState, FormData>(removeAgentAction, {});
  useRefreshOnSuccess(state);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="slug" value={arena.slug} />
      <input type="hidden" name="key" value={agent.key} />
      <input type="hidden" name="agentId" value={agent.id} />
      {state.error ? <span className="text-xs text-error">{state.error}</span> : null}
      <button type="submit" className="pixel-button text-xs" disabled={pending} aria-label={`Remove ${agent.displayName}`}>
        Remove
      </button>
    </form>
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
      <section className="pixel-panel p-5">
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
              <li key={agent.id} className="flex items-center gap-3 text-sm" data-settings-agent={agent.key}>
                <span className="min-w-0 flex-1 truncate">
                  {agent.displayName} <span className="text-muted">({agent.key})</span>
                </span>
                <RemoveAgentButton arena={arena} agent={agent} />
              </li>
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
