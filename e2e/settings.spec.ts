import { expect, test } from "@playwright/test";
import { admin, createArena, login, report } from "./helpers";

test("settings render per request: data written after the build shows up", async ({ page, request }) => {
  // The server was built before this arena or agent existed.
  await createArena(request, "fresh");
  await report(request, "fresh", "late-agent", { status: "idle", displayName: "Late Agent" });
  await login(page);
  await page.goto("/arenas/fresh/settings");
  await expect(page.getByRole("heading", { name: "Fresh · settings" })).toBeVisible();
  await expect(page.locator('[data-settings-agent="late-agent"]')).toContainText("Late Agent");
  await expect(page.locator('[data-key-name="default"]')).toBeVisible();
});

test("create an arena in the UI, make a named key, copy it again later, use it, revoke it", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.getByRole("link", { name: "New arena" }).click();
  await page.getByLabel("Name").fill("Side Projects");
  await page.getByLabel("Slug (used in URLs and the API)").fill("side");
  await page.getByLabel("Theme").selectOption("kitchen");
  await page.getByRole("button", { name: "Create arena" }).click();
  await expect(page.getByText('Arena “side” is ready.')).toBeVisible();
  const firstKey = await page.getByTestId("ingest-token").textContent();
  expect(firstKey).toMatch(/^arena_/);

  await page.getByRole("link", { name: "Open the arena" }).click();
  // Coming back to New arena starts a fresh form, not the last arena's key.
  await page.getByRole("link", { name: "New arena" }).click();
  await expect(page.getByLabel("Name")).toBeVisible();
  await expect(page.getByTestId("ingest-token")).toHaveCount(0);
  await page.goto("/arenas/side");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("New key name").fill("laptop");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.locator('[data-key-name="laptop"]')).toBeVisible();

  // Copy it again from the list, any time.
  await page.locator('[data-key-name="laptop"]').getByRole("button", { name: "Copy" }).click();
  await expect(page.locator('[data-key-name="laptop"]').getByText("Copied.")).toBeVisible();
  const laptopKey = await page.evaluate(() => navigator.clipboard.readText());
  expect(laptopKey).toMatch(/^arena_/);
  expect(laptopKey).not.toBe(firstKey);

  const ok = await request.post("/api/arenas/side/agents/bot/status", {
    headers: { Authorization: `Bearer ${laptopKey}` },
    data: { status: "working", activity: "via laptop key" },
  });
  expect(ok.status()).toBe(201);

  page.once("dialog", (d) => void d.accept());
  await expect(page.getByText('Key "laptop" is ready.')).toBeVisible();
  await page.locator('[data-key-name="laptop"]').getByRole("button", { name: "Revoke laptop" }).click();
  await expect(page.locator('[data-key-name="laptop"]')).toHaveCount(0);
  // The "ready" banner for the revoked key goes with it.
  await expect(page.getByText('Key "laptop" is ready.')).toHaveCount(0);
  const denied = await request.post("/api/arenas/side/agents/bot/status", {
    headers: { Authorization: `Bearer ${laptopKey}` },
    data: { status: "idle" },
  });
  expect(denied.status()).toBe(401);
  // The default key still works.
  const still = await request.post("/api/arenas/side/agents/bot/status", {
    headers: { Authorization: `Bearer ${firstKey}` },
    data: { status: "idle" },
  });
  expect(still.status()).toBe(200);
});

test("the overview shows a live thumbnail per arena", async ({ page, request }) => {
  await createArena(request, "thumbs");
  await report(request, "thumbs", "a", { status: "working", activity: "x" });
  await login(page);
  const card = page.locator('[data-arena="thumbs"]');
  await expect(card.locator('[data-agent-sprite="a"]')).toHaveAttribute("data-pose", "work");
  await request.post("/api/arenas/thumbs/agents/a/status", { headers: admin, data: { status: "done", result: "ok" } });
  await expect(card.locator('[data-agent-sprite="a"]')).toHaveAttribute("data-pose", "done");
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
});
