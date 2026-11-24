import { describe, expect, it } from "vitest";
import { plainText, shortDuration } from "./format";

describe("format", () => {
  it("turns a markdown answer into a plain one-liner", () => {
    expect(plainText("## Three listings\n\n- **Lisbon** in `PT`\n- [Porto](https://x.example)")).toBe("Three listings Lisbon in PT Porto");
  });

  it("keeps the content of fenced code", () => {
    expect(plainText("```\nnpm run build\n```")).toBe("npm run build");
  });

  it("formats short durations", () => {
    expect(shortDuration(2000)).toBe("now");
    expect(shortDuration(90_000)).toBe("1m");
    expect(shortDuration(3 * 3600_000)).toBe("3h");
    expect(shortDuration(3 * 86_400_000)).toBe("3d");
  });
});
