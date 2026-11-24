import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { getEnv } from "../env";
import * as schema from "./schema";

// Plain PostgreSQL. DATABASE_URL is either
//   postgres://... (Supabase or any Postgres server; the "postgres" driver), or
//   pglite:<dir> / pglite:memory (PGlite: real Postgres, embedded, for local development and tests).

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Handle = { db: Db; close: () => Promise<void>; kind: "postgres" | "pglite" };

const MIGRATIONS_DIR = () => process.env.ARENA_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");

/**
 * Supabase's transaction pooler (port 6543, Supavisor transaction mode) can't keep prepared
 * statements between transactions; anything else (direct, session pooler, plain Postgres) can.
 * `?pgbouncer=true` (as Prisma's docs write it) marks a pooler on another port.
 */
export function usesTransactionPooler(url: string): boolean {
  try {
    const u = new URL(url);
    return u.port === "6543" || u.searchParams.get("pgbouncer") === "true";
  } catch {
    return false;
  }
}

/** postgres-js sends unknown URL parameters to the server, which rejects `pgbouncer`. */
function withoutPoolerHint(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("pgbouncer")) return url;
    u.searchParams.delete("pgbouncer");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Opens a database. An embedded (pglite:) database is migrated here, since it is created on the
 * spot. A real Postgres is migrated by `pnpm db:migrate` (part of the Vercel build), not on every
 * serverless cold start, unless ARENA_AUTO_MIGRATE=1.
 */
export async function openDb(url: string, { migrate }: { migrate?: boolean } = {}): Promise<Handle> {
  let handle: Handle;
  if (url.startsWith("pglite:")) {
    const [{ PGlite }, { drizzle }] = await Promise.all([import("@electric-sql/pglite"), import("drizzle-orm/pglite")]);
    const where = url.slice("pglite:".length).replace(/^\/\//, "");
    let client;
    if (where === "" || where === "memory") client = new PGlite();
    else {
      const dir = path.resolve(where);
      await mkdir(path.dirname(dir), { recursive: true });
      client = new PGlite(dir);
    }
    handle = { db: drizzle(client, { schema }) as unknown as Db, close: () => client.close(), kind: "pglite" };
  } else {
    const [{ default: postgres }, { drizzle }] = await Promise.all([import("postgres"), import("drizzle-orm/postgres-js")]);
    const client = postgres(withoutPoolerHint(url), {
      max: Number(process.env.ARENA_DB_POOL_SIZE ?? 5),
      prepare: !usesTransactionPooler(url),
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
    handle = { db: drizzle(client, { schema }) as unknown as Db, close: () => client.end({ timeout: 5 }), kind: "postgres" };
  }
  if (migrate ?? (handle.kind === "pglite" || process.env.ARENA_AUTO_MIGRATE === "1")) await migrateDb(handle);
  return handle;
}

export async function migrateDb(handle: Handle): Promise<void> {
  const migrationsFolder = MIGRATIONS_DIR();
  if (handle.kind === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(handle.db as never, { migrationsFolder });
  }
}

// One connection pool per process, kept on globalThis so dev-mode module reloads reuse it.
const holder = globalThis as unknown as { __arenaDb?: Promise<Handle> };

export function getHandle(): Promise<Handle> {
  holder.__arenaDb ??= openDb(getEnv().DATABASE_URL).catch((err) => {
    holder.__arenaDb = undefined; // let the next request try again
    throw err;
  });
  return holder.__arenaDb;
}

/** The process's database, opened on first use. */
export async function getDb(): Promise<Db> {
  return (await getHandle()).db;
}

export async function closeDb(): Promise<void> {
  const pending = holder.__arenaDb;
  holder.__arenaDb = undefined;
  if (pending) await (await pending).close();
}

export function setDbForTests(handle: Handle | undefined): void {
  holder.__arenaDb = handle ? Promise.resolve(handle) : undefined;
}

/**
 * A transaction for any write that changes what the live stream shows. It first locks the global
 * counter row, so such writes run one at a time and commit in counter order, across every process
 * and connection. That is what makes `seq` a safe floor for the live stream (a snapshot that reads
 * counter value V has seen every change numbered V or lower), and what serializes seat allocation
 * and the agent cap.
 */
export async function writeTx<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT ${schema.counters.value} FROM ${schema.counters} WHERE ${schema.counters.name} = 'seq' FOR UPDATE`);
    return run(tx);
  });
}

/** Takes the next value of the global change counter. Call inside writeTx(). */
export async function nextSeq(tx: Tx): Promise<number> {
  const rows = await tx
    .update(schema.counters)
    .set({ value: sql`${schema.counters.value} + 1` })
    .where(sql`${schema.counters.name} = 'seq'`)
    .returning({ value: schema.counters.value });
  return Number(rows[0].value);
}

export async function currentSeq(tx: Tx | Db): Promise<number> {
  const rows = await tx
    .select({ value: schema.counters.value })
    .from(schema.counters)
    .where(sql`${schema.counters.name} = 'seq'`);
  return Number(rows[0]?.value ?? 0);
}

/** Rows from a raw `execute()` result, whichever driver produced it. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
