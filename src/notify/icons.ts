import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Severity } from "../domain/types.js";

/**
 * Pastille de sévérité affichée par le système à côté du texte.
 *
 * Elle est délibérément facultative : un chemin d'image invalide empêche
 * SnoreToast d'afficher le toast, et perdre l'alerte coûterait infiniment plus
 * cher que de la montrer sans couleur. L'absence d'asset n'est donc pas une
 * erreur, seulement une notification plus sobre.
 */

const FILES: Partial<Record<Severity, string>> = {
  RED: "driftlight-red.png",
  ORANGE: "driftlight-orange.png",
};

const cache = new Map<Severity, string | undefined>();

function candidates(fileName: string): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDirectory, "../../../assets", fileName),
    path.resolve(moduleDirectory, "../../assets", fileName),
  ];
}

export function severityIconPath(level: Severity): string | undefined {
  if (cache.has(level)) return cache.get(level);
  const fileName = FILES[level];
  const resolved = fileName === undefined
    ? undefined
    : candidates(fileName).find((candidate) => existsSync(candidate));
  cache.set(level, resolved);
  return resolved;
}
