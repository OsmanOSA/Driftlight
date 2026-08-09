import type { ScopeLightAdapter } from "../types.js";
import type { ScopeLightEventSink } from "../../core/local-event-inbox.js";
import { LocalCoreEventSink } from "../../core/local-core-event-sink.js";
import { CodexAdapter } from "./adapter.js";

export interface HookBridgeResult {
  exitCode: 0;
  stdout: string;
  delivered: number;
}

export interface HookBridgeDependencies {
  adapter?: ScopeLightAdapter;
  sink?: ScopeLightEventSink;
  onDelivered?: () => Promise<void>;
  debugLog?: (message: string) => void;
}

function requiredSuccessOutput(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const event = (value as Record<string, unknown>).hook_event_name;
  // La documentation Codex exige une sortie JSON pour ces deux hooks à exit 0.
  return event === "Stop" || event === "SubagentStop" ? "{}" : "";
}

/** Le bridge est toujours fail-open : toute branche retourne exitCode 0. */
export async function runCodexHookBridge(
  rawInput: string,
  dependencies: HookBridgeDependencies = {},
): Promise<HookBridgeResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    dependencies.debugLog?.("DriftLight Codex hook: invalid JSON ignored.");
    return { exitCode: 0, stdout: "", delivered: 0 };
  }

  const stdout = requiredSuccessOutput(parsed);
  try {
    const concreteAdapter = dependencies.adapter ?? new CodexAdapter();
    const sink = dependencies.sink ?? new LocalCoreEventSink();
    const events = concreteAdapter.normalize(parsed);
    for (const event of events) {
      // La valeur de retour du Core est volontairement ignorée. Les hooks
      // DriftLight observent ; la politique d'approbation native de Codex est
      // seule responsable d'afficher Autoriser / Refuser.
      await sink.publish(event);
    }
    if (events.length > 0) {
      if (dependencies.onDelivered) {
        await dependencies.onDelivered();
      } else if (concreteAdapter instanceof CodexAdapter) {
        await concreteAdapter.recordEventReceived();
      }
    }
    return { exitCode: 0, stdout, delivered: events.length };
  } catch {
    dependencies.debugLog?.("DriftLight Codex hook: local Core unavailable; event ignored.");
    return { exitCode: 0, stdout, delivered: 0 };
  }
}
