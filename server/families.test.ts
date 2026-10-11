import { describe, expect, it } from "vitest";
import { bringsOwnAuth, familiesFromConfig } from "./families";

const gobstopper = "http://127.0.0.1:8260";

describe("subscription family detection", () => {
  it("routes built-in and extended Claude providers through the trusted local proxy", () => {
    expect(familiesFromConfig({
      claude: { env: { ANTHROPIC_BASE_URL: gobstopper } },
      "claude-worker": { extends: "claude", env: { ANTHROPIC_BASE_URL: gobstopper } },
    })).toEqual({ claude: "claude", codex: "codex", "claude-worker": "claude" });
  });

  it("keeps other endpoints outside account management", () => {
    for (const endpoint of ["https://example.com", "http://127.0.0.1:8261", `${gobstopper}/untrusted`]) {
      expect(bringsOwnAuth("claude", { ANTHROPIC_BASE_URL: endpoint })).toBe(true);
    }
  });

  it("does not override explicit credentials, alternate backends or account homes", () => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
      expect(bringsOwnAuth("claude", { ANTHROPIC_BASE_URL: gobstopper, [key]: "configured" })).toBe(true);
    }
  });

  it("preserves default providers and Codex endpoint exclusions", () => {
    expect(familiesFromConfig(undefined)).toEqual({ claude: "claude", codex: "codex" });
    expect(bringsOwnAuth("claude", undefined)).toBe(false);
    expect(bringsOwnAuth("codex", { OPENAI_BASE_URL: gobstopper })).toBe(true);
    expect(familiesFromConfig({ "codex-key": { extends: "codex", env: { OPENAI_API_KEY: "configured" } } })).toEqual({ claude: "claude", codex: "codex" });
  });
});
