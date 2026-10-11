import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { Reopener } from "./reopen";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: vi.fn(), constants: { R_OK: 4, X_OK: 1 } }));
vi.mock("./paths", () => ({ paseoHome: () => "test-home" }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const launcher = join("test tools", "Paseo", "paseo.cmd");
const entry = join(dirname(launcher), "node_modules", "@getpaseo", "cli", "bin", "paseo");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    args[3](null, "{}", "");
    return {} as any;
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

function reopenerFor(os: string, path: string): Reopener {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  const reopener = new Reopener();
  vi.spyOn(reopener, "locate").mockResolvedValue(path);
  return reopener;
}

describe("provider session reload", () => {
  it("runs a Windows npm launcher through Node with separate arguments", async () => {
    const result = await reopenerFor("win32", launcher).reopen("agent-id");
    expect(result).toEqual({ ok: true });
    expect(access).toHaveBeenCalledWith(entry, 4);
    expect(execFile).toHaveBeenCalledWith(process.execPath,
      [entry, "agent", "reload", "agent-id", "--json", "--home", "test-home"],
      expect.objectContaining({ timeout: 90_000 }), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls[0]?.[2]).not.toHaveProperty("shell");
  });

  it("refuses a missing npm entry point without invoking the batch file", async () => {
    vi.mocked(access).mockRejectedValue(new Error("missing"));
    expect(await reopenerFor("win32", launcher).reopen("agent-id")).toEqual({
      ok: false,
      error: "The Windows Paseo npm CLI entry point was not found beside its launcher.",
      timedOut: false,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([["darwin", "/Applications/Paseo.app/Contents/Resources/bin/paseo"], ["linux", "/usr/bin/paseo"], ["win32", "paseo.exe"]])("keeps a directly executable %s launcher", async (os, path) => {
    expect(await reopenerFor(os, path).reopen("agent-id")).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledWith(path,
      ["agent", "reload", "agent-id", "--json", "--home", "test-home"],
      expect.any(Object), expect.any(Function));
    expect(access).not.toHaveBeenCalled();
  });

  it("retains uncertainty when a reload times out", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args[3](Object.assign(new Error("timed out"), { killed: true }), "", "");
      return {} as any;
    });
    expect(await reopenerFor("win32", launcher).reopen("agent-id")).toEqual({ ok: false, error: "timed out", timedOut: true });
  });
});
