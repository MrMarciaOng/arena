"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { loginAction, type LoginState } from "@/server/actions";
import type { Env } from "@/server/env";

const inputClass =
  "border-2 border-line bg-ink px-3 py-2 text-text outline-none placeholder:text-idle focus:border-muted disabled:opacity-60";
const linkButtonClass = "text-sm text-muted underline decoration-line underline-offset-4 hover:text-text disabled:no-underline disabled:opacity-60";
const LAST_EMAIL_KEY = "arena:last-login-email";

export type LoginNotice = "link-failed" | "signed-out";

export function LoginForm({
  next,
  provider,
  notice,
}: {
  next: string;
  provider: Env["ARENA_AUTH_PROVIDER"];
  notice?: LoginNotice;
}) {
  return provider === "supabase" ? (
    <MagicLinkForm next={next} notice={notice} />
  ) : (
    <PasswordForm next={next} notice={notice} />
  );
}

function PasswordForm({ next, notice }: { next: string; notice?: LoginNotice }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <>
      <h1 className="font-pixel text-2xl">Log in to Arena</h1>
      <p className="mt-1 text-sm text-muted">Enter the password set in ARENA_OWNER_PASSWORD.</p>
      {notice === "signed-out" && !state.error ? <Notice tone="info">You&apos;re signed out.</Notice> : null}
      <form action={action} className="mt-5 flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" required autoFocus autoComplete="current-password" className={inputClass} />
        </label>
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        <button type="submit" className="pixel-button" disabled={pending}>
          {pending ? "Checking…" : "Log in"}
        </button>
      </form>
    </>
  );
}

function MagicLinkForm({ next, notice }: { next: string; notice?: LoginNotice }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  // "Use a different email" hides the sent screen for this result; the next result shows again.
  const [dismissed, setDismissed] = useState<LoginState | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const secondsLeft = useCountdown(state);
  const sent = state.sent && dismissed !== state ? state.sent : null;

  useEffect(() => {
    if (state.sent) writeLastEmail(state.sent);
  }, [state.sent]);

  useEffect(() => {
    // Fill in the address used last time, without overriding anything typed already.
    const input = emailRef.current;
    if (!sent && input && !input.value) input.value = readLastEmail();
  }, [sent]);

  if (sent) {
    return (
      <CheckInbox
        email={sent}
        next={next}
        action={action}
        pending={pending}
        error={state.error}
        secondsLeft={secondsLeft}
        onChangeEmail={() => setDismissed(state)}
      />
    );
  }

  // A wait only blocks this form after a refusal; a new address can get a link straight away.
  const waitSeconds = state.sent ? 0 : secondsLeft;
  const linkFailed = notice === "link-failed" && !state.error;
  return (
    <>
      <h1 className="font-pixel text-2xl">Log in to Arena</h1>
      <p className="mt-1 text-sm text-muted">No password needed. We&apos;ll email you a link that signs you in.</p>
      {linkFailed ? (
        <Notice tone="error">That sign-in link has expired or was already used. Enter your email for a new one.</Notice>
      ) : notice === "signed-out" && !state.error ? (
        <Notice tone="info">You&apos;re signed out.</Notice>
      ) : null}
      <form action={action} className="mt-5 flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            ref={emailRef}
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            placeholder="you@example.com"
            // React resets the form after each submit; this keeps the address after a refusal.
            defaultValue={state.email ?? dismissed?.sent ?? ""}
            disabled={pending}
            className={inputClass}
          />
        </label>
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        <button type="submit" className="pixel-button" disabled={pending || waitSeconds > 0}>
          {pending ? "Sending link…" : waitSeconds > 0 ? `Try again in ${waitSeconds}s` : "Email me a sign-in link"}
        </button>
      </form>
    </>
  );
}

function CheckInbox({
  email,
  next,
  action,
  pending,
  error,
  secondsLeft,
  onChangeEmail,
}: {
  email: string;
  next: string;
  action: (form: FormData) => void;
  pending: boolean;
  error?: string;
  secondsLeft: number;
  onChangeEmail: () => void;
}) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    // Opening the link signs in this browser in a new tab. When the person comes back to this one,
    // refresh: the login page sends a signed-in visitor on to where they were going.
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  return (
    <div role="status" aria-live="polite">
      <div aria-hidden className="mb-3 font-pixel text-4xl leading-none text-done">✉</div>
      <h1 ref={headingRef} tabIndex={-1} className="font-pixel text-2xl outline-none">
        Check your inbox
      </h1>
      <p className="mt-2 text-sm text-muted">
        We sent a sign-in link to <span className="font-semibold text-text [overflow-wrap:anywhere]">{email}</span>.
      </p>
      <ol className="mt-4 flex list-none flex-col gap-2 text-sm">
        {["Open the email with your sign-in link.", "Select the link in it.", "You'll be signed in, in this browser."].map((step, i) => (
          <li key={step} className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-line bg-panel-2 font-pixel text-xs text-working">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      <p className="mt-4 border-l-2 border-line pl-3 text-xs text-muted">
        Open the link on this device and in this browser. It works once and expires after an hour. Not there after
        a minute? Check your spam folder.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form action={action} className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={email} />
        <button type="submit" className="pixel-button text-sm" disabled={pending || secondsLeft > 0}>
          {pending ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend link"}
        </button>
        <button type="button" className={linkButtonClass} onClick={onChangeEmail} disabled={pending}>
          Use a different email
        </button>
      </form>
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "info"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`mt-4 border-2 px-3 py-2 text-sm ${
        tone === "error" ? "border-error/60 bg-error/10 text-error" : "border-line bg-panel-2 text-muted"
      }`}
    >
      {children}
    </p>
  );
}

/** Seconds until another link can be requested, counted from when this result arrived. */
function useCountdown(state: LoginState): number {
  const [deadline, setDeadline] = useState<{ state: LoginState; at: number } | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!state.retryAfter) return;
    const at = Date.now() + state.retryAfter * 1000;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() >= at) clearInterval(timer);
    };
    const start = setTimeout(() => {
      setDeadline({ state, at });
      tick();
    }, 0);
    const timer = setInterval(tick, 250);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  }, [state]);
  if (!state.retryAfter) return 0;
  if (deadline?.state !== state) return state.retryAfter; // Before the first tick.
  return Math.max(0, Math.ceil((deadline.at - now) / 1000));
}

function readLastEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastEmail(email: string) {
  try {
    localStorage.setItem(LAST_EMAIL_KEY, email);
  } catch {
    // Private windows can refuse storage; the address just isn't remembered.
  }
}
