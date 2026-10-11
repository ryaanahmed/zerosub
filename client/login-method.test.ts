import { describe, expect, it } from "vitest";
import { initialLoginMethod } from "./login-method";

describe("initial sign-in method", () => {
  it.each(["ios", "android"] as const)("uses a code on native %s at either width", (platform) => {
    expect(initialLoginMethod({ platform, compact: true }, true)).toBe("code");
    expect(initialLoginMethod({ platform, compact: false }, true)).toBe("code");
  });

  it("uses a code in compact web clients even when the daemon has a browser", () => {
    expect(initialLoginMethod({ platform: "web", compact: true }, true)).toBe("code");
    expect(initialLoginMethod({ platform: "web", compact: true }, undefined)).toBe("code");
  });

  it("preserves browser sign-in in wide web clients", () => {
    expect(initialLoginMethod({ platform: "web", compact: false }, true)).toBe("browser");
    expect(initialLoginMethod({ platform: "web", compact: false }, undefined)).toBe("browser");
  });

  it.each(["ios", "android", "web"] as const)("uses a code on %s when the daemon has no browser", (platform) => {
    expect(initialLoginMethod({ platform, compact: true }, false)).toBe("code");
    expect(initialLoginMethod({ platform, compact: false }, false)).toBe("code");
  });
});
