// Relative imports only: drizzle-kit loads this file without the "@/" alias.
import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
  EVENT_TYPES,
  STATUSES,
  THEMES,
  WAITING_ON,
  type Appearance,
  type JsonValue,
  type StreamMessage,
} from "../../lib/domain";

// Plain PostgreSQL (Supabase, or any Postgres; PGlite for local development and tests).
// Times are epoch milliseconds in bigint columns, read back as JS numbers.
const ms = (name: string) => bigint(name, { mode: "number" });

export const arenas = pgTable("arenas", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  theme: text("theme", { enum: THEMES }).notNull(),
  version: ms("version").notNull(),
  createdAt: ms("created_at").notNull(),
  updatedAt: ms("updated_at").notNull(),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    arenaId: text("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role"),
    appearance: jsonb("appearance").$type<Appearance>(),
    status: text("status", { enum: STATUSES }).notNull(),
    activity: text("activity"),
    waitingOn: text("waiting_on", { enum: WAITING_ON }),
    waitingFor: text("waiting_for"),
    progress: doublePrecision("progress"),
    result: text("result"),
    resultTruncated: boolean("result_truncated").notNull().default(false),
    error: text("error"),
    seat: integer("seat").notNull(),
    version: ms("version").notNull(),
    session: text("session"),
    seqWatermark: doublePrecision("seq_watermark"),
    ttlSeconds: integer("ttl_seconds").notNull(),
    lastSeenAt: ms("last_seen_at").notNull(),
    awaySince: ms("away_since"),
    statusChangedAt: ms("status_changed_at").notNull(),
    metadata: jsonb("metadata").$type<JsonValue>(),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("agents_arena_key").on(t.arenaId, t.key),
    uniqueIndex("agents_arena_seat").on(t.arenaId, t.seat),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    arenaId: text("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    agentKey: text("agent_key").notNull(),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    applied: boolean("applied").notNull(),
    report: jsonb("report").$type<Record<string, unknown>>(),
    agentVersion: ms("agent_version"),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [
    index("events_arena_agent_id").on(t.arenaId, t.agentKey, t.id),
    index("events_created_at").on(t.createdAt),
  ],
);

/**
 * An arena's API keys. Agents send one as `Authorization: Bearer <key>`. The hash finds the key on
 * each request; the sealed copy (AES-256-GCM under a server secret) lets the owner copy it again
 * later. A key whose sealed copy is null can't be shown again; create a new one instead.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    arenaId: text("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenSealed: text("token_sealed"),
    /** The first characters of the key, for telling keys apart in lists. */
    prefix: text("prefix").notNull(),
    createdAt: ms("created_at").notNull(),
    lastUsedAt: ms("last_used_at"),
  },
  (t) => [uniqueIndex("api_keys_arena_name").on(t.arenaId, t.name)],
);

/**
 * One row, "seq": the global change counter. Every write that changes what the live stream shows
 * locks this row first (SELECT ... FOR UPDATE) and takes its next value, so those writes commit
 * one at a time, in counter order, even across processes. See src/server/db/client.ts.
 */
export const counters = pgTable("counters", {
  name: text("name").primaryKey(),
  value: ms("value").notNull(),
});

/**
 * The live-update feed: one row per change the dashboards should see, written in the same
 * transaction as the change and numbered by the global counter. Writes commit in counter order, so
 * a reader that has seen `seq` N has seen everything numbered below N, and can poll for `seq > N`
 * from any server instance. Kept for an hour (live streams only need the last few minutes).
 * No foreign key: an arena's "removed" entry outlives the arena.
 */
export const changes = pgTable(
  "changes",
  {
    seq: ms("seq").primaryKey(),
    arenaId: text("arena_id").notNull(),
    message: jsonb("message").$type<StreamMessage>().notNull(),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [index("changes_created_at").on(t.createdAt)],
);

/** Per-token request counts in fixed windows, shared by every server instance. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: ms("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limits_window").on(t.windowStart)],
);

/** Failed owner logins, for the login throttle. */
export const loginFailures = pgTable(
  "login_failures",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    client: text("client").notNull(),
    at: ms("at").notNull(),
  },
  (t) => [index("login_failures_client_at").on(t.client, t.at), index("login_failures_at").on(t.at)],
);

export type ArenaRow = typeof arenas.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
