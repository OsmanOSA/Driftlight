import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScopeLightEvent } from "../adapters/types.js";

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
    const directory = path.join(event.workspace, ".driftlight", "inbox", event.agent);
    await fs.mkdir(directory, { recursive: true });
    const identifier = `${Date.now()}-${randomUUID()}`;
    const target = path.join(directory, `${identifier}.json`);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(event)}\n`, "utf8");
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
