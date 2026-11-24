import { describe, expect, it } from "vitest";
import { seal, unseal } from "./secrets";

describe("seal / unseal", () => {
  it("round-trips, and a sealed value doesn't contain the plain one", () => {
    const sealed = seal("arena_secret_value")!;
    expect(sealed).not.toContain("arena_secret_value");
    expect(unseal(sealed)).toBe("arena_secret_value");
    expect(seal("arena_secret_value")).not.toBe(sealed); // fresh IV each time
  });

  it("refuses tampered, truncated or foreign values", () => {
    const sealed = seal("some secret value")!;
    const [v, iv, tag, body] = sealed.split(".");
    // Flip one bit of the decoded ciphertext and of the tag.
    const flip = (part: string) => {
      const bytes = Buffer.from(part, "base64url");
      bytes[0] ^= 1;
      return bytes.toString("base64url");
    };
    expect(unseal([v, iv, tag, flip(body)].join("."))).toBeNull();
    expect(unseal([v, iv, flip(tag), body].join("."))).toBeNull();
    // A shortened tag is refused rather than checked at reduced strength.
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 8).toString("base64url");
    expect(unseal([v, iv, shortTag, body].join("."))).toBeNull();
    expect(unseal("v2.a.b.c")).toBeNull();
    expect(unseal(null)).toBeNull();
  });

  it("uses ARENA_ENCRYPTION_KEY when set, and can't open values sealed under another secret", () => {
    const underSession = seal("x")!;
    process.env.ARENA_ENCRYPTION_KEY = "another-secret-entirely-0123456789abcdef";
    expect(unseal(underSession)).toBeNull();
    expect(unseal(seal("y"))).toBe("y");
  });

  it("can't seal without any secret", () => {
    delete process.env.ARENA_ENCRYPTION_KEY;
    delete process.env.ARENA_SESSION_SECRET;
    delete process.env.ARENA_OWNER_PASSWORD;
    expect(seal("x")).toBeNull();
  });
});
