import { readFileSync } from "node:fs";
import type { DriftLightConfig } from "../domain/types.js";
import { globalConfigPath, projectConfigPath } from "../shared/state-paths.js";

export const ENFORCEMENT_LEVELS = ["never", "irreversible", "always"] as const;

export const DEFAULT_CONFIG: DriftLightConfig = {
  blockOnRed: true,
  blockOnOrange: false,
  enforceRed: "irreversible",
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

function readPartialConfig(filePath: string): Partial<DriftLightConfig> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Partial<DriftLightConfig>;
  } catch {
    // Absente ou illisible : la couche suivante fait autorité. Une préférence
    // mal formée ne doit jamais empêcher le voyant de fonctionner.
    return {};
  }
}

function merge(base: DriftLightConfig, parsed: Partial<DriftLightConfig>): DriftLightConfig {
  return {
    blockOnRed: boolean(parsed.blockOnRed, base.blockOnRed),
    blockOnOrange: boolean(parsed.blockOnOrange, base.blockOnOrange),
    enforceRed: ENFORCEMENT_LEVELS.includes(parsed.enforceRed as never)
      ? parsed.enforceRed as DriftLightConfig["enforceRed"]
      : base.enforceRed,
    largeLineDeletionThreshold: typeof parsed.largeLineDeletionThreshold === "number"
      && Number.isInteger(parsed.largeLineDeletionThreshold)
      && parsed.largeLineDeletionThreshold > 0
      ? parsed.largeLineDeletionThreshold
      : base.largeLineDeletionThreshold,
    notifyOnRed: boolean(parsed.notifyOnRed, base.notifyOnRed),
    notifyOnOrange: boolean(parsed.notifyOnOrange, base.notifyOnOrange),
    notificationSound: boolean(parsed.notificationSound, base.notificationSound),
    terminalTitle: boolean(parsed.terminalTitle, base.terminalTitle),
    shadowSignalsCanAlert: boolean(parsed.shadowSignalsCanAlert, base.shadowSignalsCanAlert),
  };
}

/**
 * Trois couches, de la plus générale à la plus précise : défauts du produit,
 * préférences de la machine, puis réglages du dépôt. Une installation unique
 * se règle donc une fois, sans empêcher un projet particulier de diverger.
 */
export function loadConfigSync(root: string): DriftLightConfig {
  const global = merge(DEFAULT_CONFIG, readPartialConfig(globalConfigPath()));
  return merge(global, readPartialConfig(projectConfigPath(root)));
}
