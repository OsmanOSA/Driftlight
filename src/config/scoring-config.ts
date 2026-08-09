import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoringConfig } from "../domain/types.js";

const REQUIRED_WEIGHTS: Array<keyof ScoringConfig["weights"]> = [
  "importDistance",
  "fileRarity",
  "anchorCooccurrence",
  "deletedLines",
  "turnFileCount",
  "sensitiveFile",
  "explicitIntent",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Configuration de score invalide : ${label} doit être un nombre fini.`);
  }
  return value;
}

function validateScoringConfig(value: unknown, source: string): ScoringConfig {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== "string") {
    throw new Error(`Configuration de score invalide : ${source}`);
  }
  if (!isRecord(value.thresholds) || !isRecord(value.weights) || !isRecord(value.signalParameters)) {
    throw new Error(`Configuration de score incomplète : ${source}`);
  }
  const weights = value.weights as Record<string, unknown>;
  const graphRisk = value.signalParameters.graphDistanceRisk;
  if (!isRecord(graphRisk) || !Array.isArray(value.secretPathPatterns) || !value.secretPathPatterns.every((item) => typeof item === "string")) {
    throw new Error(`Paramètres de signaux invalides : ${source}`);
  }
  for (const key of REQUIRED_WEIGHTS) finiteNumber(weights[key], `weights.${key}`);
  const orange = finiteNumber(value.thresholds.orange, "thresholds.orange");
  const red = finiteNumber(value.thresholds.red, "thresholds.red");
  if (orange >= red) throw new Error("Configuration de score invalide : le seuil orange doit être inférieur au rouge.");
  for (const key of ["distance0", "distance1", "distance2", "distance3", "perAdditionalHop", "disconnected"]) {
    finiteNumber(graphRisk[key], `signalParameters.graphDistanceRisk.${key}`);
  }
  finiteNumber(value.signalParameters.deletedLinesSaturation, "signalParameters.deletedLinesSaturation");
  finiteNumber(value.signalParameters.turnFileCountSaturation, "signalParameters.turnFileCountSaturation");
  const scoreScale = finiteNumber(value.scoreScale, "scoreScale");
  const minimumScore = finiteNumber(value.minimumScore, "minimumScore");
  const maximumScore = finiteNumber(value.maximumScore, "maximumScore");
  const positiveWeightTotal = REQUIRED_WEIGHTS
    .map((key) => weights[key])
    .filter((weight): weight is number => typeof weight === "number" && weight > 0)
    .reduce((sum, weight) => sum + weight, 0);
  if (finiteNumber(weights.explicitIntent, "weights.explicitIntent") > -scoreScale || positiveWeightTotal <= 0) {
    throw new Error("Configuration de score invalide : explicitIntent doit garantir un score nul pour un fichier nommé.");
  }
  if (minimumScore >= orange || red > maximumScore || minimumScore >= maximumScore) {
    throw new Error("Configuration de score invalide : seuils hors des bornes du score.");
  }
  return value as unknown as ScoringConfig;
}

export function scoringConfigPath(root: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(root, "driftlight.scoring.json"),
    path.resolve(moduleDirectory, "../../../driftlight.scoring.json"),
    path.resolve(moduleDirectory, "../../driftlight.scoring.json"),
  ];
  const resolved = candidates.find((candidate, index) =>
    candidates.indexOf(candidate) === index && existsSync(candidate),
  );
  if (!resolved) throw new Error("driftlight.scoring.json est introuvable.");
  return resolved;
}

export function loadScoringConfigSync(root: string): ScoringConfig {
  const source = scoringConfigPath(root);
  return validateScoringConfig(JSON.parse(readFileSync(source, "utf8")) as unknown, source);
}
