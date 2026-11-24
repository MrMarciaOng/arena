import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="pixel-panel p-6">
        <h1 className="font-pixel text-2xl">Owner login</h1>
        <p className="mt-1 text-sm text-muted">Enter the password set in ARENA_OWNER_PASSWORD.</p>
        <Suspense fallback={null}>
          <LoginFormWithNext searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

async function LoginFormWithNext({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next } = await searchParams;
  return <LoginForm next={typeof next === "string" ? next : "/"} />;
}
