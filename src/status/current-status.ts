import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CurrentStatus, SessionEvent, Severity } from "../domain/types.js";

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
  return path.join(root, ".driftlight", "current-status.json");
}

export function readCurrentStatusSync(root: string): CurrentStatus {
  try {
    return JSON.parse(readFileSync(currentStatusPath(root), "utf8")) as CurrentStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStatus();
    throw error;
  }
}

function saveStatusSync(root: string, status: CurrentStatus): void {
  const directory = path.join(root, ".driftlight");
  const target = currentStatusPath(root);
  mkdirSync(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
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
  await fs.mkdir(path.dirname(currentStatusPath(root)), { recursive: true });
  const temporary = `${currentStatusPath(root)}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await fs.rename(temporary, currentStatusPath(root));
  return status;
}
