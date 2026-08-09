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
import { cooccurrenceKey } from "../profile/repo-profile.js";
import { toPosixPath } from "../shared/paths.js";

type ShadowSignalId = "importDistance" | "fileRarity" | "anchorCooccurrence";

interface RawSignal {
  id: ShadowSignalId;
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

function rawSignals(
  input: ClassificationInput,
  intent: CurrentIntentState | null,
  profile: RepoProfile | null,
  graph: ImportGraph | null,
  config: ScoringConfig,
): RawSignal[] {
  const filePath = toPosixPath(input.change.path);
  const anchors = resolveIntentAnchors(intent, graph);
  const inGraph = Boolean(graph?.nodes.includes(filePath));
  const graphMature = Boolean(graph && graph.nodes.length >= config.signalParameters.minimumGraphFiles);
  const distanceAvailable = Boolean(graphMature && anchors.length > 0 && inGraph);
  const distance = distanceAvailable && graph ? importDistance(graph, anchors, filePath) : null;

  const rateAvailable = profile?.modificationRates.available ?? false;
  // Après le minimum de commits, l'absence du fichier dans l'historique est un
  // fait observé (taux nul), pas une valeur de remplacement.
  const modificationRate = rateAvailable ? profile?.modificationRates.rates[filePath] ?? 0 : null;

  const cooccurrenceAvailable = Boolean(profile?.cooccurrence.available && graphMature && anchors.length > 0);
  const cooccurrences = cooccurrenceAvailable && profile
    ? anchors.map((anchor) => anchor === filePath ? 1 : profile.cooccurrence.frequencies[cooccurrenceKey(anchor, filePath)] ?? 0)
    : [];
  const maximumCooccurrence = cooccurrences.length > 0 ? Math.max(...cooccurrences) : null;

  return [
    {
      id: "importDistance",
      available: distanceAvailable,
      rawValue: distance,
      normalizedValue: distance === null ? null : graphRisk(distance, config),
      explanation: distanceAvailable
        ? distance === "disconnected"
          ? "Aucun chemin vers une ancre de l'intention."
          : `Distance ${distance} depuis une ancre de l'intention.`
        : !graph
          ? "Graphe d'imports indisponible."
          : !inGraph
            ? "Fichier hors du graphe d'imports : signal non applicable, jamais remplacé par une valeur par défaut."
            : !graphMature
              ? `Graphe immature : ${graph.nodes.length}/${config.signalParameters.minimumGraphFiles} fichiers JS/TS.`
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
        : !profile?.cooccurrence.available
          ? profile?.cooccurrence.reason ?? "Profil Git indisponible."
          : !graphMature
            ? "Cooccurrence indisponible tant que le graphe d'imports est immature."
            : "Cooccurrence indisponible sans ancre résolue.",
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
    return {
      id: signal.id,
      available: signal.available,
      rawValue: signal.rawValue,
      normalizedValue,
      weight,
      contribution: normalizedValue === null ? 0 : round(normalizedValue * weight * normalizationFactor),
      explanation: signal.explanation,
    };
  });
  const hasAvailableSignal = signals.some((signal) => signal.available && signal.weight > 0);
  const unclampedScore = hasAvailableSignal
    ? round(signals.reduce((sum, signal) => sum + signal.contribution, 0))
    : null;
  const score = unclampedScore === null
    ? null
    : round(clamp(unclampedScore, config.minimumScore, config.maximumScore));
  const verdict = score === null ? "GREEN" : verdictForScore(score, config);
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
