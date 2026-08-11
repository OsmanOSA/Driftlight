import { readFileSync } from "node:fs";
import path from "node:path";
import type { AlertFeedback, SessionEvent } from "../domain/types.js";
import { projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomicSync } from "../shared/atomic-write.js";

interface Counts { noise: number; useful: number }

export interface FeedbackStats {
  schemaVersion: 1;
  updatedAt: string;
  totals: Counts;
  byStage: Record<string, Counts>;
  bySignal: Record<string, Counts>;
}

function counts(): Counts {
  return { noise: 0, useful: 0 };
}

function empty(): FeedbackStats {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), totals: counts(), byStage: {}, bySignal: {} };
}

export function feedbackStatsPath(root: string): string {
  return projectStatePath(root, "feedback-stats.json");
}

export function readFeedbackStats(root: string): FeedbackStats {
  try {
    const parsed = JSON.parse(readFileSync(feedbackStatsPath(root), "utf8")) as FeedbackStats;
    return parsed.schemaVersion === 1 ? parsed : empty();
  } catch {
    return empty();
  }
}

function adjust(target: Counts, feedback: AlertFeedback, amount: 1 | -1): void {
  target[feedback] = Math.max(0, target[feedback] + amount);
}

/** Agrège le feedback de l'étage 2 entre les sessions, entièrement en local. */
export function recordFeedbackStats(
  root: string,
  event: SessionEvent,
  previous: AlertFeedback | undefined,
  next: AlertFeedback,
): void {
  try {
    const state = readFeedbackStats(root);
    const stage = event.stage ?? "legacy";
    const signals = event.codes.length > 0 ? event.codes : [event.ruleId];
    const stageCounts = state.byStage[stage] ??= counts();
    const signalCounts = signals.map((id) => state.bySignal[id] ??= counts());
    if (previous) {
      adjust(state.totals, previous, -1);
      adjust(stageCounts, previous, -1);
      for (const item of signalCounts) adjust(item, previous, -1);
    }
    adjust(state.totals, next, 1);
    adjust(stageCounts, next, 1);
    for (const item of signalCounts) adjust(item, next, 1);
    state.updatedAt = new Date().toISOString();
    writeJsonAtomicSync(feedbackStatsPath(root), state);
  } catch {
    // Le feedback reste sur l'événement même si l'agrégat est indisponible.
  }
}
