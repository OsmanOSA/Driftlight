import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScopeLightEvent } from "../adapters/types.js";
import { projectStatePath } from "../shared/state-paths.js";
import { writeFileAtomic } from "../shared/atomic-write.js";

export interface ScopeLightEventSink {
  publish(event: ScopeLightEvent): Promise<void>;
}

/**
 * IPC local minimal : un message JSON atomique par événement dans le workspace.
 * Aucun port réseau n'est ouvert et le Core peut réconcilier ces messages avec
 * son observation Git/filesystem lorsqu'il est disponible.
 */
export class LocalEventInbox implements ScopeLightEventSink {
  public async publish(event: ScopeLightEvent): Promise<void> {
    const directory = projectStatePath(event.workspace, "inbox", event.agent);
    await fs.mkdir(directory, { recursive: true });
    const identifier = `${Date.now()}-${randomUUID()}`;
    const target = path.join(directory, `${identifier}.json`);
    await writeFileAtomic(target, `${JSON.stringify(event)}
`);
  }
}
