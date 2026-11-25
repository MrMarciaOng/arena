import { defineConfig, devices } from "@playwright/test";

const PORT = 3999;
export const E2E_ENV = {
  // Embedded Postgres (PGlite) in a throwaway directory; production refuses it unless allowed.
  DATABASE_URL: "pglite:/tmp/arena-e2e/pg",
  ARENA_ALLOW_EMBEDDED_DB: "1",
  ARENA_STREAM_POLL_MS: "200",
  ARENA_ADMIN_TOKEN: "e2e-admin-token-0123456789abcdef",
  ARENA_AUTH_PROVIDER: "password",
  ARENA_OWNER_PASSWORD: "e2e-owner-password",
  ARENA_SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  ARENA_ALLOW_ANONYMOUS_READ: "0",
};

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A production build, so the test also covers what `next build` prerenders.
    command: `rm -rf /tmp/arena-e2e && pnpm build && pnpm start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: E2E_ENV,
  },
});
