import { readFileSync } from "node:fs";
import path from "node:path";
import type { CurrentStatus, SessionEvent, Severity } from "../domain/types.js";
import { projectStateDirectory, projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomic, writeJsonAtomicSync } from "../shared/atomic-write.js";
import { readJsonStateSync } from "../shared/read-state.js";

const ORDER: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };

function emptyStatus(acknowledgedAt: string | null = null): CurrentStatus {
  return {
    schemaVersion: 1,
    level: "GREEN",
    counts: { GREEN: 0, ORANGE: 0, RED: 0 },
    lastEventAt: null,
    acknowledgedAt,
  };
}

export function currentStatusPath(root: string): string {
  return projectStatePath(root, "current-status.json");
}

export function readCurrentStatusSync(root: string): CurrentStatus {
  return readJsonStateSync<CurrentStatus>(currentStatusPath(root)) ?? emptyStatus();
}

function saveStatusSync(root: string, status: CurrentStatus): void {
  writeJsonAtomicSync(currentStatusPath(root), status);
}

export function recordCurrentStatus(root: string, events: SessionEvent[]): CurrentStatus {
  const status = readCurrentStatusSync(root);
  for (const event of events) {
    if (event.type === "lifecycle") continue;
    status.counts[event.level] += 1;
    if (ORDER[event.level] > ORDER[status.level]) status.level = event.level;
    status.lastEventAt = event.timestamp;
  }
  if (events.some((event) => event.type !== "lifecycle")) saveStatusSync(root, status);
  return status;
}

export async function acknowledgeCurrentStatus(root: string): Promise<CurrentStatus> {
  const status = emptyStatus(new Date().toISOString());
  await writeJsonAtomic(currentStatusPath(root), status);
  return status;
}
