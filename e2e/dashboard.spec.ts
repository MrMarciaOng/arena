import { expect, request as playwrightRequest, test } from "@playwright/test";
import { E2E_ENV } from "../playwright.config";
import { admin, createArena, login, report, startServer } from "./helpers";

test("pages redirect to login, and a wrong password is refused", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Password").fill("not-it");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Wrong password." })).toBeVisible();
});

test("the arena page updates live and shows the answer", async ({ page, request }) => {
  await createArena(request, "live");
  await login(page);
  await expect(page.locator('[data-arena="live"]')).toBeVisible();

  await page.goto("/arenas/live");
  await expect(page.getByText("No agents in this arena yet.")).toBeVisible();

  await report(request, "live", "writer", { status: "working", activity: "Drafting the intro", displayName: "Writer" });
  const row = page.locator('[data-agent="writer"]');
  await expect(row).toContainText("Drafting the intro", { timeout: 1000 });

  await report(request, "live", "writer", { status: "waiting", waitingOn: "human", waitingFor: "your sign-off" });
  await expect(page.getByRole("region", { name: "Needs you" })).toContainText("your sign-off", { timeout: 1000 });

  await report(request, "live", "writer", { status: "done", result: "## Final draft\n\n- point **one**" });
  await expect(page.getByRole("region", { name: "Done" })).toContainText("Final draft", { timeout: 1000 });

  await row.click();
  const drawer = page.getByRole("complementary", { name: "Writer details" });
  await expect(drawer.getByRole("heading", { name: "Final draft" })).toBeVisible();
  await drawer.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("region", { name: "Idle" })).toContainText("Writer", { timeout: 2000 });
});

test("a newer answer waits behind a banner; only the latest answer can be acknowledged", async ({ page, request }) => {
  await createArena(request, "pinned");
  await report(request, "pinned", "writer", { status: "done", result: "## Answer A", displayName: "Writer" });
  await login(page);
  await page.goto("/arenas/pinned");
  await page.locator('[data-agent="writer"]').click();
  const drawer = page.getByRole("complementary", { name: "Writer details" });
  await expect(drawer.getByRole("heading", { name: "Answer A" })).toBeVisible();

  await report(request, "pinned", "writer", { status: "done", result: "## Answer B" });
  await expect(drawer.getByText("A newer answer arrived.")).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Answer A" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Acknowledge" })).toBeDisabled();

  // A profile change keeps the same answer: no banner for it.
  await drawer.getByRole("button", { name: "Show it" }).click();
  await expect(drawer.getByRole("heading", { name: "Answer B" })).toBeVisible();
  const put = await request.put("/api/arenas/pinned/agents/writer", { headers: admin, data: { displayName: "Writer", role: "drafts" } });
  expect(put.ok()).toBeTruthy();
  await expect(drawer.getByText("drafts")).toBeVisible();
  await expect(drawer.getByText("A newer answer arrived.")).toHaveCount(0);

  // The agent moving on keeps the answer on screen until dismissed.
  await report(request, "pinned", "writer", { status: "working", activity: "next task" });
  await expect(drawer.getByText("This is its previous answer.")).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Answer B" })).toBeVisible();
  await report(request, "pinned", "writer", { status: "done", result: "## Answer C" });
  await expect(drawer.getByText("A newer answer arrived.")).toBeVisible();
  await drawer.getByRole("button", { name: "Show it" }).click();
  await drawer.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("region", { name: "Idle" })).toContainText("Writer");
});

test("after a server restart the page reconnects and catches up from a fresh snapshot", async ({ page }) => {
  test.setTimeout(60_000);
  const port = 4001;
  const base = `http://127.0.0.1:${port}`;
  let server = await startServer(port, "/tmp/arena-e2e/restart-pg");
  const api = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: admin });
  try {
    expect((await api.post("/api/arenas", { data: { slug: "restart", name: "Restart" } })).status()).toBe(201);
    await api.post("/api/arenas/restart/agents/a/status", { data: { status: "working", activity: "first" } });
    await api.post("/api/arenas/restart/agents/b/status", { data: { status: "working", activity: "will be removed" } });

    await page.goto(`${base}/login?next=/arenas/restart`);
    await page.getByLabel("Password").fill(E2E_ENV.ARENA_OWNER_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.locator('[data-agent="b"]')).toBeVisible();

    await server.stop();
    await expect(page.getByRole("status").filter({ hasText: "reconnecting" })).toBeVisible({ timeout: 10_000 });

    // Hold the browser's reconnects until both changes are made, so only the fresh snapshot can
    // deliver them (not live messages on a connection that came back early).
    await page.route("**/api/stream**", (route) => route.abort());
    server = await startServer(port, "/tmp/arena-e2e/restart-pg");
    expect((await api.delete("/api/arenas/restart/agents/b")).status()).toBe(204);
    await api.post("/api/arenas/restart/agents/a/status", { data: { status: "done", result: "caught up" } });
    await expect(page.locator('[data-agent="b"]')).toBeVisible();
    await page.unroute("**/api/stream**");

    await expect(page.getByRole("status").filter({ hasText: "live" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-agent="b"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Done" })).toContainText("caught up");
  } finally {
    await api.dispose();
    await server.stop();
  }
});
