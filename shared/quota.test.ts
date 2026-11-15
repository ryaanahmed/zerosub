import { describe, expect, it } from "vitest";
import { AccountViewSchema } from "./model";
import { accountForModel } from "./quota";

describe("composer quota availability", () => {
  it("shows a Fable limit only to Fable agents while preserving shared and signed-out status", () => {
    const now = Date.now();
    const until = new Date(now + 60_000).toISOString();
    const account = AccountViewSchema.parse({ id: "a", family: "claude", label: "A", kind: "main", email: null, plan: null, organization: null, status: "ready", isDefault: true, limitedUntil: null, usage: null, agentCount: 1, home: null, modelLimits: { fable: { until } } });
    expect(accountForModel(account, "claude-fable-5", now).status).toBe("limited");
    expect(accountForModel(account, "claude-opus-5-5", now).status).toBe("ready");
    expect(accountForModel(account, null, now).status).toBe("limited");
    expect(accountForModel({ ...account, status: "signed_out" }, "fable", now).status).toBe("signed_out");
    expect(accountForModel({ ...account, status: "limited", limitedUntil: until }, "opus", now).status).toBe("limited");
    expect(accountForModel(account, "fable", now + 120_000).status).toBe("ready");
  });
});
