import { expect, test } from "@playwright/test";
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
    const drawer = page.getByRole("complementary", { name: "Second details" });
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
