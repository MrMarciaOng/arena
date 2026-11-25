import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SettingsForms } from "@/components/settings/SettingsForms";
import { listAgents } from "@/server/agents";
import { findArena } from "@/server/arenas";
import { legacyArenaOwner } from "@/server/arena-owner";
import { getOwnerSession } from "@/server/auth";
import { anonymousReadAllowed, ownerLoginEnabled } from "@/server/env";
import { listKeys } from "@/server/keys";
import { toArenaPublic } from "@/server/serialize";

export default function SettingsPage({ params }: PageProps<"/arenas/[slug]/settings">) {
  return (
    <Suspense fallback={<p className="font-pixel text-muted">Loading…</p>}>
      <Settings params={params} />
    </Suspense>
  );
}

async function Settings({ params }: Pick<PageProps<"/arenas/[slug]/settings">, "params">) {
  const { slug } = await params;
  // Read the database per request, never at build time.
  await connection();
  const owner = await getOwnerSession();
  const scope = owner ?? (anonymousReadAllowed() ? legacyArenaOwner : null);
  if (!scope) {
    return (
      <div className="pixel-panel mx-auto max-w-xl p-6">
        <h1 className="font-pixel text-2xl">Owner only</h1>
        <p className="mt-2 text-sm text-muted">
          {ownerLoginEnabled() ? (
            <>
              <Link href={`/login?next=/arenas/${encodeURIComponent(slug)}/settings`} className="underline">
                Log in
              </Link>{" "}
              to see this arena&apos;s settings.
            </>
          ) : (
            "Configure owner login to manage arenas here."
          )}
        </p>
      </div>
    );
  }
  const arena = await findArena(slug, scope);
  if (!arena) notFound();
  const [agents, keys] = await Promise.all([listAgents(arena), owner ? listKeys(arena) : null]);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="font-pixel text-3xl">{arena.name} · settings</h1>
        <Link href={`/arenas/${arena.slug}`} className="ml-auto text-sm text-muted underline">
          Back to the arena
        </Link>
      </div>
      {owner ? null : (
        <p className="border-2 border-waiting p-3 text-sm text-waiting">
          You&apos;re viewing without the owner session. <Link href={`/login?next=/arenas/${arena.slug}/settings`} className="underline">Log in</Link> to change anything.
        </p>
      )}
      <SettingsForms
        arena={toArenaPublic(arena)}
        agents={agents}
        keys={keys}
      />
    </div>
  );
}
