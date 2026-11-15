import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, LimitHit, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectClaudeLimit, detectClaudeSignOut, detectCodexLimit, detectCodexSignOut } from "./limits";
import type { Family } from "../shared/model";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { preferences } from "../shared/preferences";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-failover-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function account(id: string, label: string, kind: "main" | "managed", family: Family = "claude") {
  return { id, family, label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" };
}

/** A Claude adapter whose every failed turn is a session limit resetting at `resetsAt`. */
function claudeAdapter(hit: () => LimitHit): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => reading(),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: (event: { outcome: { kind: string } }) => (event.outcome.kind === "failed" ? hit() : null),
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

function fakePaseo(family: Family = "claude") {
  const history: AgentTimelineItem[] = [];
  const historyReads: Array<{ direction: "tail"; limit: number }> = [];
  const sent: string[] = [];
  const notes: Array<{ from: string | null; to: string; outcome: string; detail: string | null }> = [];
  const agent = { id: AGENT, model: "claude-opus-5-5", provider: family, status: "idle", archivedAt: null, lastUserMessageAt: "2026-09-23T07:00:00.000Z" };
  const peers: Array<typeof agent> = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [agent, ...peers].map((entry) => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: [agent, ...peers].find((entry) => entry.id === id) ?? agent }),
        send: async (text: string) => void sent.push(text),
        timeline: {
          append: async (item: { data: { from: string | null; to: string; outcome: string; detail: string | null } }) =>
            void notes.push(item.data),
          refetch: async (request: { direction: "tail"; limit: number }) => {
            historyReads.push(request);
            return { entries: history.slice(-request.limit).map((item) => ({ item })) };
          },
        },
      }),
    },
  };
  return { paseo, agent, peers, sent, notes, history, historyReads };
}

interface SetUpOptions {
  usage?: FamilyAdapter["usage"];
  family?: Family;
  detectSignOut?: FamilyAdapter["detectSignOut"];
  identity?: FamilyAdapter["identity"];
  /** How `paseo agent reload` ends. */
  reload?: "works" | "fails" | "times out";
  /** Reads turns with a real detector instead of taking every failed turn for a limit. */
  detectLimit?: FamilyAdapter["detectLimit"];
}

async function setUp(state: Partial<StoredState>, hit: () => LimitHit, options: SetUpOptions = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const reopened: string[] = [];
  const family = options.family ?? "claude";
  const fake = fakePaseo(family);
  const context = { paseo: fake.paseo } as never;
  // Paseo asks for the new session's environment before it closes the old session, so the hook has
  // run by the time `paseo agent reload` returns, even when the reload then failed.
  const reopenedSession = (agentId = AGENT) =>
    service.onSessionOpen({ agentId, provider: family, reason: "refresh", purpose: "interactive", env: {} } as never, context);
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reopened.push(id);
      await reopenedSession(id);
      if (options.reload === "fails") {
        return { ok: false as const, error: "Timed out closing previous session during refresh", timedOut: false };
      }
      if (options.reload === "times out") return { ok: false as const, error: "Command failed: paseo agent reload", timedOut: true };
      return { ok: true as const };
    },
  };
  const families = { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) };
  const adapters: Record<Family, FamilyAdapter> = { claude: claudeAdapter(hit), codex: { ...claudeAdapter(hit), family: "codex", portable: false } };
  adapters[family] = {
    ...adapters[family],
    ...(options.detectLimit ? { detectLimit: options.detectLimit } : {}),
    ...(options.detectSignOut ? { detectSignOut: options.detectSignOut } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
  };
  const service = new Service(
    adapters,
    store,
    families as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  return { service, store, reopened, limitTurn, ...fake };
}

const inFuture = () => new Date(Date.now() + 30 * 60_000).toISOString();
const inPast = () => new Date(Date.now() - 60_000).toISOString();

describe("failover", () => {
  it("blames the CLI login for a session ZeroSub never routed, even when the agent is bound elsewhere", async () => {
    // Today's incident: the agent's session predates zerosub, and a switch to "hello" was waiting.
    const { store, reopened, sent, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" }),
    );
    await limitTurn();
    const state = await store.read();
    expect(state.accounts.find((a) => a.id === MAIN)?.limitedUntil).not.toBeNull();
    expect(state.accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
    expect(sent).toHaveLength(1);
  });

  it("moves on again when the next account runs out too", async () => {
    let resetsAt = inPast(); // marketing's window has already reset when hello runs out
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt, message: "You've hit your session limit" }),
    );
    await limitTurn(); // marketing → hello
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    resetsAt = inFuture();
    await limitTurn(); // hello runs out → back to marketing
    expect(reopened).toHaveLength(2);
    expect(notes.at(-1)).toMatchObject({ from: "hello", to: "marketing", outcome: "switched" });
  });

  it("explains in the timeline when it stops switching an agent that keeps bouncing", async () => {
    const { reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inPast(), message: "You've hit your session limit" }),
    );
    for (let turn = 0; turn < 5; turn += 1) await limitTurn();
    expect(reopened).toHaveLength(4);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/stopped switching it for now/);
  });

  it("doesn't blame the new account for the old one's limit when a message fails before its turn starts", async () => {
    // A real incident: marketing's weekly limit moved the agent to hello, then a message hit a closed
    // session. Paseo never started that turn, so the timeline still ended with marketing's notice.
    const notice = "You've hit your weekly limit · resets Sep 25 at 3:30pm (Asia/Calcutta)";
    const { service, store, reopened, notes, paseo } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => {
        throw new Error("unused: the real detector reads the turns");
      },
      { detectLimit: detectClaudeLimit },
    );
    const context = { paseo } as never;
    const agent = { id: AGENT, provider: "claude" };
    const earlier: AgentTimelineItem[] = [
      { type: "user_message", text: "fix the bug" },
      { type: "assistant_message", text: notice },
    ];
    await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: earlier } as never, context);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);

    const closed = "Claude session is closed";
    await service.onTurnEnded(
      {
        agent,
        turnId: null,
        outcome: { kind: "failed", error: { message: closed } },
        timeline: [...earlier, { type: "assistant_message", text: `[System Error] ${closed}` }],
      } as never,
      context,
    );
    expect((await store.read()).accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(reopened).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("keeps an agent's session where it was when Paseo can't reload it", async () => {
    const openedAt = "2026-09-23T07:00:00.000Z";
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "fails" },
    );
    await limitTurn();
    const state = await store.read();
    expect(reopened).toEqual([AGENT]);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // where it goes when its session next opens
    expect(state.sessions[AGENT]).toEqual({ accountId: MAIN, family: "claude", openedAt });
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "pending" });
  });

  it("keeps the new session when the reload only ran out of time", async () => {
    // The daemon may still finish a reload that the command-line tool stopped waiting for.
    const { store, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "times out" },
    );
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});

describe("turn hooks without inline history", () => {
  const cases = [
    { family: "claude" as const, detectLimit: detectClaudeLimit, detectSignOut: detectClaudeSignOut,
      limit: "You've hit your session limit", signedOut: "Not logged in · Please run /login" },
    { family: "codex" as const, detectLimit: detectCodexLimit, detectSignOut: detectCodexSignOut,
      limit: "[System Error] You’ve hit your usage limit.", signedOut: "[System Error] Your refresh token was already used. Please log out and sign in again." },
  ];

  it.each(cases)("reads a bounded sample for a completed $family limit", async ({ family, detectLimit, limit }) => {
    const id = MAIN_ACCOUNT_ID[family];
    const scenario = await setUp({ accounts: [account(id, "main", "main", family)] as never },
      () => { throw new Error("use the real detector"); }, { family, detectLimit });
    scenario.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    scenario.history.push({ type: "user_message", text: "Finish the work" }, { type: "assistant_message", text: limit });
    await scenario.service.onTurnEnded({
      agent: { id: AGENT, provider: family }, turnId: "completed-turn", outcome: { kind: "completed" }, timeline: [],
    } as never, { paseo: scenario.paseo } as never);
    expect(scenario.historyReads).toEqual([{ direction: "tail", limit: 20 }]);
    expect((await scenario.store.read()).accounts.find((entry) => entry.id === id)?.limitedUntil).not.toBeNull();
    expect(scenario.reopened).toEqual([]);
  });

  it.each(cases)("checks completed $family sign-out notices against the account identity", async ({ family, detectLimit, detectSignOut, signedOut }) => {
    const id = MAIN_ACCOUNT_ID[family];
    let identityReads = 0;
    const scenario = await setUp({ accounts: [account(id, "main", "main", family)] as never },
      () => { throw new Error("use the real detector"); }, {
        family, detectLimit, detectSignOut,
        identity: async () => {
          identityReads += 1;
          return { signedIn: false, email: null, plan: null, organization: null, identity: null };
        },
      });
    scenario.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    scenario.history.push({ type: "assistant_message", text: signedOut });
    await scenario.service.onTurnEnded({
      agent: { id: AGENT, provider: family }, turnId: "completed-turn", outcome: { kind: "completed" }, timeline: [],
    } as never, { paseo: scenario.paseo } as never);
    expect(scenario.historyReads).toEqual([{ direction: "tail", limit: 20 }]);
    expect(identityReads).toBe(1);
    expect((await scenario.store.read()).accounts.find((entry) => entry.id === id)?.signedIn).toBe(false);
    expect(scenario.reopened).toEqual([]);
  });

  it.each(cases)("uses structured $family failures without reading history", async ({ family, detectLimit, limit }) => {
    const id = MAIN_ACCOUNT_ID[family];
    const scenario = await setUp({ accounts: [account(id, "main", "main", family)] as never },
      () => { throw new Error("use the real detector"); }, { family, detectLimit });
    scenario.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    await scenario.service.onTurnEnded({
      agent: { id: AGENT, provider: family }, turnId: "failed-turn", outcome: { kind: "failed", error: { message: limit } }, timeline: [],
    } as never, { paseo: scenario.paseo } as never);
    expect(scenario.historyReads).toEqual([]);
    expect((await scenario.store.read()).accounts.find((entry) => entry.id === id)?.limitedUntil).not.toBeNull();
  });

  it.each(["failed", "canceled"] as const)("does not inspect a preceding turn after %s admission", async (kind) => {
    const scenario = await setUp({ accounts: [account(MAIN, "main", "main")] as never },
      () => { throw new Error("use the real detector"); }, { detectLimit: detectClaudeLimit });
    scenario.history.push({ type: "assistant_message", text: "You've hit your session limit" });
    const outcome = kind === "failed" ? { kind, error: { message: "Claude session is closed" } } : { kind, reason: "Stopped" };
    await scenario.service.onTurnEnded({
      agent: { id: AGENT, provider: "claude" }, turnId: null, outcome, timeline: [],
    } as never, { paseo: scenario.paseo } as never);
    expect(scenario.historyReads).toEqual([]);
    expect((await scenario.store.read()).accounts.find((entry) => entry.id === MAIN)?.limitedUntil).toBeNull();
  });
});

describe("forking to the other provider", () => {
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
    claude: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
  };

  async function setUpFork(modeId: string, sourceContext: Record<string, unknown> = {}, detectLimit?: FamilyAdapter["detectLimit"]) {
    const history: AgentTimelineItem[] = [];
    const historyReads: Array<{ direction: "tail"; limit: number }> = [];
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [account(MAIN, "marketing", "main"), { ...account(CODEX_MAIN, "hello", "main"), family: "codex" }],
        defaults: { claude: MAIN, codex: CODEX_MAIN },
      }),
    );
    const source = {
      ...sourceContext,
      id: AGENT,
      provider: "claude",
      status: "idle",
      title: "Fix the build",
      model: "claude-opus-5-5",
      currentModeId: modeId,
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels: {},
    };
    const agents: Array<Record<string, unknown>> = [source];
    const created: Array<{ agentId: string; config: { provider: string; modeId?: string }; title: string; prompt: string; labels: Record<string, string> }> = [];
    const notes: Array<{ to: string; outcome: string; toFamily: string | null; detail: string | null; continuedIn: { agentId: string } | null }> = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: {
        listAvailable: async () => ({ providers: [{ provider: "claude", available: true }, { provider: "codex", available: true }] }),
        listModes: async (provider: string) => ({ modes: MODES[provider] }),
        listModels: async (provider: string) => ({ models: [{ id: provider === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", isDefault: true }] }),
      },
      workspaces: {
        ref: () => ({
          agents: {
            create: async (request: (typeof created)[number]) => {
              created.push(request);
              agents.push({ id: request.agentId, provider: "codex", status: "running", title: request.title, archivedAt: null, labels: request.labels });
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          send: async () => undefined,
          timeline: {
            append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data),
            refetch: async (request: { direction: "tail"; limit: number }) => {
              historyReads.push(request);
              return { entries: history.slice(-request.limit).map((item) => ({ item })) };
            },
          },
        }),
      },
    };
    const service = new Service(
      {
        claude: {
          ...claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" })),
          ...(detectLimit ? { detectLimit } : {}),
        },
        codex: { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), family: "codex", portable: false } as FamilyAdapter,
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({ forkOtherProvider: true }));
    const context = { paseo } as never;
    const limitTurn = () =>
      service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
        context,
      );
    return { store, created, notes, limitTurn, history, historyReads, service, paseo };
  }

  it("carries the work on with the other provider, at the same permission level", async () => {
    const { store, created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0];
    expect(fork?.config).toEqual({ provider: "codex/gpt-5.6-sol", modeId: "full-access" });
    expect(fork?.title).toBe("Fix the build (continued on ChatGPT)");
    expect(fork?.labels).toEqual({ "zerosub.continued-from": AGENT });
    expect(fork?.prompt).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
    expect((await store.read()).bindings[fork?.agentId ?? ""]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "codex", to: "hello", continuedIn: { agentId: fork?.agentId } });
  });

  it("fetches continuation history separately from the bounded detection sample", async () => {
    const scenario = await setUpFork("bypassPermissions", {}, detectClaudeLimit);
    scenario.history.push({ type: "user_message", text: "Keep the original opening request" });
    for (let index = 0; index < 25; index += 1) {
      scenario.history.push({ type: "assistant_message", text: `Completed step ${index}` });
    }
    scenario.history.push({ type: "assistant_message", text: "You've hit your session limit" });
    await scenario.service.onTurnEnded({
      agent: { id: AGENT, provider: "claude" }, turnId: "completed-turn", outcome: { kind: "completed" }, timeline: [],
    } as never, { paseo: scenario.paseo } as never);
    expect(scenario.historyReads).toEqual([{ direction: "tail", limit: 20 }, { direction: "tail", limit: 500 }]);
    expect(scenario.created).toHaveLength(1);
    expect(scenario.created[0]?.prompt).toContain("User: Keep the original opening request");
    expect(scenario.created[0]?.prompt).toContain("Completed step 24");
  });

  it("retains a nonempty older hook timeline for detection and continuation", async () => {
    const scenario = await setUpFork("bypassPermissions", {}, detectClaudeLimit);
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Original hook history" },
      { type: "assistant_message", text: "You've hit your session limit" },
    ];
    await scenario.service.onTurnEnded({
      agent: { id: AGENT, provider: "claude" }, turnId: "completed-turn", outcome: { kind: "completed" }, timeline,
    } as never, { paseo: scenario.paseo } as never);
    expect(scenario.historyReads).toEqual([]);
    expect(scenario.created).toHaveLength(1);
    expect(scenario.created[0]?.prompt).toContain("User: Original hook history");
  });

  it("points at the earlier fork instead of starting another", async () => {
    const { created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: created[0]?.agentId } });
  });

  it("keeps concrete context limits when continuing on another provider without copying account environment", async () => {
    const contextPolicy = {
      providerWindowTokens: 1_000_000,
      clientWindowTokens: 500_000,
      outputReserveTokens: 32_000,
      thresholdTokens: 400_000,
    };
    const { created, limitTurn } = await setUpFork("bypassPermissions", {
      contextPolicy,
      profileId: "implementation",
      env: { ACCOUNT_TOKEN: "test-value" },
    });
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(created[0]?.config).toEqual({
      provider: "codex/gpt-5.6-sol",
      modeId: "full-access",
      contextPolicy,
    });
    expect(created[0]?.labels).toEqual({
      "zerosub.continued-from": AGENT,
      "zerosub.source-profile": "implementation",
    });
    expect(created[0]).not.toHaveProperty("env");
  });

  it("won't fork into a mode more permissive than the original's", async () => {
    const { created, notes, limitTurn } = await setUpFork("default");
    await limitTurn();
    expect(created).toHaveLength(0);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });
});

describe("disabling an account", () => {
  it("moves its agents off and back, and won't disable the last usable account", async () => {
    const { service, store, reopened } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: new Date().toISOString() } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
    );
    const paseo = fakePaseo().paseo as never;

    const off = await service.setAccountEnabled(paseo, HELLO, false);
    expect(off.reopened).toEqual([AGENT]);
    let state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // kept for when it's enabled again

    await expect(service.setAccountEnabled(paseo, MAIN, false)).rejects.toThrow(/only Claude account in use/);

    const on = await service.setAccountEnabled(paseo, HELLO, true);
    expect(on.reopened).toEqual([AGENT]);
    state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toHaveLength(2);
  });
});


describe("model-specific failover", () => {
  it("moves Opus onto an account exhausted only for Fable", async () => {
    const until = inFuture();
    const scenario = await setUp({
      accounts: [account(MAIN, "main", "main"), { ...account(HELLO, "hello", "managed"), modelLimits: { fable: { until, at: new Date().toISOString(), source: "notice" } } }] as never,
    }, () => ({ kind: "window", resetsAt: until, message: "session limit" }));
    await scenario.limitTurn();
    expect(scenario.reopened).toEqual([AGENT]);
    expect((await scenario.store.read()).bindings[AGENT]?.accountId).toBe(HELLO);
  });

  it("records an explicit Fable notice without globally limiting the account", async () => {
    const until = inFuture();
    const scenario = await setUp({ accounts: [account(MAIN, "main", "main")] as never },
      () => ({ kind: "window", model: "fable", resetsAt: until, message: "You've reached your Fable limit." }));
    scenario.agent.model = "claude-fable-5";
    scenario.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    await scenario.limitTurn();
    const a = (await scenario.store.read()).accounts[0]!;
    expect(a.limitedUntil).toBeNull();
    expect(a.modelLimits?.fable?.until).toBe(until);
    const view = await scenario.service.view(scenario.paseo as never);
    expect(view.accounts[0]?.status).toBe("ready");
    expect(view.accounts[0]?.modelLimits?.fable?.until).toBe(until);
    expect(view.agents[0]?.model).toBe("claude-fable-5");
  });

  it("refreshes the selected model on session resume instead of retaining the old model", async () => {
    const until = inFuture();
    const scenario = await setUp({ accounts: [
      { ...account(MAIN, "main", "main"), modelLimits: { fable: { until, at: new Date().toISOString(), source: "notice" } } },
      account(HELLO, "hello", "managed"),
    ] as never }, () => ({ kind: "window", resetsAt: until, message: "limit" }));
    const open = async () => scenario.service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "resume", purpose: "interactive", env: {} } as never, { paseo: scenario.paseo } as never);
    scenario.agent.model = "claude-opus-5-5";
    await open();
    expect((await scenario.store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    scenario.agent.model = "claude-fable-5";
    await open();
    expect((await scenario.store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});


describe("idle model peers", () => {
  it("moves idle Fable peers after a Fable limit and leaves idle Opus peers alone", async () => {
    const until = inFuture();
    const scenario = await setUp({ accounts: [account(MAIN, "main", "main"), account(HELLO, "hello", "managed")] as never },
      () => ({ kind: "window", model: "fable", resetsAt: until, message: "Fable limit" }));
    scenario.agent.model = "claude-fable-5";
    scenario.peers.push({ ...scenario.agent, id: "opus-peer", model: "claude-opus-5-5" }, { ...scenario.agent, id: "fable-peer" });
    await scenario.limitTurn();
    await vi.waitFor(async () => {
      expect((await scenario.store.read()).sessions["fable-peer"]?.accountId).toBe(HELLO);
    });
    expect(scenario.reopened).toEqual([AGENT, "fable-peer"]);
    expect((await scenario.store.read()).bindings["opus-peer"]).toBeUndefined();
  });
});


describe("unknown model on creation", () => {
  it("routes conservatively when a new agent cannot yet be refreshed", async () => {
    const until = inFuture();
    const scenario = await setUp({ accounts: [
      { ...account(MAIN, "main", "main"), modelLimits: { fable: { until, at: new Date().toISOString(), source: "notice" } } },
      account(HELLO, "hello", "managed"),
    ] as never }, () => ({ kind: "window", resetsAt: until, message: "limit" }));
    const paseo = { ...scenario.paseo, agents: { ...scenario.paseo.agents, ref: () => ({ refresh: async () => { throw new Error("agent not registered yet"); } }) } };
    await scenario.service.onSessionOpen({ agentId: "new-agent", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never, { paseo } as never);
    expect((await scenario.store.read()).sessions["new-agent"]?.accountId).toBe(HELLO);
  });
});


describe("model reset inference", () => {
  it("uses the exhausted model's reset rather than another model's later reset", async () => {
    const until = inFuture();
    const later = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const scenario = await setUp({ accounts: [account(MAIN, "main", "main")] as never },
      () => ({ kind: "window", model: "fable", resetsAt: null, message: "Fable limit" }), {
        usage: async () => ({ fetchedAt: new Date().toISOString(), cached: false, error: null, resets: null, windows: [
          { id: "weekly_fable", label: "Fable", usedPercent: 100, resetsAt: until },
          { id: "seven_day_opus", label: "Opus", usedPercent: 100, resetsAt: later },
        ] }),
      });
    scenario.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    await scenario.limitTurn();
    const a = (await scenario.store.read()).accounts[0]!;
    expect(a.modelLimits?.fable?.until).toBe(until);
    expect(a.modelLimits?.opus?.until).toBe(later);
    expect(a.limitedUntil).toBeNull();
  });

  it("does not replace a live budget limit with a rolling-window notice", async () => {
    const budgetUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const scenario = await setUp({ accounts: [{ ...account(MAIN, "main", "main"), limitedUntil: budgetUntil, limitKind: "budget" }] as never },
      () => ({ kind: "window", resetsAt: inFuture(), message: "session limit" }));
    scenario.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    await scenario.limitTurn();
    expect((await scenario.store.read()).accounts[0]?.limitedUntil).toBe(budgetUntil);
    expect((await scenario.store.read()).accounts[0]?.limitKind).toBe("budget");
  });
});
