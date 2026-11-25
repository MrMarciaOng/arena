"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/server/actions";
import type { Env } from "@/server/env";

const inputClass = "border-2 border-line bg-ink px-3 py-2 text-text outline-none focus:border-muted";

export function LoginForm({
  next,
  provider,
  linkFailed = false,
}: {
  next: string;
  provider: Env["ARENA_AUTH_PROVIDER"];
  linkFailed?: boolean;
}) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const error = state.error ?? (linkFailed && !state.sent ? "That sign-in link is invalid or has expired. Request a new one." : undefined);
  return (
    <form action={action} className="mt-5 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      {provider === "supabase" ? (
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoFocus autoComplete="email" className={inputClass} />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" required autoFocus autoComplete="current-password" className={inputClass} />
        </label>
      )}
      {state.sent ? (
        <p role="status" className="text-sm text-muted">
          Check {state.sent} for a sign-in link. You can close this tab.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}
      <button type="submit" className="pixel-button" disabled={pending}>
        {provider === "supabase"
          ? pending ? "Sending…" : state.sent ? "Send another link" : "Email me a sign-in link"
          : pending ? "Checking…" : "Log in"}
      </button>
    </form>
  );
}
