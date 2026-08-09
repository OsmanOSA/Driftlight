import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoringConfig } from "../domain/types.js";

const REQUIRED_WEIGHTS: Array<keyof ScoringConfig["weights"]> = [
  "importDistance",
  "fileRarity",
  "anchorCooccurrence",
];

const REQUIRED_BEHAVIOR_SIGNALS = [
  "sensitive-file",
  "destructive-edit",
  "write-without-read",
  "dependency-added",
  "full-file-reformat",
  "destructive-git-command",
  "destructive-file-command",
  "dependency-command",
  "infrastructure-command",
] as const;

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
  const minimumGraphFiles = finiteNumber(value.signalParameters.minimumGraphFiles, "signalParameters.minimumGraphFiles");
  if (!Number.isInteger(minimumGraphFiles) || minimumGraphFiles < 1) {
    throw new Error("Configuration invalide : signalParameters.minimumGraphFiles doit être un entier positif.");
  }
  for (const key of ["minimumModificationCommits", "minimumCooccurrenceCommits"] as const) {
    const minimum = finiteNumber(value.signalParameters[key], `signalParameters.${key}`);
    if (!Number.isInteger(minimum) || minimum < 1) {
      throw new Error(`Configuration invalide : signalParameters.${key} doit être un entier positif.`);
    }
  }
  const scoreScale = finiteNumber(value.scoreScale, "scoreScale");
  const minimumScore = finiteNumber(value.minimumScore, "minimumScore");
  const maximumScore = finiteNumber(value.maximumScore, "maximumScore");
  const positiveWeightTotal = REQUIRED_WEIGHTS
    .map((key) => weights[key])
    .filter((weight): weight is number => typeof weight === "number" && weight > 0)
    .reduce((sum, weight) => sum + weight, 0);
  if (positiveWeightTotal <= 0) throw new Error("Configuration de score invalide : au moins un poids shadow doit être positif.");
  if (minimumScore >= orange || red > maximumScore || minimumScore >= maximumScore) {
    throw new Error("Configuration de score invalide : seuils hors des bornes du score.");
  }
  // Étage 2 : sévérités, familles et table ordonnée sont configurables, donc validées.
  if (
    !isRecord(value.behavior)
    || !isRecord(value.behavior.severities)
    || !isRecord(value.behavior.severityWeights)
    || !isRecord(value.behavior.signalFamilies)
    || !Array.isArray(value.behavior.decisionTable)
  ) {
    throw new Error(`Configuration de comportement absente : ${source}`);
  }
  for (const [id, severity] of Object.entries(value.behavior.severities)) {
    if (severity !== "GREEN" && severity !== "ORANGE" && severity !== "RED") {
      throw new Error(`Sévérité de comportement invalide pour ${id} : ${String(severity)}`);
    }
  }
  for (const severity of ["GREEN", "ORANGE", "RED"] as const) {
    finiteNumber(value.behavior.severityWeights[severity], `behavior.severityWeights.${severity}`);
  }
  for (const id of REQUIRED_BEHAVIOR_SIGNALS) {
    if (!(id in value.behavior.severities)) {
      throw new Error(`Configuration de comportement incomplète : behavior.severities.${id}`);
    }
    const family = value.behavior.signalFamilies[id];
    if (typeof family !== "string" || family.trim().length === 0) {
      throw new Error(`Configuration de comportement incomplète : behavior.signalFamilies.${id}`);
    }
  }
  const families = new Set<string>();
  for (const [id, family] of Object.entries(value.behavior.signalFamilies)) {
    if (typeof family !== "string" || family.trim().length === 0) {
      throw new Error(`Famille de comportement invalide pour ${id}.`);
    }
    families.add(family);
  }
  if (value.behavior.decisionTable.length === 0) {
    throw new Error("Configuration invalide : behavior.decisionTable ne peut pas être vide.");
  }
  const decisionIds = new Set<string>();
  let redCatchAllIndex = -1;
  let orangeCatchAllIndex = -1;
  for (const [index, candidate] of value.behavior.decisionTable.entries()) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.trim().length === 0 || !isRecord(candidate.when)) {
      throw new Error(`Règle de décision comportementale invalide à l'index ${index}.`);
    }
    if (decisionIds.has(candidate.id)) throw new Error(`Règle de décision dupliquée : ${candidate.id}.`);
    decisionIds.add(candidate.id);
    if (candidate.verdict !== "ORANGE" && candidate.verdict !== "RED") {
      throw new Error(`Verdict de décision invalide pour ${candidate.id}.`);
    }
    const minimumSeverity = candidate.when.minimumSignalSeverity;
    if (minimumSeverity !== "ORANGE" && minimumSeverity !== "RED") {
      throw new Error(`Sévérité minimale invalide pour ${candidate.id}.`);
    }
    const minimumFamilies = finiteNumber(
      candidate.when.minimumDistinctFamilies,
      `behavior.decisionTable.${index}.when.minimumDistinctFamilies`,
    );
    if (!Number.isInteger(minimumFamilies) || minimumFamilies < 1) {
      throw new Error(`Nombre de familles invalide pour ${candidate.id}.`);
    }
    const required = candidate.when.requiredFamilies;
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((family) => typeof family === "string" && families.has(family))) {
        throw new Error(`Famille requise inconnue pour ${candidate.id}.`);
      }
    }
    const catchAll = minimumFamilies === 1 && (required === undefined || required.length === 0);
    if (catchAll && candidate.verdict === "RED" && minimumSeverity === "RED" && redCatchAllIndex < 0) {
      redCatchAllIndex = index;
    }
    if (catchAll && candidate.verdict === "ORANGE" && minimumSeverity === "ORANGE" && orangeCatchAllIndex < 0) {
      orangeCatchAllIndex = index;
    }
  }
  if (redCatchAllIndex < 0 || orangeCatchAllIndex < 0 || redCatchAllIndex > orangeCatchAllIndex) {
    throw new Error("Configuration invalide : la table doit traiter tout signal RED avant tout signal ORANGE.");
  }
  if (value.behavior.decisionTable.slice(0, redCatchAllIndex).some((rule) => rule.verdict !== "RED")) {
    throw new Error("Configuration invalide : aucune décision ORANGE ne peut précéder la garantie RED.");
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
