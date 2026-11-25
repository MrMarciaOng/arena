import { createServerClient, isChunkLike, type CookieMethodsServer } from "@supabase/ssr";
import type { cookies } from "next/headers";
import { z } from "zod";
import type { SupabaseEnv } from "./env";

const SESSION_COOKIE = "arena_supabase_session";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function cookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };
}

export function createSupabaseAuthClient(env: SupabaseEnv, options: { cookies: CookieMethodsServer; secure: boolean }) {
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: { name: SESSION_COOKIE, ...cookieOptions(options.secure) },
    cookies: options.cookies,
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

const sessionClaims = z.object({
  sub: z.uuid().toLowerCase(),
  role: z.literal("authenticated"),
  exp: z.int().positive(),
  is_anonymous: z.literal(false).optional(),
});

export async function readSupabaseSession(client: ReturnType<typeof createSupabaseAuthClient>) {
  try {
    const { data, error } = await client.auth.getClaims();
    if (error || !data) return null;
    const claims = sessionClaims.safeParse(data.claims);
    if (!claims.success) return null;
    const expiresAt = claims.data.exp * 1000;
    return expiresAt > Date.now() ? { ownerUserId: claims.data.sub, expiresAt } : null;
  } catch {
    // The SDK can throw while decoding a malformed session cookie.
    return null;
  }
}

export function supabaseCookieStore(store: CookieStore, writable: boolean): CookieMethodsServer {
  return {
    getAll: () => store.getAll(),
    setAll(updates) {
      if (writable) {
        for (const { name, value, options } of updates) store.set(name, value, options);
      }
    },
  };
}

export type MagicLinkResult = { ok: true } | { ok: false; rateLimited: boolean; retryAfter?: number };

/** Supabase says "you can only request this after 42 seconds" when the same email asks too soon. */
function retryAfterSeconds(message: string): number | undefined {
  const seconds = /after (\d+) seconds?/i.exec(message)?.[1];
  return seconds ? Number(seconds) : undefined;
}

/**
 * Emails a sign-in link. Supabase creates the account on first use unless sign-ups are turned off
 * (Authentication → Sign In / Providers). The default email link uses PKCE: its code verifier is
 * kept in a cookie, so the link must be opened in the browser that asked for it. A custom email
 * template with a token-hash link (README) works in any browser.
 */
export async function sendSupabaseMagicLink(
  env: SupabaseEnv,
  options: { store: CookieStore; secure: boolean; email: string; redirectTo: string },
): Promise<MagicLinkResult> {
  const { store, secure, email, redirectTo } = options;
  const client = createSupabaseAuthClient(env, { secure, cookies: supabaseCookieStore(store, true) });
  try {
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    if (!error) return { ok: true };
    return { ok: false, rateLimited: error.status === 429, retryAfter: retryAfterSeconds(error.message) };
  } catch {
    return { ok: false, rateLimited: false };
  }
}

const linkType = z.enum(["email", "magiclink", "signup"]);

/** Turns the link from the email (token_hash + type, or a PKCE code) into a session cookie. */
export async function confirmSupabaseLink(
  env: SupabaseEnv,
  options: { store: CookieStore; secure: boolean; params: URLSearchParams },
): Promise<boolean> {
  const { store, secure, params } = options;
  const client = createSupabaseAuthClient(env, { secure, cookies: supabaseCookieStore(store, true) });
  const tokenHash = params.get("token_hash");
  const type = linkType.safeParse(params.get("type"));
  const code = params.get("code");
  try {
    if (tokenHash && type.success) {
      const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: type.data });
      return !error && data.session !== null;
    }
    if (code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      return !error && data.session !== null;
    }
  } catch {
    // A malformed or reused link.
  }
  return false;
}

export async function signOutFromSupabase(env: SupabaseEnv, options: { store: CookieStore; secure: boolean }) {
  const { store, secure } = options;
  const client = createSupabaseAuthClient(env, { secure, cookies: supabaseCookieStore(store, true) });
  try {
    await client.auth.signOut({ scope: "local" });
  } catch {
    // Clear the browser's session even when the provider cannot sign it out.
  }
  for (const { name } of store.getAll()) {
    if (isChunkLike(name, SESSION_COOKIE)) store.set(name, "", { ...cookieOptions(secure), maxAge: 0 });
  }
}
