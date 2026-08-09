import path from "node:path";
import type {
  ClassificationInput,
  CurrentIntentState,
  ImportGraph,
  RepoProfile,
  ScoreBreakdown,
  ScoreRawValue,
  ScoreSignalBreakdown,
  ScoringConfig,
  Severity,
} from "../domain/types.js";
import { cooccurrenceKey, sensitivitySourcesForPath } from "../profile/repo-profile.js";
import { toPosixPath } from "../shared/paths.js";
import { pathExplicitlyExpected } from "./rules.js";

interface RawSignal {
  id: keyof ScoringConfig["weights"];
  available: boolean;
  rawValue: ScoreRawValue;
  normalizedValue: number | null;
  explanation: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function resolveIntentAnchors(intent: CurrentIntentState | null, graph: ImportGraph | null): string[] {
  if (!intent || !graph) return [];
  const text = [intent.text, ...intent.scopeAdditions].join(" ").toLowerCase().replaceAll("\\", "/");
  return graph.nodes.filter((filePath) => {
    const normalized = filePath.toLowerCase();
    const basename = path.posix.basename(normalized);
    return text.includes(normalized) || (basename.length >= 4 && text.includes(basename));
  });
}

export function importDistance(graph: ImportGraph, anchors: string[], target: string): number | "disconnected" {
  if (anchors.includes(target)) return 0;
  const neighbors = new Map<string, Set<string>>();
  for (const node of graph.nodes) neighbors.set(node, new Set());
  for (const [source, targets] of Object.entries(graph.edges)) {
    const sourceNeighbors = neighbors.get(source) ?? new Set<string>();
    neighbors.set(source, sourceNeighbors);
    for (const dependency of targets) {
      sourceNeighbors.add(dependency);
      const dependencyNeighbors = neighbors.get(dependency) ?? new Set<string>();
      dependencyNeighbors.add(source);
      neighbors.set(dependency, dependencyNeighbors);
    }
  }
  if (!neighbors.has(target)) return "disconnected";
  const queue = anchors.filter((anchor) => neighbors.has(anchor)).map((anchor) => ({ node: anchor, distance: 0 }));
  const visited = new Set(queue.map((item) => item.node));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const neighbor of neighbors.get(current.node) ?? []) {
      if (visited.has(neighbor)) continue;
      const distance = current.distance + 1;
      if (neighbor === target) return distance;
      visited.add(neighbor);
      queue.push({ node: neighbor, distance });
    }
  }
  return "disconnected";
}

function graphRisk(distance: number | "disconnected", config: ScoringConfig): number {
  const risk = config.signalParameters.graphDistanceRisk;
  if (distance === "disconnected") return risk.disconnected;
  if (distance === 0) return risk.distance0;
  if (distance === 1) return risk.distance1;
  if (distance === 2) return risk.distance2;
  return clamp(risk.distance3 + Math.max(0, distance - 3) * risk.perAdditionalHop, 0, 1);
}

function deletedLineCount(input: ClassificationInput): number {
  if (input.change.kind === "deleted") return input.change.before?.lineCount ?? 0;
  return Math.max(
    0,
    input.operation?.deletedLineCount
      ?? ((input.change.before?.lineCount ?? 0) - (input.change.after?.lineCount ?? input.change.before?.lineCount ?? 0)),
  );
}

function rawSignals(
  input: ClassificationInput,
  intent: CurrentIntentState | null,
  profile: RepoProfile | null,
  graph: ImportGraph | null,
  config: ScoringConfig,
): RawSignal[] {
  const filePath = toPosixPath(input.change.path);
  const anchors = resolveIntentAnchors(intent, graph);
  const explicit = pathExplicitlyExpected(intent?.text ?? "", intent?.scopeAdditions ?? [], filePath);
  const distanceAvailable = Boolean(graph && anchors.length > 0);
  const distance = distanceAvailable && graph ? importDistance(graph, anchors, filePath) : null;
  const rateAvailable = profile?.modificationRates.available ?? false;
  const modificationRate = rateAvailable ? profile?.modificationRates.rates[filePath] ?? 0 : null;
  const cooccurrenceAvailable = Boolean(profile?.cooccurrence.available && anchors.length > 0);
  const cooccurrences = cooccurrenceAvailable && profile
    ? anchors.map((anchor) => anchor === filePath ? 1 : profile.cooccurrence.frequencies[cooccurrenceKey(anchor, filePath)] ?? 0)
    : [];
  const maximumCooccurrence = cooccurrences.length > 0 ? Math.max(...cooccurrences) : null;
  const sensitivitySources = profile ? sensitivitySourcesForPath(profile, filePath) : [];
  const removedLines = deletedLineCount(input);

  return [
    {
      id: "importDistance",
      available: distanceAvailable,
      rawValue: distance,
      normalizedValue: distance === null ? null : graphRisk(distance, config),
      explanation: distanceAvailable
        ? distance === "disconnected" ? "Aucun chemin vers une ancre de l'intention." : `Distance ${distance} depuis une ancre de l'intention.`
        : "Aucune ancre JS/TS résoluble depuis l'intention courante.",
    },
    {
      id: "fileRarity",
      available: rateAvailable,
      rawValue: modificationRate,
      normalizedValue: modificationRate === null ? null : clamp(1 - modificationRate, 0, 1),
      explanation: rateAvailable
        ? `Le fichier apparaît dans ${round((modificationRate ?? 0) * 100)} % des commits.`
        : profile?.modificationRates.reason ?? "Profil Git indisponible.",
    },
    {
      id: "anchorCooccurrence",
      available: cooccurrenceAvailable,
      rawValue: maximumCooccurrence,
      normalizedValue: maximumCooccurrence === null ? null : clamp(1 - maximumCooccurrence, 0, 1),
      explanation: cooccurrenceAvailable
        ? `Cooccurrence maximale avec les ancres : ${round((maximumCooccurrence ?? 0) * 100)} %.`
        : profile?.cooccurrence.reason ?? "Cooccurrence indisponible sans ancre résolue.",
    },
    {
      id: "deletedLines",
      available: true,
      rawValue: removedLines,
      normalizedValue: clamp(removedLines / config.signalParameters.deletedLinesSaturation, 0, 1),
      explanation: `${removedLines} ligne(s) supprimée(s) nettes.`,
    },
    {
      id: "turnFileCount",
      available: true,
      rawValue: input.changedFileCount,
      normalizedValue: clamp(input.changedFileCount / config.signalParameters.turnFileCountSaturation, 0, 1),
      explanation: `${input.changedFileCount} fichier(s) touché(s) dans le tour.`,
    },
    {
      id: "sensitiveFile",
      available: profile !== null,
      rawValue: { sensitive: sensitivitySources.length > 0, sources: sensitivitySources.join(", ") || null },
      normalizedValue: profile ? (sensitivitySources.length > 0 ? 1 : 0) : null,
      explanation: profile
        ? sensitivitySources.length > 0 ? `Sensibilité dérivée : ${sensitivitySources.join(", ")}.` : "Aucun motif sensible dérivé ne correspond."
        : "Profil de sensibilité indisponible.",
    },
    {
      id: "explicitIntent",
      available: true,
      rawValue: explicit,
      normalizedValue: explicit ? 1 : 0,
      explanation: explicit ? "Le fichier est explicitement nommé dans l'intention." : "Le fichier n'est pas explicitement nommé.",
    },
  ];
}

function verdictForScore(score: number, config: ScoringConfig): Severity {
  if (score >= config.thresholds.red) return "RED";
  if (score >= config.thresholds.orange) return "ORANGE";
  return "GREEN";
}

export function scoreClassification(
  input: ClassificationInput,
  intent: CurrentIntentState | null,
  profile: RepoProfile | null,
  graph: ImportGraph | null,
  config: ScoringConfig,
): ScoreBreakdown {
  const raw = rawSignals(input, intent, profile, graph, config);
  const availablePositiveWeight = raw
    .filter((signal) => signal.available && config.weights[signal.id] > 0)
    .reduce((sum, signal) => sum + config.weights[signal.id], 0);
  const normalizationFactor = availablePositiveWeight > 0 ? config.scoreScale / availablePositiveWeight : 1;
  const signals: ScoreSignalBreakdown[] = raw.map((signal) => {
    const weight = config.weights[signal.id];
    const normalizedValue = signal.available ? signal.normalizedValue : null;
    const factor = weight > 0 ? normalizationFactor : 1;
    return {
      id: signal.id,
      available: signal.available,
      rawValue: signal.rawValue,
      normalizedValue,
      weight,
      contribution: normalizedValue === null ? 0 : round(normalizedValue * weight * factor),
      explanation: signal.explanation,
    };
  });
  const unclampedScore = round(signals.reduce((sum, signal) => sum + signal.contribution, 0));
  const score = round(clamp(unclampedScore, config.minimumScore, config.maximumScore));
  const verdict = verdictForScore(score, config);
  return {
    mode: "scored",
    configVersion: config.version,
    score,
    unclampedScore,
    thresholds: { ...config.thresholds },
    normalizationFactor: round(normalizationFactor),
    signals,
    unavailableSignals: signals.filter((signal) => !signal.available).map((signal) => signal.id),
    verdict,
  };
}

export function absoluteScoreBreakdown(
  config: ScoringConfig,
  verdict: Severity,
  ruleId: string,
): ScoreBreakdown {
  return {
    mode: "absolute",
    configVersion: config.version,
    score: null,
    unclampedScore: null,
    thresholds: { ...config.thresholds },
    normalizationFactor: 1,
    signals: [],
    unavailableSignals: [],
    verdict,
    absoluteRuleId: ruleId,
  };
}
