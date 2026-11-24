import { NextResponse, type NextRequest } from "next/server";
import { anonymousReadAllowed, getEnv, ownerLoginEnabled } from "./server/env";
import { SESSION_COOKIE, verifySessionValue } from "./server/session";

/**
 * Paths that are never gated: the API (each handler resolves its own credential), the login page,
 * Next's assets, and top-level public files (one path segment, like /file.svg). A page such as
 * /arenas/notes.txt has two segments, so it is still gated.
 */
const UNGATED = /^\/(?:api\/|login(?:\/|$)|_next\/|favicon\.ico$|[^/]+\.(?:png|svg|ico|webp|jpg|txt|webmanifest)$)/;

/**
 * Page gate only: no owner cookie, redirect to /login. It is not an auth boundary for Server
 * Actions (each action checks the session itself) or for the API.
 */
export async function proxy(req: NextRequest) {
  if (UNGATED.test(req.nextUrl.pathname)) return NextResponse.next();
  const env = getEnv();
  if (anonymousReadAllowed(env) || !ownerLoginEnabled(env)) return NextResponse.next();
  const ok = await verifySessionValue(
    req.cookies.get(SESSION_COOKIE)?.value,
    { secret: env.ARENA_SESSION_SECRET!, password: env.ARENA_OWNER_PASSWORD! },
    Date.now(),
  );
  if (ok) return NextResponse.next();
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
