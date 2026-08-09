import type { ScopeLightEvent } from "../adapters/types.js";
import { LocalEventInbox, type ScopeLightEventSink } from "./local-event-inbox.js";
import { NormalizedEventProcessor } from "./normalized-event-processor.js";

/**
 * Remet d'abord l'événement au pipeline Core, puis conserve une enveloppe
 * normalisée minimale pour le diagnostic et la réconciliation locale.
 */
export class LocalCoreEventSink implements ScopeLightEventSink {
  public constructor(
    private readonly processor = new NormalizedEventProcessor(),
    private readonly inbox: ScopeLightEventSink = new LocalEventInbox(),
  ) {}

  public async publish(event: ScopeLightEvent): Promise<void> {
    await this.processor.process(event);
    try {
      await this.inbox.publish(event);
    } catch {
      // L'archive est secondaire : le verdict Core a déjà été enregistré.
    }
  }
}
