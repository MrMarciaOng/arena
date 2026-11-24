import { expect, test } from "@playwright/test";
import { createArena, login, report } from "./helpers";

test("the office scene moves a waiting agent to the coffee corner and opens its answer", async ({ page, request }) => {
  await createArena(request, "scenic");
  await report(request, "scenic", "scout", { status: "working", activity: "Searching listings", progress: 0.4, displayName: "Scout" });
  await report(request, "scenic", "coach", { status: "idle", displayName: "Coach" });
  await login(page);
  await page.goto("/arenas/scenic");

  const scout = page.locator('[data-agent-sprite="scout"]');
  const scoutName = scout.getByText("Scout", { exact: true });
  await expect(scout).toHaveAttribute("data-pose", "work");
  await expect(scout).toHaveAttribute("data-zone", "station");
  await expect(scoutName).toBeVisible();

  await report(request, "scenic", "scout", { status: "waiting", waitingOn: "human", waitingFor: "which city to search" });
  await expect(scout).toHaveAttribute("data-zone", "waiting");
  await expect(scout).toHaveAttribute("aria-label", /Needs you.*which city to search/);
  // Walks over, then waits.
  await expect(scout).toHaveAttribute("data-pose", "wait", { timeout: 5000 });
  await expect(scoutName).toBeVisible();

  await report(request, "scenic", "scout", { status: "done", result: "## Three listings\n\n- Lisbon" });
  await expect(scout).toHaveAttribute("data-zone", "station");
  await expect(scout).toHaveAttribute("data-pose", "done", { timeout: 5000 });
  await scoutName.click();
  await expect(page.getByRole("complementary", { name: "Scout details" }).getByRole("heading", { name: "Three listings" })).toBeVisible();

  await page.screenshot({ path: "test-results/scene-office.png", fullPage: true });
});

test("the list view is there for keyboard and screen-reader use", async ({ page, request }) => {
  await createArena(request, "listy", "kitchen");
  await report(request, "listy", "chef", { status: "working", activity: "Stirring", displayName: "Chef" });
  await login(page);
  await page.goto("/arenas/listy");
  await expect(page.locator('[data-agent-sprite="chef"]')).toBeVisible();
  await page.getByRole("button", { name: "list" }).click();
  await expect(page.locator('[data-agent-sprite="chef"]')).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Working" })).toContainText("Stirring");
  await page.getByRole("button", { name: "scene" }).click();
  const workspace = page.getByRole("region", { name: "Kitchen workspace" });
  await expect.poll(() => workspace.evaluate((room) => {
    const scene = room.querySelector('[aria-label="Kitchen scene"]');
    return scene ? Math.abs(scene.getBoundingClientRect().width - room.clientWidth) : Infinity;
  })).toBeLessThan(2);
  await page.screenshot({ path: "test-results/scene-kitchen.png", fullPage: true });
});

test("keyboard: Enter on a sprite moves focus into the drawer; Escape closes it and returns focus", async ({ page, request }) => {
  await createArena(request, "keys");
  await report(request, "keys", "bot", { status: "waiting", waitingOn: "human", waitingFor: "a yes or no", displayName: "Bot" });
  await login(page);
  await page.goto("/arenas/keys");
  const sprite = page.locator('[data-agent-sprite="bot"]');
  await sprite.focus();
  await expect(sprite.locator(".scene-caption")).toBeVisible();
  await expect(sprite.locator(".scene-caption")).toHaveText("a yes or no");
  await page.keyboard.press("Enter");
  const close = page.getByRole("complementary", { name: "Bot details" }).getByRole("button", { name: "Close" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Bot details" })).toHaveCount(0);
  await expect(sprite).toBeFocused();
});

test("the workspace aligns with its scrolling roster and only shows the pan hint when needed", async ({ page, request }) => {
  await page.setViewportSize({ width: 1195, height: 737 });
  await createArena(request, "aligned");
  const activity = "Comparing three project proposals and preparing the draft summary";
  for (let index = 1; index <= 8; index += 1) {
    await report(request, "aligned", `writer-${index}`, { status: "working", activity, progress: 0.65, displayName: `Writer ${index}` });
  }
  await login(page);
  await page.goto("/arenas/aligned");

  const workspace = page.getByRole("region", { name: "Office workspace" });
  const roster = page.getByRole("complementary", { name: "Agents" });
  const heading = roster.getByRole("heading", { name: "Agents" });
  const cards = roster.getByRole("button");
  await expect(cards).toHaveCount(8);

  const room = await page.locator(".workspace-frame").boundingBox();
  const panel = await roster.boundingBox();
  expect(panel?.y).toBe(room?.y);
  expect(panel?.height).toBe(room?.height);
  const headingY = (await heading.boundingBox())?.y;
  const description = await cards.first().getByText(activity).boundingBox();
  const progress = cards.first().getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuenow", "65");
  expect((await progress.boundingBox())!.y).toBeGreaterThan(description!.y + description!.height);

  await cards.first().focus();
  for (let index = 1; index < 8; index += 1) await page.keyboard.press("Tab");
  await expect(cards.last()).toBeFocused();
  expect((await heading.boundingBox())?.y).toBe(headingY);

  const hint = page.getByText("Swipe or scroll sideways to see the whole room.");
  await expect(hint).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 850 });
  await expect(hint).toBeVisible();
  await expect.poll(() => workspace.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 579, height: 850 });
  await expect(hint).toHaveCount(0);
  await expect.poll(() => workspace.evaluate((el) => el.scrollWidth === el.clientWidth)).toBe(true);
});
