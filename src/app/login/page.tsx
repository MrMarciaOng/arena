import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { safeNext } from "@/lib/safe-next";
import { getOwnerSession } from "@/server/auth";
import { getEnv } from "@/server/env";
import { LoginForm } from "./LoginForm";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="mx-auto mt-10 w-full max-w-sm sm:mt-16">
      <div className="pixel-panel p-6">
        <Suspense fallback={<h1 className="font-pixel text-2xl">Log in to Arena</h1>}>
          <LoginFormWithNext searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

async function LoginFormWithNext({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  await connection();
  const { next: rawNext, error, signedOut } = await searchParams;
  const next = safeNext(rawNext);
  // Already signed in (for example, the emailed link was opened in another tab): carry on.
  if (await getOwnerSession()) redirect(next);
  const provider = getEnv().ARENA_AUTH_PROVIDER;
  return (
    <LoginForm
      next={next}
      provider={provider}
      notice={error === "link" ? "link-failed" : signedOut === "1" ? "signed-out" : undefined}
    />
  );
}
