import { z } from "zod";

// No "server-only" import: proxy.ts reads this too.

const flag = z.preprocess((v) => (v === "" || v === undefined ? "0" : v), z.enum(["0", "1"]));

const optional = (min: number) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().min(min).optional());

const sharedEnv = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /**
   * postgres://... (Supabase or any Postgres), or pglite:<dir> / pglite:memory for an embedded
   * Postgres (local development and tests). Defaults to an embedded database under ./data.
   */
  DATABASE_URL: z.preprocess((v) => (v === "" || v === undefined ? "pglite:./data/pglite" : v), z.string().min(1)),
  /** 1 allows an embedded (pglite:) database in production, e.g. for end-to-end tests. */
  ARENA_ALLOW_EMBEDDED_DB: flag,
  /** Protects /api/cron/*; Vercel Cron sends it as a Bearer token. */
  CRON_SECRET: optional(16),
  ARENA_ADMIN_TOKEN: optional(24),
  ARENA_SESSION_SECRET: optional(32),
  /** Encrypts stored API keys so they can be copied again. Defaults to ARENA_SESSION_SECRET. */
  ARENA_ENCRYPTION_KEY: optional(32),
  ARENA_ALLOW_ANONYMOUS_READ: flag,
  /** 1 lets the login cookie work over plain HTTP in production (a LAN or tailnet without TLS). */
  ARENA_INSECURE_COOKIE: flag,
  /** 1 when a reverse proxy in front of Arena overwrites X-Forwarded-For; only then is it trusted. */
  ARENA_TRUST_PROXY: flag,
});

const envSchema = z.discriminatedUnion("ARENA_AUTH_PROVIDER", [
  sharedEnv.extend({
    ARENA_AUTH_PROVIDER: z.literal("password"),
    ARENA_OWNER_PASSWORD: optional(8),
  }).refine((env) => !env.ARENA_OWNER_PASSWORD || env.ARENA_SESSION_SECRET, {
    path: ["ARENA_SESSION_SECRET"],
    message: "is required when ARENA_OWNER_PASSWORD is set",
  }),
  sharedEnv.extend({
    ARENA_AUTH_PROVIDER: z.literal("supabase"),
    SUPABASE_URL: z.url({ protocol: /^https?$/ }),
    SUPABASE_PUBLISHABLE_KEY: z.string().startsWith("sb_publishable_").min(16),
  }),
]);

export type Env = z.infer<typeof envSchema>;
export type SupabaseEnv = Extract<Env, { ARENA_AUTH_PROVIDER: "supabase" }>;

/** Parsed on every call: it is cheap, and tests change process.env between cases. */
export function getEnv(): Env {
  const parsed = envSchema.safeParse({
    ...process.env,
    ARENA_AUTH_PROVIDER: process.env.ARENA_AUTH_PROVIDER || "password",
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
    throw new Error(`Invalid Arena configuration: ${issues}`);
  }
  return parsed.data;
}

/**
 * Reads without a login only when ARENA_ALLOW_ANONYMOUS_READ=1, in every environment: a dev server
 * on a LAN or tailnet must not expose answers just because no password is set.
 * Changes always need the owner session (or the admin token over the API).
 */
export function anonymousReadAllowed(env: Env = getEnv()): boolean {
  return env.ARENA_AUTH_PROVIDER === "password" && env.ARENA_ALLOW_ANONYMOUS_READ === "1";
}

export function ownerLoginEnabled(env: Env = getEnv()): boolean {
  return env.ARENA_AUTH_PROVIDER === "supabase" || passwordSessionKeys(env) !== null;
}

export function passwordSessionKeys(env: Env) {
  if (env.ARENA_AUTH_PROVIDER !== "password" || !env.ARENA_OWNER_PASSWORD || !env.ARENA_SESSION_SECRET) return null;
  return { password: env.ARENA_OWNER_PASSWORD, secret: env.ARENA_SESSION_SECRET };
}

export function usesEmbeddedDb(env: Env = getEnv()): boolean {
  return env.DATABASE_URL.startsWith("pglite:");
}

/** Called once when the server starts (instrumentation.ts). */
export function assertStartupConfig(env: Env = getEnv()): void {
  // An embedded database lives on the instance's disk: on Vercel that disk is temporary and not
  // shared between instances, so every write would eventually be lost.
  if (usesEmbeddedDb(env) && (process.env.VERCEL || (env.NODE_ENV === "production" && env.ARENA_ALLOW_EMBEDDED_DB !== "1"))) {
    throw new Error(
      "Refusing to start: set DATABASE_URL to your Postgres connection string (Supabase: Project → Connect). " +
        "An embedded pglite: database only works for local development.",
    );
  }
  if (!env.ARENA_ENCRYPTION_KEY && !env.ARENA_SESSION_SECRET) {
    console.warn("[arena] Set ARENA_ENCRYPTION_KEY (or ARENA_SESSION_SECRET): without it, new API keys can't be created.");
  }
  if (ownerLoginEnabled(env) || anonymousReadAllowed(env)) return;
  const message =
    "configure Supabase Auth, set ARENA_OWNER_PASSWORD and ARENA_SESSION_SECRET, " +
    "or set ARENA_ALLOW_ANONYMOUS_READ=1 to make dashboards readable without a login on purpose.";
  if (env.NODE_ENV === "production") throw new Error(`Refusing to start: ${message}`);
  console.warn(`[arena] Nobody can read the dashboard yet: ${message}`);
}
