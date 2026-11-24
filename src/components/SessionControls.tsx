import Link from "next/link";
import { connection } from "next/server";
import { isOwner } from "@/server/auth";
import { logoutAction } from "@/server/actions";
import { ownerLoginEnabled } from "@/server/env";

/** Reads the session cookie, so it renders per request inside the layout's Suspense boundary. */
export async function SessionControls() {
  // The configuration is read per request; without this it could be prerendered from build-time env.
  await connection();
  if (!ownerLoginEnabled()) {
    return <span className="text-xs text-muted">read-only · no owner password set</span>;
  }
  if (await isOwner()) {
    return (
      <form action={logoutAction}>
        <button className="pixel-button text-xs" type="submit">
          Log out
        </button>
      </form>
    );
  }
  return (
    <Link href="/login" className="pixel-button text-xs">
      Log in
    </Link>
  );
}
