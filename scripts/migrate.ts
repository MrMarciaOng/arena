/**
 * Creates or upgrades the database at DATABASE_URL (Postgres, or pglite: for local development).
 * Runs as part of the Vercel build (vercel.json), so serverless instances never migrate on a cold
 * start. Reads .env / .env.local like Next does. Run with: pnpm db:migrate
 */
import { loadEnvConfig } from "@next/env";

async function main() {
  // Same files `next dev` reads (or `next start` when NODE_ENV=production).
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const { openDb } = await import("../src/server/db/client");
  const { getEnv } = await import("../src/server/env");
  const url = getEnv().DATABASE_URL;
  const handle = await openDb(url, { migrate: true });
  await handle.close();
  // Never print the connection string: it holds the database password.
  console.log(`Database ready (${handle.kind === "pglite" ? "embedded" : "Postgres"})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
