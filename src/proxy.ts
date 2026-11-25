import type { SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { anonymousReadAllowed, getEnv, passwordSessionKeys, type SupabaseEnv } from "./server/env";
import { secureSessionCookie, SESSION_COOKIE, verifySessionValue } from "./server/session";
import { createSupabaseAuthClient, readSupabaseSession } from "./server/supabase-auth";

/**
 * Skip the API, Next's assets, and top-level public files (one path segment, like /file.svg). A page such as
 * /arenas/notes.txt has two segments, so it is still gated.
 */
const SKIP_PROXY = /^\/(?:api\/|_next\/|[^/]+\.(?:png|svg|ico|webp|jpg|txt|webmanifest)$)/;
const LOGIN_PATH = /^\/login(?:\/|$)/;

/**
 * Page gate only: no owner cookie, redirect to /login. It is not an auth boundary for Server
 * Actions (each action checks the session itself) or for the API.
 */
export async function proxy(req: NextRequest) {
  if (SKIP_PROXY.test(req.nextUrl.pathname)) return NextResponse.next();
  const env = getEnv();
  const gated = !anonymousReadAllowed(env) && !LOGIN_PATH.test(req.nextUrl.pathname);
  if (env.ARENA_AUTH_PROVIDER === "supabase") return refreshSupabaseSession(req, env, gated);

  const keys = passwordSessionKeys(env);
  if (!gated || !keys) return NextResponse.next();
  return (await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value, keys, Date.now()))
    ? NextResponse.next()
    : redirectToLogin(req);
}

async function refreshSupabaseSession(req: NextRequest, env: SupabaseEnv, gated: boolean) {
  const pendingCookies: Parameters<SetAllCookies>[0] = [];
  const cacheHeaders = new Headers();
  const client = createSupabaseAuthClient(env, {
    secure: secureSessionCookie(env, req.headers, req.nextUrl.protocol),
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll(updates, headers) {
        for (const cookie of updates) req.cookies.set(cookie.name, cookie.value);
        pendingCookies.push(...updates);
        for (const [name, value] of Object.entries(headers)) cacheHeaders.set(name, value);
      },
    },
  });
  const session = await readSupabaseSession(client);
  const response = gated && !session ? redirectToLogin(req) : NextResponse.next({ request: req });
  for (const { name, value, options } of pendingCookies) response.cookies.set(name, value, options);
  for (const [name, value] of cacheHeaders) response.headers.set(name, value);
  return response;
}

function redirectToLogin(req: NextRequest) {
  const login = new URL("/login", req.url);
  const next = req.nextUrl.pathname + req.nextUrl.search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

// /api/ must be excluded here, not just skipped inside proxy(): for a matched request Next buffers
// the body (up to 10 MB) before the proxy runs, which would sidestep the API's auth and 256 KB limit.
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image).*)"],
};
