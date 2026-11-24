import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/arenas/career?x=1#y")).toBe("/arenas/career?x=1#y");
  });

  it("refuses anything a browser would resolve off-site", () => {
    for (const evil of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/.//evil.example",
      "/..//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "https://evil.example",
      "evil",
      null,
      42,
    ]) {
      const result = safeNext(evil);
      expect(result).toBe("/");
    }
  });

  it("always returns something that resolves on this site", () => {
    for (const value of ["/arenas/x", "/./arenas", "/a/../b", "/?next=//evil.example", "/#//evil.example"]) {
      const result = safeNext(value);
      expect(new URL(result, "http://arena.invalid").origin).toBe("http://arena.invalid");
      expect(result.startsWith("//")).toBe(false);
    }
  });
});
