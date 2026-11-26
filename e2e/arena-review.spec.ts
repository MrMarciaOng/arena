import { expect, test } from "@playwright/test";
import { E2E_ENV } from "../playwright.config";
import { admin, createArena, login, report } from "./helpers";

test("overview links open the correct agent and the mobile drawer keeps focus inside", async ({ page, request }) => {
  const name = "Release coordination agent for all regional launch approvals";
  await createArena(request, "overview-links");
  for (const suffix of ["alpha", "bravo"]) {
    const profile = await request.put(`/api/arenas/overview-links/agents/${suffix}`, {
      headers: admin,
      data: { displayName: `${name} ${suffix}`, role: "Release reviewer" },
    });
    expect(profile.ok()).toBe(true);
    await report(request, "overview-links", suffix, { status: "working", activity: "Checking launch approval" });
  }
  await page.setViewportSize({ width: 390, height: 850 });
  await login(page);
  const card = page.locator('[data-arena="overview-links"]');
  await expect(card.getByText("Checking launch approval")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  for (const suffix of ["alpha", "bravo"]) {
    const link = card.getByRole("link", { name: new RegExp(suffix) });
    await link.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: `${name} ${suffix} details` });
    const close = drawer.getByRole("button", { name: "Close" });
    const copy = drawer.getByRole("button", { name: "Copy agent link" });
    await expect(close).toBeFocused();
    await expect(close).toBeInViewport();
    await expect(drawer.getByRole("heading", { name: `${name} ${suffix}` })).toBeVisible();
    await expect(drawer.getByText("Release reviewer")).toBeVisible();
    await expect(drawer.getByText(suffix, { exact: true })).toBeVisible();
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Shift+Tab");
    await expect(copy).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search agents" })).toBeFocused();
    await page.goBack();
    await expect(card).toBeVisible();
  }

  await card.getByRole("link", { name: "Overview-links", exact: true }).click();
  await expect(page).toHaveURL(/\/arenas\/overview-links$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("count shortcuts focus the filtered roster and List is remembered per arena", async ({ page, request }) => {
  await createArena(request, "remember");
  await createArena(request, "unvisited");
  await report(request, "remember", "planner", { status: "waiting", waitingOn: "human", displayName: "Release Planner" });
  await report(request, "remember", "reader", { status: "working", displayName: "Reader" });
  await page.setViewportSize({ width: 390, height: 850 });
  await login(page);
  await page.goto("/arenas/remember");
  const roster = page.getByRole("complementary", { name: "Agents" });
  const search = roster.getByRole("searchbox");
  await search.fill("planner");
  await page.getByRole("button", { name: /1 needs you/ }).press("Enter");
  const heading = roster.getByRole("heading", { name: "Agents" });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(roster.getByRole("combobox", { name: "Agent status" })).toHaveValue("needsYou");
  await expect(search).toHaveValue("planner");
  await expect(roster.getByRole("button", { name: /Release Planner/ })).toBeInViewport();
  await expect(page.locator("[data-agent-sprite]")).toHaveCount(2);
  await search.fill("no match");
  await expect(roster.getByText("No agents match these filters.")).toBeVisible();
  await expect(roster.getByRole("link", { name: "Go to API keys" })).toHaveCount(0);

  await page.getByRole("button", { name: "list", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "list", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Back to the arena" }).click();
  await expect(page.getByRole("button", { name: "list", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/arenas/remember?agent=planner");
  await expect(page.getByRole("dialog", { name: "Release Planner details" })).toBeVisible();
  await page.goto("/arenas/unvisited");
  await expect(page.getByRole("button", { name: "scene", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(roster.getByText("Agents appear after their first report.")).toBeVisible();
  await roster.getByRole("link", { name: "Connect an agent" }).click();
  await expect(page).toHaveURL(/\/arenas\/unvisited\/connect$/);
  await expect(page.getByRole("heading", { name: "Connect agents" })).toBeVisible();
});

test("overview and arena can retry an initially rejected stream", async ({ page, request }) => {
  await createArena(request, "retry-stream");
  await login(page);
  let unavailable = true;
  await page.route("**/api/stream**", (route) => unavailable ? route.fulfill({ status: 403 }) : route.continue());
  for (const [path, heading] of [["/", "Your arenas"], ["/arenas/retry-stream", "Retry-stream"]]) {
    unavailable = true;
    await page.goto(path);
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Couldn’t connect to live updates.");
    await expect(page.getByText("Connecting…", { exact: true })).toHaveCount(0);
    unavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
});

test("a failed answer can be retried and a pinned answer stays visible during a later failure", async ({ page, request }) => {
  await createArena(request, "retry-drawer");
  await report(request, "retry-drawer", "writer", { status: "done", result: "## First answer", displayName: "Writer" });
  await login(page);
  let unavailable = true;
  await page.route("**/api/arenas/retry-drawer/agents/writer", (route) =>
    unavailable ? route.fulfill({ status: 503, json: { error: { message: "Try later" } } }) : route.continue(),
  );
  await page.goto("/arenas/retry-drawer?agent=writer");
  const drawer = page.getByRole("complementary", { name: "Writer details" });
  await expect(drawer.getByRole("alert")).toContainText("Try later");
  await expect(drawer.getByText("Loading the answer…")).toHaveCount(0);
  unavailable = false;
  await drawer.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "First answer" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Timeline" })).toBeVisible();
  unavailable = true;
  await report(request, "retry-drawer", "writer", { status: "done", result: "## Second answer" });
  await expect(drawer.getByRole("alert")).toContainText("Try later");
  await expect(drawer.getByRole("heading", { name: "First answer" })).toBeVisible();
});

test("a removal confirmation identifies the agent and a stale failure leaves the row in place", async ({ page, request }) => {
  await createArena(request, "remove-confirmation");
  for (const key of ["first", "second"]) {
    await report(request, "remove-confirmation", key, { status: "idle", displayName: "Reviewer" });
  }
  await login(page);
  await page.goto("/arenas/remove-confirmation/settings");
  let actionRequests = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/arenas/remove-confirmation/settings")) actionRequests += 1;
  });
  const first = page.locator('[data-settings-agent="first"]');
  const second = page.locator('[data-settings-agent="second"]');
  const remove = first.getByRole("button", { name: "Remove Reviewer" });
  await remove.click();
  await expect(first.getByText("Remove Reviewer (first) from this arena?")).toBeVisible();
  const cancel = first.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  expect(actionRequests).toBe(0);
  await cancel.click();
  await expect(remove).toBeFocused();
  expect(actionRequests).toBe(0);
  await remove.click();
  await first.getByRole("button", { name: "Confirm removal" }).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  expect(actionRequests).toBe(1);

  expect((await request.delete("/api/arenas/remove-confirmation/agents/second", { headers: admin })).status()).toBe(204);
  await report(request, "remove-confirmation", "second", { status: "idle", displayName: "New Reviewer" });
  await second.getByRole("button", { name: "Remove Reviewer" }).click();
  await second.getByRole("button", { name: "Confirm removal" }).click();
  await expect(second.getByRole("alert")).toContainText("this agent has changed");
});

test("the displayed sample command copies with line breaks and has a selectable fallback", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.getByRole("link", { name: "New arena" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Command example");
  await page.getByLabel("Slug (used in URLs and the API)").fill("command-example");
  await page.getByRole("button", { name: "Create arena" }).click();
  const command = page.locator("pre").filter({ hasText: "curl -X POST" });
  const text = await command.textContent();
  expect(text?.split("\n")).toHaveLength(3);
  await page.getByRole("button", { name: "Copy key", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "API key copied." })).toBeVisible();
  const copy = page.getByRole("button", { name: "Copy command", exact: true });
  await copy.click();
  await expect(page.getByRole("status").filter({ hasText: "Command copied." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await copy.click();
  const fallback = page.getByRole("textbox", { name: "Reporting command" });
  await expect(fallback).toHaveValue(text!);
  await fallback.focus();
  expect(await fallback.evaluate((node) => node instanceof HTMLTextAreaElement && node.selectionEnd === node.value.length)).toBe(true);
});

test("a stream sign-in redirect preserves the agent link and the rest of the URL", async ({ page, request }) => {
  await createArena(request, "session-return");
  await report(request, "session-return", "writer", { status: "working", displayName: "Writer" });
  await login(page);
  // The stream refuses because the session has expired, so the cookie is gone too (otherwise the
  // login page, seeing a valid session, sends the browser straight back).
  await page.route("**/api/stream**", async (route) => {
    await page.context().clearCookies();
    await route.fulfill({ status: 401 });
  });
  await page.goto("/arenas/session-return?agent=writer&from=overview#task");
  await expect(page).toHaveURL(/\/login\?next=/);
  const loginUrl = new URL(page.url());
  const next = new URL(loginUrl.searchParams.get("next") ?? "/", loginUrl);
  expect(next.pathname).toBe("/arenas/session-return");
  expect(next.searchParams.get("agent")).toBe("writer");
  expect(next.searchParams.get("from")).toBe("overview");
  expect(next.hash).toBe("#task");
  await page.unroute("**/api/stream**");
  await page.getByLabel("Password").fill(E2E_ENV.ARENA_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("complementary", { name: "Writer details" })).toBeVisible();
});
