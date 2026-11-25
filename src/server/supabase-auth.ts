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

export async function signInWithSupabase(
  env: SupabaseEnv,
  options: { store: CookieStore; secure: boolean; email: string; password: string },
): Promise<boolean> {
  const { store, secure, email, password } = options;
  const client = createSupabaseAuthClient(env, { secure, cookies: supabaseCookieStore(store, true) });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  return !error && data.session !== null;
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
