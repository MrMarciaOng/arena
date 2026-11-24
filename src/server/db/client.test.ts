import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reportStatus } from "../agents";
import { createArena, getArena } from "../arenas";
import { rows } from "../../../test/helpers";
import { openDb, usesTransactionPooler } from "./client";
import { agents, changes } from "./schema";

describe("usesTransactionPooler", () => {
  it("recognises Supabase's transaction pooler and the pgbouncer hint", () => {
    expect(usesTransactionPooler("postgres://u:p@aws-0-x.pooler.supabase.com:6543/postgres")).toBe(true);
    expect(usesTransactionPooler("postgres://u:p@db.example.com:5432/postgres?pgbouncer=true")).toBe(true);
    expect(usesTransactionPooler("postgres://u:p@aws-0-x.pooler.supabase.com:5432/postgres")).toBe(false);
    expect(usesTransactionPooler("pglite:memory")).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("a real Postgres server", () => {
  it("connects with the pgbouncer hint in the URL (the hint is not sent to the server)", async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("pgbouncer", "true");
    const handle = await openDb(url.toString(), { migrate: false });
    try {
      expect(handle.kind).toBe("postgres");
      await handle.db.execute(sql`SELECT 1`);
    } finally {
      await handle.close();
    }
  });
});

describe("writeTx", () => {
  it("numbers concurrent writes uniquely and seats agents uniquely", async () => {
    process.env.ARENA_RATE_LIMIT_PER_10S = "100000";
    await createArena({ slug: "busy", name: "Busy", theme: "office" }, Date.now());
    const arena = await getArena("busy");
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => reportStatus(arena, `bot-${i % 8}`, { status: "working", activity: `step ${i}` }, Date.now())),
    );
    const seqs = (await rows(changes)).map((c) => c.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(24);
    expect(new Set(seqs).size).toBe(seqs.length);
    const seats = (await rows(agents)).map((a) => a.seat);
    expect(seats).toHaveLength(8);
    expect(new Set(seats).size).toBe(8);
  });
});
