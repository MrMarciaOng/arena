import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConnectAgents } from "@/components/connect/ConnectAgents";
import { findArena } from "@/server/arenas";
import { getOwnerSession } from "@/server/auth";
import { ownerLoginEnabled } from "@/server/env";
import { listKeys } from "@/server/keys";

export default function ConnectPage({ params, searchParams }: PageProps<"/arenas/[slug]/connect">) {
  return (
    <Suspense fallback={<p className="font-pixel text-muted">Loading…</p>}>
      <Connect params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Connect({ params, searchParams }: Pick<PageProps<"/arenas/[slug]/connect">, "params" | "searchParams">) {
  const { slug } = await params;
  const { key } = await searchParams;
  // Read the database per request, never at build time.
  await connection();
  const owner = await getOwnerSession();
  if (!owner) {
    return (
      <div className="pixel-panel mx-auto max-w-xl p-6">
        <h1 className="font-pixel text-2xl">Owner only</h1>
        <p className="mt-2 text-sm text-muted">
          {ownerLoginEnabled() ? (
            <>
              <Link href={`/login?next=/arenas/${encodeURIComponent(slug)}/connect`} className="underline">
                Log in
              </Link>{" "}
              to connect agents to this arena. It uses the arena&apos;s API keys.
            </>
          ) : (
            "Configure owner login to connect agents here."
          )}
        </p>
      </div>
    );
  }
  const arena = await findArena(slug, owner);
  if (!arena) notFound();
  const keys = await listKeys(arena);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-pixel text-3xl">Connect agents</h1>
        <span className="text-muted">to {arena.name}</span>
        <Link href={`/arenas/${arena.slug}`} className="ml-auto text-sm text-muted underline">
          Back to the arena
        </Link>
      </div>
      <p className="text-sm text-muted">
        Agents show up on the arena once they report to it. Pick a key, pick the tool you use, then copy the command or
        prompt and paste it.
      </p>
      <ConnectAgents slug={arena.slug} keys={keys} initialKeyId={typeof key === "string" ? key : null} />
    </div>
  );
}
