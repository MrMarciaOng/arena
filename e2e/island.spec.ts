import { expect, test } from "@playwright/test";
import { createArena, login, report } from "./helpers";

test("the island scene renders staged builds, pond waiting plaza, drawer interaction, and overview thumbnail", async ({
  page,
  request,
}) => {
  await createArena(request, "isle", "island");
  await report(request, "isle", "mason", {
    status: "working",
    activity: "Raising east walls",
    progress: 0.4,
    displayName: "Mason",
  });
  await report(request, "isle", "roofer", {
    status: "working",
    activity: "Setting roof deck",
    progress: 0.72,
    displayName: "Roofer",
  });
  await report(request, "isle", "architect", {
    status: "done",
    activity: "Finished west pavilion",
    result: "## Island pavilion\n\n- Roof topped out and inspected",
    displayName: "Architect",
  });
  await report(request, "isle", "scout", {
    status: "waiting",
    waitingOn: "human",
    waitingFor: "approve the blueprint",
    displayName: "Scout",
  });
  await report(request, "isle", "plumber", {
    status: "error",
    error: "Pipe cracked under slab",
    displayName: "Plumber",
  });
  await report(request, "isle", "surveyor", {
    status: "idle",
    displayName: "Surveyor",
  });

  await login(page);
  await page.goto("/arenas/isle");

  const workspace = page.getByRole("region", { name: "Island workspace" });
  await expect(workspace).toBeVisible();
  await expect(workspace.locator("canvas")).toBeVisible();

  const mason = workspace.locator('[data-agent-sprite="mason"]');
  const roofer = workspace.locator('[data-agent-sprite="roofer"]');
  const architect = workspace.locator('[data-agent-sprite="architect"]');
  const scout = workspace.locator('[data-agent-sprite="scout"]');
  const plumber = workspace.locator('[data-agent-sprite="plumber"]');
  const surveyor = workspace.locator('[data-agent-sprite="surveyor"]');

  await expect(mason).toHaveAttribute("data-pose", "work");
  await expect(mason).toHaveAttribute("data-zone", "station");
  await expect(roofer).toHaveAttribute("data-pose", "work");
  await expect(roofer).toHaveAttribute("data-zone", "station");
  await expect(architect).toHaveAttribute("data-pose", "done");
  await expect(architect).toHaveAttribute("data-zone", "station");
  await expect(scout).toHaveAttribute("data-pose", "wait", { timeout: 5000 });
  await expect(scout).toHaveAttribute("data-zone", "waiting");
  await expect(scout).toHaveAttribute("aria-label", /Needs you.*approve the blueprint/);
  await expect(plumber).toHaveAttribute("data-pose", "error");
  await expect(plumber).toHaveAttribute("data-zone", "station");
  await expect(surveyor).toHaveAttribute("data-pose", "idle");
  await expect(surveyor).toHaveAttribute("data-zone", "station");

  // Wait briefly so WebGL frames & projected button transforms settle cleanly before screenshotting.
  await expect
    .poll(() => mason.evaluate((el) => getComputedStyle(el).transform !== "none"))
    .toBe(true);
  await page.screenshot({ path: "test-results/scene-island.png", fullPage: true });

  // Clicking a projected worker opens the same AgentDrawer.
  await architect.click();
  await expect(
    page.getByRole("complementary", { name: "Architect details" }).getByRole("heading", { name: "Island pavilion" }),
  ).toBeVisible();

  // The open drawer covers part of the island: no worker, nameplate or bubble may show through it
  // or catch clicks meant for the drawer.
  const drawer = page.getByRole("complementary", { name: "Architect details" });
  const leaks = await drawer.evaluate((aside) => {
    const box = aside.getBoundingClientRect();
    const result = { checked: 0, leaking: [] as string[] };
    for (const el of document.querySelectorAll<HTMLElement>(".scene-island [data-agent-sprite], .scene-island [data-agent-sprite] *")) {
      const r = el.getBoundingClientRect();
      const left = Math.max(r.left, box.left);
      const right = Math.min(r.right, box.right);
      const top = Math.max(r.top, box.top);
      const bottom = Math.min(r.bottom, box.bottom);
      if (right - left < 2 || bottom - top < 2) continue;
      result.checked += 1;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (hit && !aside.contains(hit)) result.leaking.push(el.closest<HTMLElement>("[data-agent-sprite]")!.dataset.agentSprite!);
    }
    return result;
  });
  expect(leaks.checked).toBeGreaterThan(0);
  expect(leaks.leaking).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Architect details" })).toHaveCount(0);

  // Overview thumbnail renders cleanly and reflects live agent state.
  await page.goto("/");
  const card = page.locator('[data-arena="isle"]');
  await expect(card).toBeVisible();
  await expect(card.locator("canvas")).toBeVisible();
  await expect(card.locator('[data-agent-sprite="architect"]')).toHaveAttribute("data-pose", "done");
  await expect(card.locator('[data-agent-sprite="scout"]')).toHaveAttribute("data-zone", "waiting");
  await card.screenshot({ path: "test-results/overview-island.png" });
});
