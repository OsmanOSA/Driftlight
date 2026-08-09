import type { ObservedChange, RepositorySnapshot } from "../domain/types.js";
import { diffSnapshots, scanRepository } from "./snapshot.js";

export interface ObservationBatch {
  changes: ObservedChange[];
  snapshot: RepositorySnapshot;
}

export class PollingObserver {
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private previous: RepositorySnapshot;

  public constructor(
    private readonly root: string,
    initialSnapshot: RepositorySnapshot,
    private readonly intervalMs = 400,
  ) {
    this.previous = initialSnapshot;
  }

  public start(onChanges: (batch: ObservationBatch) => void | Promise<void>): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanOnce(onChanges);
    }, this.intervalMs);
  }

  public async scanOnce(
    onChanges?: (batch: ObservationBatch) => void | Promise<void>,
  ): Promise<ObservationBatch> {
    if (this.scanning) return { changes: [], snapshot: this.previous };
    this.scanning = true;
    try {
      const snapshot = await scanRepository(this.root);
      const changes = diffSnapshots(this.previous, snapshot);
      this.previous = snapshot;
      const batch = { changes, snapshot };
      if (changes.length > 0 && onChanges) await onChanges(batch);
      return batch;
    } finally {
      this.scanning = false;
    }
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
