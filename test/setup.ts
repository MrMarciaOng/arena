import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { openDb, setDbForTests, type Handle } from "@/server/db/client";
import { ADMIN_TOKEN, OWNER_PASSWORD, SESSION_SECRET } from "./constants";

const baseEnv = { ...process.env };
let handle: Handle;

// Each test file gets its own database: PGlite (real Postgres, in memory) by default, or a real
// Postgres server when TEST_DATABASE_URL is set; then run with --no-file-parallelism, since the
// files would otherwise share it.
beforeAll(async () => {
  handle = await openDb(process.env.TEST_DATABASE_URL ?? "pglite:memory", { migrate: true });
});

afterAll(async () => {
  setDbForTests(undefined);
  await handle.close();
});

beforeEach(async () => {
  process.env = {
    ...baseEnv,
    NODE_ENV: "test",
    ARENA_ADMIN_TOKEN: ADMIN_TOKEN,
    ARENA_OWNER_PASSWORD: OWNER_PASSWORD,
    ARENA_SESSION_SECRET: SESSION_SECRET,
    ARENA_ALLOW_ANONYMOUS_READ: "0",
    // Streams poll the change feed quickly in tests.
    ARENA_STREAM_POLL_MS: "20",
  };
  // Tests choose their own secrets and limits; never inherit them from the shell running them.
  for (const name of ["ARENA_ENCRYPTION_KEY", "ARENA_INSECURE_COOKIE", "ARENA_TRUST_PROXY", "ARENA_RATE_LIMIT_PER_10S"]) {
    delete process.env[name];
  }
  setDbForTests(handle);
  await handle.db.execute(
    sql`TRUNCATE arenas, agents, events, api_keys, changes, rate_limits, login_failures RESTART IDENTITY CASCADE`,
  );
  await handle.db.execute(sql`UPDATE counters SET value = 0`);
});
