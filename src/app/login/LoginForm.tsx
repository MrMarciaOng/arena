"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/server/actions";
import type { Env } from "@/server/env";

const inputClass = "border-2 border-line bg-ink px-3 py-2 text-text outline-none focus:border-muted";

export function LoginForm({ next, provider }: { next: string; provider: Env["ARENA_AUTH_PROVIDER"] }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="mt-5 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      {provider === "supabase" ? (
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoFocus autoComplete="username" className={inputClass} />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          name="password"
          type="password"
          required
          autoFocus={provider === "password"}
          autoComplete="current-password"
          className={inputClass}
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="pixel-button" disabled={pending}>
        {pending ? "Checking…" : "Log in"}
      </button>
    </form>
  );
}
