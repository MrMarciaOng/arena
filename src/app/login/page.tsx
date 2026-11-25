import { connection } from "next/server";
import { Suspense } from "react";
import { getEnv } from "@/server/env";
import { LoginForm } from "./LoginForm";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="pixel-panel p-6">
        <h1 className="font-pixel text-2xl">Log in to Arena</h1>
        <Suspense fallback={null}>
          <LoginFormWithNext searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

async function LoginFormWithNext({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  await connection();
  const { next, error } = await searchParams;
  const provider = getEnv().ARENA_AUTH_PROVIDER;
  return (
    <>
      <p className="mt-1 text-sm text-muted">
        {provider === "supabase"
          ? "Enter your email and we'll send you a sign-in link."
          : "Enter the password set in ARENA_OWNER_PASSWORD."}
      </p>
      <LoginForm next={typeof next === "string" ? next : "/"} provider={provider} linkFailed={error === "link"} />
    </>
  );
}
