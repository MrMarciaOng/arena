import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createArena, login } from "./helpers";

const clipboard = (page: import("@playwright/test").Page) => page.evaluate(() => navigator.clipboard.readText());

test("an empty arena leads to Connect agents, whose copied commands carry the real key and work", async ({ page, request, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { apiKey } = await createArena(request, "hookup");
  await login(page);

  await page.goto("/arenas/hookup");
  await page.getByRole("link", { name: "Connect an agent" }).click();
  await expect(page.getByRole("heading", { name: "Connect agents" })).toBeVisible();
  await expect(page.getByText("Ready: Copy puts the full key in each command.")).toBeVisible();
  // The key is fetched for Copy, but the page shows it masked until asked.
  await expect(page.locator("main")).not.toContainText(apiKey.token);
  await page.screenshot({ path: "test-results/connect.png", fullPage: true });

  // Claude Code is the first tab; its skill command carries the real key.
  await page.getByRole("button", { name: "Copy: Let Claude report for itself (recommended)" }).click();
  await expect(page.getByRole("button", { name: "Copy: Let Claude report for itself (recommended)" })).toHaveText("Copied");
  const skillCommand = await clipboard(page);
  expect(skillCommand).toBe(`curl -fsSL ${baseURL}/api/connect/install.js | ARENA_TOKEN=${apiKey.token} node - skill --arena hookup`);
  // "Copied" belongs to that one snippet: another tab's button doesn't inherit it.
  await page.getByRole("tab", { name: "Codex" }).click();
  await expect(page.getByRole("button", { name: "Copy: Install the skill and Codex's notify" })).toHaveText("Copy");
  await page.getByRole("tab", { name: "Claude Code" }).click();

  // Run it as copied, in a throwaway home: it installs the skill and Arena accepts the saved details.
  const home = mkdtempSync(path.join(os.tmpdir(), "arena-e2e-home-"));
  try {
    const output = execFileSync("sh", ["-c", skillCommand], {
      env: { PATH: process.env.PATH ?? "", HOME: home } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(output).toContain('ok: arena "Hookup" (hookup)');
    expect(readFileSync(path.join(home, ".claude", "skills", "arena-presence", "SKILL.md"), "utf8")).toContain("name: arena-presence");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // Arrow keys move between the tool tabs.
  await page.getByRole("tab", { name: "Claude Code" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Codex" })).toBeFocused();

  // The assistant prompt carries the key and this arena's endpoints.
  await page.getByRole("tab", { name: "Any AI assistant" }).click();
  await page.getByRole("button", { name: "Copy: Paste this into your AI assistant" }).click();
  const prompt = await clipboard(page);
  expect(prompt).toContain(`API key: ${apiKey.token}`);
  expect(prompt).toContain(`${baseURL}/api/arenas/hookup/agents/<agent-key>/status`);

  // The raw curl report works as copied, and the page sees the agent arrive.
  await page.getByRole("tab", { name: "Shell and cron" }).click();
  await page.getByRole("button", { name: "Copy: Or call the API directly" }).click();
  execFileSync("sh", ["-c", await clipboard(page)], { stdio: "ignore" });
  const status = page.locator("[data-connect-status]");
  await expect(status).toContainText("1 agent on this arena.");
  await expect(status).toContainText("Latest: My agent");

  // A key made here is chosen at once and used by the commands.
  await page.getByLabel("New key").fill("e2e-laptop");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.locator('[data-key-option="e2e-laptop"] input')).toBeChecked();
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await expect(page.getByText("Ready: Copy puts the full key in each command.")).toBeVisible();
  await page.getByRole("button", { name: "Copy: Or report every session automatically" }).click();
  const hooksCommand = await clipboard(page);
  expect(hooksCommand).toContain("node - claude-hooks --arena hookup");
  expect(hooksCommand).not.toContain(apiKey.token);
  await page.getByRole("button", { name: "Show key" }).click();
  const newToken = /ARENA_TOKEN=(\S+)/.exec(hooksCommand)?.[1];
  expect(newToken).toMatch(/^arena_/);
  await expect(page.locator('[data-snippet="claude-hooks"] pre')).toContainText(newToken!);

  await page.getByRole("link", { name: "Open the arena" }).click();
  await expect(page.locator('[data-agent-sprite="my-agent"]')).toBeVisible();
});

test("the new-arena screen and Settings lead to Connect agents", async ({ page }) => {
  await login(page);
  await page.goto("/arenas/new");
  await page.getByLabel("Name").fill("Wired");
  await page.getByLabel("Slug (used in URLs and the API)").fill("wired");
  await page.getByRole("button", { name: "Create arena" }).click();
  await page.getByRole("link", { name: "Connect agents" }).click();
  await expect(page).toHaveURL(/\/arenas\/wired\/connect\?key=/);
  await expect(page.locator('[data-key-option="default"] input')).toBeChecked();

  await page.goto("/arenas/wired/settings");
  await page.locator("#api-keys").getByRole("link", { name: "Connect agents" }).click();
  await expect(page).toHaveURL(/\/arenas\/wired\/connect$/);
});

test("Connect agents is for the owner only", async ({ page, request }) => {
  await createArena(request, "private");
  await page.goto("/arenas/private/connect");
  await expect(page).toHaveURL(/\/login\?next=%2Farenas%2Fprivate%2Fconnect/);
});

test("at phone width the commands wrap instead of pushing the page sideways", async ({ page, request }) => {
  await createArena(request, "pocket");
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page);
  await page.goto("/arenas/pocket/connect");
  await expect(page.getByText("Ready: Copy puts the full key in each command.")).toBeVisible();
  for (const tab of ["Claude Code", "Codex", "Any AI assistant", "Shell and cron"]) {
    await page.getByRole("tab", { name: tab }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, tab).toBeLessThanOrEqual(0);
  }
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await page.screenshot({ path: "test-results/connect-phone.png", fullPage: true });
});
