import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths";

const HINT_KEY = /^[A-Za-z0-9-]{1,120}$/;
const MAX_MODEL_LENGTH = 100;

/** Where a dispatcher leaves the model of an agent it is about to create, one file per hint key. */
export function modelHintsDir(): string {
  return join(dataDir(), "model-hints");
}

/**
 * A dispatcher that chooses the agent's title but not its ID files the hint under the title, with
 * every character outside letters, digits and hyphens replaced by a hyphen.
 */
export function titleHintKey(title: string | null | undefined): string | null {
  const key = title?.replace(/[^A-Za-z0-9-]/g, "-") ?? "";
  return HINT_KEY.test(key) ? key : null;
}

/**
 * The model a dispatcher recorded for an agent before creating it. Paseo does not report a new
 * agent's model when its first session opens, so without this hint routing cannot tell an Opus
 * worker from a Fable one. A missing, unreadable or oversized hint is no hint.
 */
export async function readModelHint(key: string, directory: string = modelHintsDir()): Promise<string | null> {
  if (!HINT_KEY.test(key)) return null;
  try {
    const model = (await readFile(join(directory, key), "utf8")).trim();
    return model.length > 0 && model.length <= MAX_MODEL_LENGTH ? model : null;
  } catch {
    return null;
  }
}
