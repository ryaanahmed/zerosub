import { freshUsage, windowModel } from "../shared/quota";
import type { Usage } from "../shared/model";
import type { StoredAccount } from "./state";

const TRUST_MS = 15 * 60_000;
const FALLBACK_MS = 60 * 60_000;

/** Reconcile only authoritative readings. Missing windows never prove that a notice has cleared. */
export function applyUsageLimits(account: StoredAccount, usage: Usage, now: number): void {
  if (!freshUsage(usage, now) || usage.windows.length === 0) return;
  const full = usage.windows.filter((window) => window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > now));
  const shared = usage.windows.filter((window) => !windowModel(window));
  const sharedFull = full.filter((window) => !windowModel(window));
  const models = { ...account.modelLimits };

  // Each scoped quota survives restarts independently of the account-wide limit.
  for (const window of full) {
    const model = windowModel(window);
    if (!model) continue;
    const until = window.resetsAt ?? new Date(now + FALLBACK_MS).toISOString();
    if (!models[model] || Date.parse(models[model].until) < Date.parse(until)) {
      models[model] = { until, at: new Date(now).toISOString(), source: "usage" };
    }
  }
  for (const [model, limit] of Object.entries(models)) {
    const windows = usage.windows.filter((window) => windowModel(window) === model);
    if (windows.length && windows.every((window) => window.usedPercent < 90) && now - Date.parse(limit.at) > TRUST_MS) delete models[model];
  }
  account.modelLimits = models;

  // Old releases persisted a scoped window as a shared limit. Repair that exact fingerprint
  // only with both known shared Claude windows present and roomy; unknown/notice/budget limits stay.
  const sharedRoomy = shared.some((window) => window.id === "five_hour") && shared.some((window) => window.id === "seven_day") && shared.every((window) => window.usedPercent < 90);
  const settled = !account.limitedAt || now - Date.parse(account.limitedAt) > TRUST_MS;
  const polluted = account.family === "claude" && account.limitKind === "window" && !account.limitSource && settled && sharedRoomy && full.some((window) => windowModel(window) && window.resetsAt === account.limitedUntil);
  if (polluted) {
    account.limitedUntil = null;
    account.limitKind = null;
    account.limitedAt = null;
  }

  if (account.limitKind === "budget") return;
  if (sharedFull.length) {
    const until = new Date(Math.max(...sharedFull.map((window) => Date.parse(window.resetsAt ?? "") || now + FALLBACK_MS))).toISOString();
    // A notice may describe a longer shared quota than this reading exposes.
    if (!account.limitedUntil || Date.parse(account.limitedUntil) < Date.parse(until)) {
      account.limitedUntil = until;
      account.limitKind = "window";
      account.limitedAt = new Date(now).toISOString();
      account.limitSource = "usage";
    }
  } else if (account.limitedUntil && account.limitKind === "window" && settled && (account.family !== "claude" || sharedRoomy) && full.length === 0 && shared.length && usage.windows.every((window) => window.usedPercent < 90)) {
    // Retain the existing recovery rule for ordinary window notices after the trust interval.
    account.limitedUntil = null;
    account.limitKind = null;
    account.limitedAt = null;
    delete account.limitSource;
  }
}
