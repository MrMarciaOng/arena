import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assistantPrompt, curlExample, installCommand, shellQuote, uninstallCommand } from "./connect";

const values = { origin: "https://arena.example", slug: "career", token: "arena_AbC-123_xyz" };

/** What the shell makes of a quoted value. */
const throughShell = (quoted: string) => execFileSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });

describe("connect snippets", () => {
  it("quotes values so the shell reads them back unchanged", () => {
    for (const value of ["arena_AbC-123_xyz", "arena_x7Kd…", "it's", "a b", "$HOME", "`id`", "x'; rm -rf ~; '"]) {
      expect(throughShell(shellQuote(value)), value).toBe(value);
    }
    expect(shellQuote("arena_AbC-123_xyz")).toBe("arena_AbC-123_xyz");
  });

  it("builds the install command with this arena's values", () => {
    expect(installCommand(values, ["skill"])).toBe(
      "curl -fsSL https://arena.example/api/connect/install.js | ARENA_TOKEN=arena_AbC-123_xyz node - skill --arena career",
    );
    expect(installCommand({ ...values, token: "arena_x7Kd…" }, ["skill", "codex"])).toBe(
      "curl -fsSL https://arena.example/api/connect/install.js | ARENA_TOKEN='arena_x7Kd…' node - skill codex --arena career",
    );
    expect(uninstallCommand("https://arena.example")).toBe("curl -fsSL https://arena.example/api/connect/install.js | node - uninstall");
  });

  it("gives a curl report and an assistant prompt that use the arena's endpoints and key", () => {
    const curl = curlExample(values);
    expect(curl).toContain("POST https://arena.example/api/arenas/career/agents/my-agent/status");
    expect(curl).toContain("Authorization: Bearer arena_AbC-123_xyz");

    const prompt = assistantPrompt(values);
    expect(prompt).toContain("API key: arena_AbC-123_xyz");
    expect(prompt).toContain("https://arena.example/api/arenas/career/agents/<agent-key>/status");
    expect(prompt).toContain("https://arena.example/api/arenas/career/agents/<agent-key>/heartbeat");
    expect(prompt).toContain("-X DELETE https://arena.example/api/arenas/career/agents/<agent-key>");
    for (const status of ['"working"', '"waiting"', '"done"', '"error"', '"idle"']) expect(prompt).toContain(status);
  });

  it("shows a masked key everywhere the real one would go", () => {
    const masked = { ...values, token: "arena_AbC-…" };
    for (const text of [installCommand(masked, ["skill"]), curlExample(masked), assistantPrompt(masked)]) {
      expect(text).not.toContain(values.token);
      expect(text).toContain("arena_AbC-…");
    }
  });
});
