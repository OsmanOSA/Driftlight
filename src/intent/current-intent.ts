import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CurrentIntentState } from "../domain/types.js";

export function currentIntentPath(root: string): string {
  return path.join(root, ".driftlight", "current-intent.json");
}

export function readCurrentIntentSync(root: string): CurrentIntentState | null {
  try {
    return JSON.parse(readFileSync(currentIntentPath(root), "utf8")) as CurrentIntentState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveCurrentIntent(root: string, state: CurrentIntentState): Promise<CurrentIntentState> {
  const target = currentIntentPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return state;
}

export async function writeCurrentIntent(
  root: string,
  text: string,
  options: { turnId?: string; resetScope?: boolean } = {},
): Promise<CurrentIntentState> {
  const previous = readCurrentIntentSync(root);
  return await saveCurrentIntent(root, {
    schemaVersion: 1,
    version: (previous?.version ?? 0) + 1,
    turnId: options.turnId ?? `turn-${Date.now()}-${randomUUID().slice(0, 8)}`,
    text: text.trim(),
    scopeAdditions: options.resetScope ? [] : previous?.scopeAdditions ?? [],
    updatedAt: new Date().toISOString(),
  });
}

export async function addCurrentScope(root: string, text: string): Promise<CurrentIntentState> {
  const previous = readCurrentIntentSync(root) ?? {
    schemaVersion: 1 as const,
    version: 0,
    turnId: `turn-${Date.now()}-${randomUUID().slice(0, 8)}`,
    text: "",
    scopeAdditions: [],
    updatedAt: new Date().toISOString(),
  };
  const addition = text.trim();
  const additions = addition && !previous.scopeAdditions.includes(addition)
    ? [...previous.scopeAdditions, addition]
    : previous.scopeAdditions;
  return await saveCurrentIntent(root, {
    ...previous,
    version: previous.version + 1,
    scopeAdditions: additions,
    updatedAt: new Date().toISOString(),
  });
}
