import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite (the embedded Postgres used locally) loads its WebAssembly at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Read at request time by /api/connect/:file (src/server/connect-files.ts).
  outputFileTracingIncludes: {
    "/api/connect/*": [
      "./scripts/arena-install.cjs",
      "./scripts/arena-report.mjs",
      "./examples/claude-code-hooks/arena-hook.mjs",
      "./examples/codex-notify/arena-notify.mjs",
      "./skills/arena-presence/SKILL.md",
      "./skills/arena-presence/references/setup.md",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
