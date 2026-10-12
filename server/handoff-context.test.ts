import { describe, expect, it } from "vitest";
import { continuationContext, SOURCE_PROFILE_LABEL } from "./handoff";

const policy = {
  providerWindowTokens: 1_000_000,
  clientWindowTokens: 500_000,
  outputReserveTokens: 32_000,
  thresholdTokens: 400_000,
};

describe("continuation context policy", () => {
  it("carries the resolved policy without re-resolving its mutable profile", () => {
    expect(continuationContext({ contextPolicy: policy, profileId: "implementation" })).toEqual({
      config: { contextPolicy: policy },
      labels: { [SOURCE_PROFILE_LABEL]: "implementation" },
    });
  });

  it("copies only approved policy fields, excluding account environment and other configuration", () => {
    const source = {
      contextPolicy: { ...policy, env: { ACCOUNT_TOKEN: "test-value" } },
      config: { env: { ACCOUNT_TOKEN: "test-value" } },
      env: { ACCOUNT_TOKEN: "test-value" },
      labels: { unrelated: "private" },
    };
    const result = continuationContext(source);
    expect(result).toEqual({ config: { contextPolicy: policy }, labels: {} });
    expect(result.config.contextPolicy).not.toBe(source.contextPolicy);
  });

  it("leaves an ordinary agent without a policy unchanged", () => {
    expect(continuationContext({ provider: "codex", model: "gpt-test" })).toEqual({ config: {}, labels: {} });
  });

  it("retains original profile provenance across further account continuations", () => {
    expect(continuationContext({ contextPolicy: policy, labels: { [SOURCE_PROFILE_LABEL]: "implementation" } })).toEqual({
      config: { contextPolicy: policy },
      labels: { [SOURCE_PROFILE_LABEL]: "implementation" },
    });
  });

  it("refuses malformed policy instead of silently losing the source limits", () => {
    expect(() => continuationContext({ contextPolicy: { ...policy, thresholdTokens: "400000" } })).toThrow();
    expect(() => continuationContext({ contextPolicy: { clientWindowTokens: 500_000 } })).toThrow();
  });
});
