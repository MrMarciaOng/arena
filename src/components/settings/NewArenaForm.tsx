"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { THEMES } from "@/lib/domain";
import { createArenaAction, type FormState } from "@/server/arena-actions";
import { TokenReveal } from "./TokenReveal";

export const inputClass = "border-2 border-line bg-ink px-3 py-2 text-text outline-none focus:border-muted";

/**
 * Starts fresh each time the page is shown. Next keeps a page's state when you navigate away and
 * back; its effects are cleaned up when hidden, which is where we move on to a new, empty form.
 */
export function NewArenaForm() {
  const [round, setRound] = useState(0);
  useEffect(() => () => setRound((r) => r + 1), []);
  return <NewArenaFormRound key={round} onAnother={() => setRound((r) => r + 1)} />;
}

function NewArenaFormRound({ onAnother }: { onAnother: () => void }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createArenaAction, {});
  if (state.ok && state.slug && state.token) {
    return (
      <div>
        <p className="font-pixel text-lg text-working">Arena “{state.slug}” is ready.</p>
        <TokenReveal
          slug={state.slug}
          token={state.token}
          note={`Its first API key is called "${state.keyName}". Copy it now, or later from the arena's Settings.`}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/arenas/${state.slug}/connect${state.keyId ? `?key=${encodeURIComponent(state.keyId)}` : ""}`}
            className="pixel-button inline-block border-working text-working"
          >
            Connect agents
          </Link>
          <Link href={`/arenas/${state.slug}`} className="pixel-button inline-block">
            Open the arena
          </Link>
          <button type="button" className="pixel-button" onClick={onAnother}>
            Create another
          </button>
        </div>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" required maxLength={80} placeholder="Career" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Slug (used in URLs and the API)
        <input
          name="slug"
          required
          pattern="[a-z0-9][a-z0-9._\-]{0,63}"
          placeholder="career"
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Theme
        <select name="theme" defaultValue="office" className={inputClass}>
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="pixel-button" disabled={pending}>
        {pending ? "Creating…" : "Create arena"}
      </button>
    </form>
  );
}
