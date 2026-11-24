import { spawn } from "node:child_process";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ENV } from "../playwright.config";

export const admin = { Authorization: `Bearer ${E2E_ENV.ARENA_ADMIN_TOKEN}` };

export async function createArena(request: APIRequestContext, slug: string, theme = "office") {
  const res = await request.post("/api/arenas", { headers: admin, data: { slug, name: slug[0].toUpperCase() + slug.slice(1), theme } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { arena: { id: string; slug: string }; apiKey: { id: string; name: string; token: string } };
}

export async function report(request: APIRequestContext, slug: string, key: string, body: Record<string, unknown>) {
  const res = await request.post(`/api/arenas/${slug}/agents/${key}/status`, { headers: admin, data: body });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_ENV.ARENA_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Your arenas" })).toBeVisible();
}

/** Starts a second `next start` (from the build the webServer made) that a test can stop and restart. */
export async function startServer(port: number, dataDir: string): Promise<{ stop: () => Promise<void> }> {
  const child = spawn("node_modules/.bin/next", ["start", "-p", String(port), "-H", "127.0.0.1"], {
    env: { ...process.env, ...E2E_ENV, DATABASE_URL: `pglite:${dataDir}` },
    detached: true,
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let i = 0; i < 100; i += 1) {
    const ok = await fetch(url).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    stop: async () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      const exited = new Promise((r) => child.once("exit", r));
      process.kill(-child.pid, "SIGTERM");
      await exited;
    },
  };
}
