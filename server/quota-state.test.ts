import { describe, expect, it } from "vitest";
import { applyUsageLimits } from "./quota-state";
import { StoredAccountSchema } from "./state";
import { isLimited, mostAvailable, chooseAccount, headroomScore } from "./routing";
import { emptyState } from "./state";
import type { Usage } from "../shared/model";
import { windowModel } from "../shared/quota";

const NOW = Date.parse("2026-11-15T14:00:00Z");
const UNTIL = "2026-11-16T14:00:00.000Z";
const OLD = "2026-11-15T13:00:00Z";
function account() {
  return StoredAccountSchema.parse({ id: "a", family: "claude", label: "A", kind: "main", home: null, createdAt: OLD });
}
function reading(shared = 30): Usage {
  return { fetchedAt: new Date(NOW).toISOString(), cached: false, error: null, resets: null, windows: [
    { id: "five_hour", label: "5-hour", usedPercent: shared, resetsAt: UNTIL },
    { id: "seven_day", label: "Weekly", usedPercent: 20, resetsAt: UNTIL },
    { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 100, resetsAt: UNTIL },
  ] };
}

describe("scoped quota evidence", () => {
  it("persists Fable exhaustion without excluding Opus, including after state reload", () => {
    const a = account();
    applyUsageLimits(a, reading(), NOW);
    const reloaded = StoredAccountSchema.parse(JSON.parse(JSON.stringify(a)));
    expect(reloaded.limitedUntil).toBeNull();
    expect(isLimited(reloaded, NOW, "claude-opus-5-5")).toBe(false);
    expect(isLimited(reloaded, NOW, "claude-fable-5")).toBe(true);
    expect(isLimited(reloaded, NOW)).toBe(true);
    expect(headroomScore(reading(), "opus")).toBe(30);
    expect(headroomScore(reading(), "fable")).toBe(100);
  });

  it("blocks both models on a full shared quota and retains budget limits", () => {
    const a = account();
    applyUsageLimits(a, reading(100), NOW);
    expect(isLimited(a, NOW, "opus")).toBe(true);
    expect(isLimited(a, NOW, "fable")).toBe(true);
    a.limitKind = "budget";
    a.limitedUntil = "2026-12-01T00:00:00Z";
    applyUsageLimits(a, reading(100), NOW);
    expect(a.limitKind).toBe("budget");
    expect(a.limitedUntil).toBe("2026-12-01T00:00:00Z");
  });

  it("selects a Fable-limited account for Opus failover and uses the model on resumes", () => {
    const a = account();
    applyUsageLimits(a, reading(), NOW);
    const b = { ...account(), id: "b" };
    const state = { ...emptyState(), accounts: [a, b], defaults: { claude: "a", codex: null } };
    expect(mostAvailable(state, "claude", () => reading(), NOW, new Set(["b"]), "opus")?.id).toBe("a");
    expect(mostAvailable(state, "claude", () => reading(), NOW, new Set(["b"]), "fable")).toBeUndefined();
    const input = { agentId: "x", family: "claude" as const, reason: "resume" as const, now: NOW, autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: () => null };
    expect(chooseAccount(state, { ...input, model: "fable" })?.account.id).toBe("b");
    expect(chooseAccount(state, { ...input, model: "opus" })?.account.id).toBe("a");
    a.disabled = true;
    expect(chooseAccount(state, { ...input, model: "opus" })?.account.id).toBe("b");
    a.disabled = false;
    a.signedIn = false;
    expect(chooseAccount(state, { ...input, model: "opus" })?.account.id).toBe("b");
  });

  it("repairs only the old scoped-reset fingerprint with complete roomy shared evidence", () => {
    const a = { ...account(), limitedUntil: UNTIL, limitedAt: OLD, limitKind: "window" as const };
    applyUsageLimits(a, reading(), NOW);
    expect(a.limitedUntil).toBeNull();
    expect(a.modelLimits?.fable?.until).toBe(UNTIL);
    for (const patch of [ { limitKind: "budget" as const }, { limitKind: null }, { limitSource: "notice" as const }, { limitedUntil: "2026-11-17T00:00:00Z" }, { limitedAt: new Date(NOW).toISOString() } ]) {
      const unknown = { ...account(), limitedUntil: UNTIL, limitedAt: OLD, limitKind: "window" as const, ...patch };
      applyUsageLimits(unknown, reading(), NOW);
      expect(unknown.limitedUntil).not.toBeNull();
    }
    const incomplete = { ...account(), limitedUntil: UNTIL, limitedAt: OLD, limitKind: "window" as const };
    const usage = reading();
    usage.windows = usage.windows.filter((window) => window.id !== "seven_day");
    applyUsageLimits(incomplete, usage, NOW);
    expect(incomplete.limitedUntil).toBe(UNTIL);
  });

  it.each([{ cached: true }, { error: "unavailable" }, { fetchedAt: OLD }])("never repairs a marker using an untrusted reading %j", (patch) => {
    const a = { ...account(), limitedUntil: UNTIL, limitedAt: OLD, limitKind: "window" as const };
    applyUsageLimits(a, { ...reading(), ...patch }, NOW);
    expect(a.limitedUntil).toBe(UNTIL);
    expect(a.modelLimits).toBeUndefined();
  });

  it("retains limits when readings are absent and recognises only known model scopes", () => {
    const a = { ...account(), limitedUntil: UNTIL, limitedAt: OLD, limitKind: "window" as const };
    applyUsageLimits(a, { ...reading(), windows: [] }, NOW);
    expect(a.limitedUntil).toBe(UNTIL);
    expect(windowModel({ ...reading().windows[0]!, id: "seven_day_opus" })).toBe("opus");
    expect(windowModel({ ...reading().windows[0]!, id: "weekly_unknown_surface" })).toBeNull();
  });
});


describe("fresh readings before persistence", () => {
  it("checks applicable full windows on both default routing and alternative selection", () => {
    const a = account();
    const b = { ...account(), id: "b" };
    const state = { ...emptyState(), accounts: [a, b] };
    const input = { agentId: "x", family: "claude" as const, reason: "create" as const, now: NOW, autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: (id: string) => id === "a" ? reading() : null };
    expect(chooseAccount(state, { ...input, model: "fable" })?.account.id).toBe("b");
    expect(chooseAccount(state, { ...input, model: "opus" })?.account.id).toBe("a");
    expect(chooseAccount(state, { ...input, model: "fable", usageOf: () => ({ ...reading(), fetchedAt: OLD }) })?.account.id).toBe("a");
    expect(chooseAccount(state, { ...input, model: "opus", usageOf: (id: string) => id === "a" ? reading(100) : null })?.account.id).toBe("b");
  });
});
