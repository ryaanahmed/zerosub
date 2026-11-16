import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths";

const AGENT_ID = /^[A-Za-z0-9-]{1,80}$/;
const MAX_MODEL_LENGTH = 100;

/** Where a dispatcher leaves the model of an agent it is about to create, one file per agent ID. */
export function modelHintsDir(): string {
  return join(dataDir(), "model-hints");
}

/**
 * The model a dispatcher recorded for an agent before creating it. Paseo does not report a new
 * agent's model when its first session opens, so without this hint routing cannot tell an Opus
 * worker from a Fable one. A missing, unreadable or oversized hint is no hint.
 */
export async function readModelHint(agentId: string, directory: string = modelHintsDir()): Promise<string | null> {
  if (!AGENT_ID.test(agentId)) return null;
  try {
    const model = (await readFile(join(directory, agentId), "utf8")).trim();
    return model.length > 0 && model.length <= MAX_MODEL_LENGTH ? model : null;
  } catch {
    return null;
  }
}
