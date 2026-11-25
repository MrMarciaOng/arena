import { eq, isNull } from "drizzle-orm";
import type { arenas, changes, ArenaRow } from "./db/schema";

export type ArenaOwner = Pick<ArenaRow, "ownerUserId">;

export const legacyArenaOwner: ArenaOwner = { ownerUserId: null };

/** A null owner is the legacy password workspace. An omitted owner is an admin-level query. */
export function arenaOwnerFilter(column: typeof arenas.ownerUserId | typeof changes.ownerUserId, owner?: ArenaOwner) {
  if (!owner) return undefined;
  return owner.ownerUserId === null ? isNull(column) : eq(column, owner.ownerUserId);
}
