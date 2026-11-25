import { expect, test } from "@playwright/test";
import { E2E_ENV } from "../playwright.config";
import { admin, createArena, login, report } from "./helpers";

test("search and status filters follow live reports without changing the scene or drawer", async ({ page, request }) => {
  await createArena(request, "roster");
  const profile = await request.put("/api/arenas/roster/agents/scout-17", {
    headers: admin,
    data: { displayName: "Map Scout", role: "Planning research" },
  });
  expect(profile.status()).toBe(201);
  await report(request, "roster", "scout-17", { status: "working", activity: "Reading maps" });
  await report(request, "roster", "release", { status: "waiting", waitingOn: "human", displayName: "Release Planner" });
  await report(request, "roster", "sync", { status: "waiting", waitingOn: "external", displayName: "Data Sync" });
  await login(page);
  await page.goto("/arenas/roster");

  const roster = page.getByRole("complementary", { name: "Agents" });
  const search = roster.getByRole("searchbox", { name: "Search agents" });
  const status = roster.getByRole("combobox", { name: "Agent status" });
  const scene = page.getByRole("region", { name: "Office workspace" });
  await expect(scene.locator("[data-agent-sprite]")).toHaveCount(3);
  for (const query of [" MAP SCOUT ", "scout-17", "PLANNING RESEARCH"]) {
    await search.fill(query);
    await expect(roster.getByText("1 of 3 agents")).toBeVisible();
    await expect(roster.getByRole("button", { name: /Map Scout/ })).toBeVisible();
  }
  await search.fill("release");
  await status.selectOption("needsYou");
  await expect(roster.getByRole("button", { name: /Release Planner/ })).toBeVisible();
  await expect(scene.locator("[data-agent-sprite]")).toHaveCount(3);
  await expect(page.getByText("1 working", { exact: false })).toBeVisible();

  await scene.getByRole("button", { name: /Map Scout/ }).click();
  await expect(page.getByRole("complementary", { name: "Map Scout details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "list", exact: true }).click();
  await expect(search).toHaveValue("release");
  await expect(status).toHaveValue("needsYou");
  await roster.getByRole("button", { name: /Release Planner/ }).click();
  const drawer = page.getByRole("complementary", { name: "Release Planner details" });
  await expect(drawer).toBeVisible();
  await report(request, "roster", "release", { status: "done", result: "Approved launch date" });
  await expect(roster.getByText("0 of 3 agents")).toBeVisible();
  await expect(roster.getByText("No agents match these filters.")).toBeVisible();
  await expect(drawer).toContainText("Approved launch date");
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(search).toBeFocused();
  await roster.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(status).toHaveValue("all");
  await expect(roster.locator("[data-agent]")).toHaveCount(3);
});

test("narrow rooms support jumps to both destinations and keep their position through live reports", async ({ page, request }) => {
  const rooms = [
    { theme: "office", name: "Office", stations: "Workstations", waiting: "Coffee corner" },
    { theme: "kitchen", name: "Kitchen", stations: "Prep stations", waiting: "Kitchen pass" },
  ];
  for (const { theme } of rooms) {
    await createArena(request, `small-${theme}`, theme);
    await report(request, `small-${theme}`, "runner", { status: "working", displayName: "Runner" });
    await report(request, `small-${theme}`, "first", { status: "waiting", displayName: "First" });
    await report(request, `small-${theme}`, "second", { status: "waiting", displayName: "Second" });
  }
  await page.setViewportSize({ width: 390, height: 850 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await expect(page.getByRole("group", { name: "Room navigation" })).toHaveCount(0);

  for (const { theme, name, stations, waiting } of rooms) {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.goto(`/arenas/small-${theme}`);
    const room = page.getByRole("region", { name: `${name} workspace` });
    const navigation = page.getByRole("group", { name: "Room navigation" });
    const toWaiting = navigation.getByRole("button", { name: waiting, exact: true });
    const toStations = navigation.getByRole("button", { name: stations, exact: true });
    const scrollLeft = () => room.evaluate((el) => el.scrollLeft);
    const max = await room.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(max).toBeGreaterThan(0);
    const pageScroll = await page.evaluate(() => window.scrollY);
    await toWaiting.focus();
    await page.keyboard.press("Enter");
    expect(await scrollLeft()).toBe(max);
    await expect(toWaiting).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
    await report(request, `small-${theme}`, "runner", { status: "working", activity: "Packing up" });
    await expect(room.getByRole("button", { name: /Runner.*Packing up/ })).toHaveCount(1);
    expect(await scrollLeft()).toBe(max);

    const farAgent = room.getByRole("button", { name: /^Second:/ });
    await expect(farAgent).toBeInViewport();
    await farAgent.click();
    const drawer = page.getByRole("dialog", { name: "Second details" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();
    await toStations.click();
    expect(await scrollLeft()).toBe(0);
    await room.hover();
    await page.mouse.wheel(80, 0);
    await expect.poll(scrollLeft).toBeGreaterThan(0);

    await page.setViewportSize({ width: 1024, height: 850 });
    await expect(navigation).toHaveCount(0);
    await expect(page.getByText("Swipe or scroll sideways to see the whole room.")).toHaveCount(0);
  }
});

test("agent links survive login and delayed loading and can be copied or selected", async ({ page, request, context }) => {
  await createArena(request, "linked");
  await report(request, "linked", "brief.writer", { status: "working", displayName: "Brief Writer" });
  await page.setViewportSize({ width: 390, height: 850 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  let resumeStream = () => {};
  const held = new Promise<void>((resolve) => { resumeStream = resolve; });
  await page.route("**/api/stream**", async (route) => {
    await held;
    await route.continue();
  });
  const path = "/arenas/linked?from=review&agent=brief%2Ewriter";
  const drawer = page.getByRole("dialog", { name: "Brief Writer details" });
  try {
    await page.goto(path);
    const loginUrl = new URL(page.url());
    const returnUrl = new URL(loginUrl.searchParams.get("next") ?? "/", loginUrl);
    expect(returnUrl.pathname).toBe("/arenas/linked");
    expect(returnUrl.searchParams.get("agent")).toBe("brief.writer");
    expect(returnUrl.searchParams.get("from")).toBe("review");
    await page.getByLabel("Password").fill(E2E_ENV.ARENA_OWNER_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByText("Connecting…", { exact: true })).toBeVisible();
    await expect(drawer).toHaveCount(0);
  } finally {
    resumeStream();
  }
  const close = drawer.getByRole("button", { name: "Close" });
  const copy = drawer.getByRole("button", { name: "Copy agent link" });
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport();
  await page.unroute("**/api/stream**");
  expect(new URL(page.url()).searchParams.get("agent")).toBe("brief.writer");
  expect(new URL(page.url()).searchParams.get("from")).toBe("review");
  await copy.click();
  await expect(drawer.getByText("Agent link copied.")).toBeVisible();
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.pathname).toBe("/arenas/linked");
  expect(copied.searchParams.get("agent")).toBe("brief.writer");
  expect(copied.searchParams.get("from")).toBe("review");
  await report(request, "linked", "brief.writer", { status: "working", activity: "Drafting an update" });
  await expect(drawer.getByText("Drafting an update", { exact: true })).toBeVisible();
  await expect(copy).toBeFocused();

  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await page.reload();
  await expect(close).toBeFocused();
  await copy.click();
  const fallback = drawer.getByRole("textbox", { name: "Agent link" });
  await expect(fallback).toHaveValue(copied.href);
  await expect(copy).toBeFocused();
  await fallback.focus();
  expect(await fallback.evaluate((el) => el instanceof HTMLInputElement && el.selectionEnd === el.value.length)).toBe(true);
  await close.click();
  await expect(drawer).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("agent")).toBe(false);
  expect(new URL(page.url()).searchParams.get("from")).toBe("review");
  await expect(page.getByRole("searchbox", { name: "Search agents" })).toBeFocused();
});

test("agent drawers follow browser history and dismiss without reopening on live updates", async ({ page, request }) => {
  await createArena(request, "history");
  await report(request, "history", "analyst", { status: "working", displayName: "Analyst" });
  await report(request, "history", "reviewer", { status: "idle", displayName: "Reviewer" });
  await login(page);
  await page.goto("/arenas/history?from=roster&agent=missing");
  await expect(page.getByText("Agent “missing” is unavailable in this arena.")).toBeVisible();
  await page.getByRole("button", { name: "Clear agent link" }).click();
  await expect(page).toHaveURL(/\/arenas\/history\?from=roster$/);

  const analyst = page.getByRole("complementary", { name: "Analyst details" });
  const reviewer = page.getByRole("complementary", { name: "Reviewer details" });
  const roster = page.getByRole("complementary", { name: "Agents" });
  await roster.getByRole("button", { name: /^Analyst/ }).click();
  await expect(analyst).toBeVisible();
  expect(new URL(page.url()).searchParams.get("agent")).toBe("analyst");
  await page.goBack();
  await expect(analyst).toHaveCount(0);
  await page.goForward();
  await expect(analyst).toBeVisible();

  const scene = page.getByRole("region", { name: "Office workspace" });
  await scene.getByRole("button", { name: /^Reviewer:/ }).click();
  await expect(reviewer).toBeVisible();
  await expect(analyst).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("agent")).toBe("reviewer");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/arenas\/history\?from=roster$/);
  await report(request, "history", "reviewer", { status: "working", activity: "Checking the draft" });
  await expect(roster.getByText("Checking the draft")).toBeVisible();
  await expect(reviewer).toHaveCount(0);
  await page.reload();
  await expect(roster.getByText("Checking the draft")).toBeVisible();
  await expect(reviewer).toHaveCount(0);
});
