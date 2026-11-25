import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { getEnv } from "@/server/env";
import { secureSessionCookie } from "@/server/session";
import { confirmSupabaseLink } from "@/server/supabase-auth";

/** The sign-in link from the Supabase email lands here, sets the session cookie, and moves on. */
export async function GET(req: NextRequest) {
  const env = getEnv();
  const params = req.nextUrl.searchParams;
  const next = safeNext(params.get("next"));
  if (env.ARENA_AUTH_PROVIDER !== "supabase") redirect("/login");
  const signedIn = await confirmSupabaseLink(env, {
    store: await cookies(),
    secure: secureSessionCookie(env, req.headers, req.nextUrl.protocol),
    params,
  });
  if (signedIn) redirect(next);
  const login = new URLSearchParams({ error: "link" });
  if (next !== "/") login.set("next", next);
  redirect(`/login?${login}`);
}
