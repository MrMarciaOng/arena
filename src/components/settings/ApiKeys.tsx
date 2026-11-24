"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import type { ApiKeyPublic } from "@/lib/domain";
import { since } from "@/lib/format";
import { createKeyAction, revealKeyAction, revokeKeyAction, type FormState } from "@/server/arena-actions";
import { useNow } from "../live/useLiveStream";
import { inputClass } from "./NewArenaForm";
import { TokenReveal } from "./TokenReveal";

function KeyRow({ slug, apiKey, nowMs }: { slug: string; apiKey: ApiKeyPublic; nowMs: number }) {
  const router = useRouter();
  const [shown, setShown] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [revokeState, revoke, revoking] = useActionState<FormState, FormData>(revokeKeyAction, {});

  useEffect(() => {
    if (revokeState.ok) router.refresh();
  }, [revokeState, router]);

  const fetchKey = (then: (token: string) => void) =>
    startTransition(async () => {
      const result = await revealKeyAction({ slug, id: apiKey.id });
      if (result.token) then(result.token);
      else setMessage(result.error ?? "Couldn't load the key.");
    });

  const copy = () =>
    fetchKey(async (token) => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("unavailable");
        await navigator.clipboard.writeText(token);
        setMessage("Copied.");
      } catch {
        // No clipboard over plain HTTP: show it to select by hand instead.
        setShown(token);
        setMessage("Copying needs HTTPS here. Select the key below instead.");
      }
    });

  return (
    <li className="flex flex-col gap-1 border-2 border-line p-2 text-sm" data-key-name={apiKey.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{apiKey.name}</span>
        <code className="text-xs text-muted">{apiKey.prefix}</code>
        <span className="text-xs text-muted">
          created {nowMs ? since(apiKey.createdAt, nowMs) : ""}
          {apiKey.lastUsedAt ? ` · last used ${nowMs ? since(apiKey.lastUsedAt, nowMs) : ""}` : " · never used"}
        </span>
        <span className="ml-auto flex gap-1.5">
          <button
            type="button"
            className="pixel-button text-xs"
            onClick={copy}
            disabled={pending || !apiKey.copyable}
            title={apiKey.copyable ? "Copy this key" : "This key can't be shown again; create a new one"}
          >
            Copy
          </button>
          <button
            type="button"
            className="pixel-button text-xs"
            onClick={() => (shown ? setShown(null) : fetchKey(setShown))}
            disabled={pending || !apiKey.copyable}
          >
            {shown ? "Hide" : "Show"}
          </button>
          <form
            action={revoke}
            onSubmit={(e) => {
              if (!window.confirm(`Revoke "${apiKey.name}"? Agents using it stop working at once.`)) e.preventDefault();
            }}
          >
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="id" value={apiKey.id} />
            <button type="submit" className="pixel-button text-xs text-error" disabled={revoking} aria-label={`Revoke ${apiKey.name}`}>
              Revoke
            </button>
          </form>
        </span>
      </div>
      {!apiKey.copyable ? (
        <p className="text-xs text-muted">This key can&apos;t be shown again. Create a new one if you need to copy it.</p>
      ) : null}
      {shown ? (
        <code className="select-all break-all bg-ink p-2 text-xs" data-testid="revealed-key">
          {shown}
        </code>
      ) : null}
      {message ? <p className="text-xs text-muted">{message}</p> : null}
      {revokeState.error ? <p className="text-xs text-error">{revokeState.error}</p> : null}
    </li>
  );
}

export function ApiKeys({ slug, keys }: { slug: string; keys: ApiKeyPublic[] }) {
  const router = useRouter();
  const nowMs = useNow(30_000);
  const [state, action, pending] = useActionState<FormState, FormData>(createKeyAction, {});
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Agents send a key as <code>Authorization: Bearer &lt;key&gt;</code>. A key works for this arena only. Give each machine or
        agent its own, so you can revoke one without breaking the rest.
      </p>
      {keys.length === 0 ? (
        <p className="text-sm text-waiting">No keys. Agents can&apos;t report to this arena until you create one.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.map((k) => (
            <KeyRow key={k.id} slug={slug} apiKey={k} nowMs={nowMs} />
          ))}
        </ul>
      )}
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="slug" value={slug} />
        <label className="flex flex-col gap-1 text-sm">
          New key name
          <input name="name" required maxLength={40} placeholder="laptop" className={inputClass} />
        </label>
        <button type="submit" className="pixel-button" disabled={pending}>
          {pending ? "Creating…" : "Create key"}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.token && state.slug && keys.some((k) => k.id === state.keyId) ? (
        <TokenReveal slug={state.slug} token={state.token} note={`Key "${state.keyName}" is ready. You can copy it again here later.`} />
      ) : null}
    </div>
  );
}
