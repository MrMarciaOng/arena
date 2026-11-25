import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArenaView } from "@/components/arena/ArenaView";
import { slugSchema } from "@/lib/schemas";

export default function ArenaPage({ params }: PageProps<"/arenas/[slug]">) {
  return (
    <div data-workspace-page>
      <Suspense fallback={<p className="font-pixel text-muted">Loading…</p>}>
        <ArenaFromParams params={params} />
      </Suspense>
    </div>
  );
}

async function ArenaFromParams({ params }: Pick<PageProps<"/arenas/[slug]">, "params">) {
  const { slug } = await params;
  // A slug the API would reject (e.g. "/arenas/Career") can never load; don't open a stream for it.
  if (!slugSchema.safeParse(slug).success) notFound();
  return <ArenaView key={slug} slug={slug} />;
}
