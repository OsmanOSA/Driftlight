import { readFileSync } from "node:fs";
import path from "node:path";
import type { DriftLightConfig } from "../domain/types.js";

export const DEFAULT_CONFIG: DriftLightConfig = {
  blockOnRed: true,
  blockOnOrange: false,
  largeLineDeletionThreshold: 50,
  notifyOnRed: true,
  notifyOnOrange: false,
  notificationSound: true,
  terminalTitle: true,
  shadowSignalsCanAlert: false,
};

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadConfigSync(root: string): DriftLightConfig {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, ".driftlight", "config.json"), "utf8")) as Partial<DriftLightConfig>;
    return {
      blockOnRed: boolean(parsed.blockOnRed, DEFAULT_CONFIG.blockOnRed),
      blockOnOrange: boolean(parsed.blockOnOrange, DEFAULT_CONFIG.blockOnOrange),
      largeLineDeletionThreshold: typeof parsed.largeLineDeletionThreshold === "number"
        && Number.isInteger(parsed.largeLineDeletionThreshold)
        && parsed.largeLineDeletionThreshold > 0
        ? parsed.largeLineDeletionThreshold
        : DEFAULT_CONFIG.largeLineDeletionThreshold,
      notifyOnRed: boolean(parsed.notifyOnRed, DEFAULT_CONFIG.notifyOnRed),
      notifyOnOrange: boolean(parsed.notifyOnOrange, DEFAULT_CONFIG.notifyOnOrange),
      notificationSound: boolean(parsed.notificationSound, DEFAULT_CONFIG.notificationSound),
      terminalTitle: boolean(parsed.terminalTitle, DEFAULT_CONFIG.terminalTitle),
      shadowSignalsCanAlert: boolean(parsed.shadowSignalsCanAlert, DEFAULT_CONFIG.shadowSignalsCanAlert),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }
}
