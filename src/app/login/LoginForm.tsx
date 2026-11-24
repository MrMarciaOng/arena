"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/server/actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="mt-5 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          className="border-2 border-line bg-ink px-3 py-2 text-text outline-none focus:border-muted"
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
