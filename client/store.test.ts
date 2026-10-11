import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { StateView } from "../shared/model";
import { getState, setAgentAccount } from "../shared/rpc";
import { createZeroSubStore } from "./store";

const state: StateView = {
  accounts: [], agents: [], logins: [], providers: {}, canReopen: true,
  browserSignIn: true, showComposerPill: true, warnings: [],
};

afterEach(() => vi.useRealTimers());

function storeWith(rpc: ReturnType<typeof vi.fn>) {
  return createZeroSubStore({ rpc } as unknown as PluginClientContext);
}

describe("account store", () => {
  it("publishes state and stops polling when disposed", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn().mockResolvedValue(state);
    const store = storeWith(rpc);
    const listener = vi.fn();
    store.subscribe(listener);
    store.start();
    await store.refresh();
    expect(store.current).toEqual({ state, error: null });
    expect(store.getSnapshot()).toBe(store.current);
    expect(listener).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rpc).toHaveBeenCalledTimes(2);
    store.stop();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps the newer result when a forced usage refresh overtakes a poll", async () => {
    let finishOld!: (value: StateView) => void;
    const newer = { ...state, warnings: ["new reading"] };
    const rpc = vi.fn()
      .mockReturnValueOnce(new Promise<StateView>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(newer);
    const store = storeWith(rpc);
    const old = store.refresh();
    await store.refresh({ refreshUsage: true });
    finishOld(state);
    await old;
    expect(store.current.state).toBe(newer);
    store.stop();
  });

  it("fetches fresh state after a mutation even if an earlier poll is pending", async () => {
    let finishPoll!: (value: StateView) => void;
    const rpc = vi.fn()
      .mockReturnValueOnce(new Promise<StateView>((resolve) => { finishPoll = resolve; }))
      .mockResolvedValueOnce({ reopened: [], deferred: [], failed: [], continuedIn: null })
      .mockResolvedValue(state);
    const store = storeWith(rpc);
    const poll = store.refresh();
    await store.rpc(setAgentAccount, { agentId: "test-agent", accountId: null });
    expect(rpc).toHaveBeenCalledTimes(2);
    finishPoll(state);
    await poll;
    await store.refresh();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2]?.[0]).toBe(getState);
    store.stop();
  });
});

const require = createRequire(import.meta.url);
const hermes = join(dirname(require.resolve("react-native/package.json")), "sdks", "hermesc", "osx-bin", "hermes");

// React Native ships the Mac Hermes interpreter; other hosts still run the store behavior tests.
it.skipIf(process.platform !== "darwin" || !existsSync(hermes))("constructs and starts the store inside Hermes source evaluation", () => {
  const directory = mkdtempSync(join(tmpdir(), "zerosub-hermes-"));
  try {
    const source = readFileSync(fileURLToPath(new URL("./store.ts", import.meta.url)), "utf8");
    // Lower async functions while retaining any classes, as Paseo's client compiler does.
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const factory = `(function(require) { var exports = {}; ${compiled}\nreturn exports; })`;
    const script = `
      function setTimeout() { return 1; }
      function clearTimeout() {}
      function require(name) {
        if (name === "react") return {};
        if (name === "../shared/rpc") return { getState: { name: "zerosub.state" } };
        throw new Error("Unexpected module: " + name);
      }
      var evaluate = eval;
      var exports = evaluate(${JSON.stringify(factory)})(require);
      var store = exports.createZeroSubStore({ rpc: function() { return Promise.resolve(${JSON.stringify(state)}); } });
      store.start();
      store.stop();
      print("store activated and disposed");
    `;
    const path = join(directory, "load.js");
    writeFileSync(path, script);
    expect(execFileSync(hermes, ["-Xes6-class", path], { encoding: "utf8", timeout: 5_000 })).toContain("store activated and disposed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
