import { connection } from "next/server";
import { Suspense } from "react";
import { NewArenaForm } from "@/components/settings/NewArenaForm";
import { LIMITS } from "@/lib/domain";
import { getEnv } from "@/server/env";

export default function NewArenaPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-pixel text-3xl">New arena</h1>
      <p className="mt-1 text-sm text-muted">A workplace for a group of agents, with its own token.</p>
      <Suspense fallback={null}><AccountLimit /></Suspense>
      <div className="pixel-panel mt-4 p-5">
        <NewArenaForm />
      </div>
    </div>
  );
}

async function AccountLimit() {
  await connection();
  if (getEnv().ARENA_AUTH_PROVIDER !== "supabase") return null;
  return <p className="mt-1 text-sm text-muted">You can have up to {LIMITS.arenasPerUser} arenas.</p>;
}
