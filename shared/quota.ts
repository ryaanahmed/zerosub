import type { AccountView, Usage, UsageWindow } from "./model";

/** Only explicit model names establish a narrower quota; unrecognised scopes stay shared. */
export function quotaModel(model: string | null | undefined): string | null {
  return model?.toLowerCase().match(/(?:^|[^a-z])(fable|opus|sonnet|haiku)(?:$|[^a-z])/)?.[1] ?? null;
}

export function windowModel(window: UsageWindow): string | null {
  const match = window.id.match(/^(?:seven_day|weekly)_(fable|opus|sonnet|haiku)(?:_\d[\w_]*)?$/);
  return match?.[1] ?? null;
}

/** Without a known selected model, retain every quota rather than assuming headroom. */
export function relevantWindows(windows: readonly UsageWindow[], model?: string | null): UsageWindow[] {
  const selected = quotaModel(model);
  return windows.filter((window) => !selected || !windowModel(window) || windowModel(window) === selected);
}

/** Saved, cached, failed or old readings may inform display, never repair a persisted limit. */
export function freshUsage(usage: Usage | null | undefined, now: number): usage is Usage {
  const age = now - Date.parse(usage?.fetchedAt ?? "");
  return !!usage && !usage.cached && !usage.error && age >= -30_000 && age <= 5 * 60_000;
}

export function modelLimitUntil(
  limits: Record<string, { until: string }> | undefined,
  model: string | null | undefined,
  now: number,
): string | null {
  const selected = quotaModel(model);
  const active = Object.entries(limits ?? {})
    .filter(([key, limit]) => (!selected || key === selected) && Date.parse(limit.until) > now)
    .map(([, limit]) => limit.until);
  active.sort((a, b) => Date.parse(b) - Date.parse(a));
  return active[0] ?? null;
}


/** Composer availability is for the selected model; account management keeps shared status. */
export function accountForModel(account: AccountView, model: string | null | undefined, now: number): AccountView {
  const until = modelLimitUntil(account.modelLimits, model, now);
  return {
    ...account,
    status: account.status === "ready" && until ? "limited" : account.status,
    limitedUntil: account.limitedUntil ?? until,
    usage: account.usage ? { ...account.usage, windows: relevantWindows(account.usage.windows, model) } : null,
  };
}
