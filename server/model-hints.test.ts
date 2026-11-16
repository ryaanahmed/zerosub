import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readModelHint, titleHintKey } from "./model-hints";

describe("readModelHint", () => {
  it("returns the recorded model for the agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zerosub-hints-"));
    await writeFile(join(directory, "agent-1"), "claude-opus-5-5\n");
    expect(await readModelHint("agent-1", directory)).toBe("claude-opus-5-5");
  });

  it("returns nothing for a missing hint or an agent ID that is not a plain identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zerosub-hints-"));
    expect(await readModelHint("agent-2", directory)).toBeNull();
    expect(await readModelHint("../state.json", directory)).toBeNull();
  });

  it("finds a hint filed under the agent's title", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zerosub-hints-"));
    await writeFile(join(directory, "sa-worker-0a1b"), "claude-opus-5-5\n");
    expect(titleHintKey("sa-worker:0a1b")).toBe("sa-worker-0a1b");
    expect(await readModelHint(titleHintKey("sa-worker:0a1b") ?? "", directory)).toBe("claude-opus-5-5");
    expect(titleHintKey(null)).toBeNull();
  });
});
