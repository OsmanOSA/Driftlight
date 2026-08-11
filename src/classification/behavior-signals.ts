import type {
  ClassificationInput,
  RepoProfile,
  ScoreBreakdown,
  ScoreRawValue,
  ScoringConfig,
  Severity,
} from "../domain/types.js";
import { toPosixPath } from "../shared/paths.js";
import { dependencyAdditions } from "./manifest-signals.js";
import { secretPatternSources } from "./path-signals.js";
import { isDestructiveOperation } from "./exemptions.js";

/** Étage 2 : faits observables, sans historique Git ni graphe d'import. */
export interface BehaviorFinding {
  id: string;
  severity: Severity;
  reason: string;
  available?: boolean;
  triggered?: boolean;
  rawValue?: ScoreRawValue;
}

export interface BehaviorContext {
  profile: RepoProfile | null;
  readPathsInSession: readonly string[];
  declaredPlanPaths: readonly string[];
  largeLineDeletionThreshold: number;
}

export interface BehaviorDecision {
  verdict: Severity;
  ruleId: string;
  activeFamilies: string[];
}

const ORDER: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };

function severityFor(config: ScoringConfig, id: string): Severity {
  // La validation de configuration garantit la présence de tous les signaux.
  return config.behavior.severities[id] ?? "GREEN";
}

function pathIncluded(paths: readonly string[], filePath: string): boolean {
  const normalized = toPosixPath(filePath).toLowerCase();
  return paths.some((candidate) => toPosixPath(candidate).toLowerCase() === normalized);
}

function observed(
  config: ScoringConfig,
  id: string,
  triggered: boolean,
  rawValue: ScoreRawValue,
  reason: string,
  available = true,
): BehaviorFinding {
  return { id, severity: severityFor(config, id), reason, available, triggered, rawValue };
}

export function evaluateBehaviorSignals(
  input: ClassificationInput,
  context: BehaviorContext,
  config: ScoringConfig,
): BehaviorFinding[] {
  const filePath = toPosixPath(input.change.path);
  const existedBefore = input.initialSnapshot.files[filePath] !== undefined;
  const secretSources = secretPatternSources(config, filePath);
  const destructive = isDestructiveOperation(input, context.largeLineDeletionThreshold);
  const removed = input.operation?.deletedLineCount ?? Math.max(
    0,
    (input.change.before?.lineCount ?? 0) - (input.change.after?.lineCount ?? input.change.before?.lineCount ?? 0),
  );
  const readInSession = pathIncluded(context.readPathsInSession, filePath);
  const declaredInPlan = pathIncluded(context.declaredPlanPaths, filePath);
  const dependencyChange = dependencyAdditions(input);
  const reformatted = input.operation?.fullFileReformat === true;

  return [
    observed(
      config,
      "sensitive-file",
      secretSources.length > 0,
      { matched: secretSources.length > 0, sources: secretSources.join(", ") || null },
      secretSources.length > 0
        ? `Le chemin correspond à un motif de secret dérivé : ${secretSources.join(", ")}.`
        : "Aucun motif de secret configuré ne correspond.",
    ),
    observed(
      config,
      "destructive-edit",
      destructive,
      {
        operation: input.operation?.kind ?? "unknown",
        changeKind: input.change.kind,
        deletedLineCount: removed,
        threshold: context.largeLineDeletionThreshold,
      },
      input.change.kind === "deleted"
        ? "Suppression du fichier."
        : input.operation?.kind === "rename"
          ? "Renommage du fichier."
          : input.operation?.kind === "write"
            ? "Réécriture intégrale du fichier."
            : `Suppression nette de ${removed} ligne(s).`,
    ),
    observed(
      config,
      "write-without-read",
      existedBefore && !readInSession && !declaredInPlan,
      { existedBefore, readInSession, declaredInPlan },
      existedBefore && !readInSession && !declaredInPlan
        ? "Écriture sur un fichier préexistant jamais lu dans la session."
        : declaredInPlan
          ? "Le plan annonce ce chemin ; cet indice neutralise seulement l'absence de lecture."
          : "Le fichier est nouveau ou a été lu dans la session.",
    ),
    observed(
      config,
      "dependency-added",
      dependencyChange.added.length > 0,
      { added: dependencyChange.added.join(", ") || null },
      dependencyChange.added.length > 0
        ? `Dépendance(s) ajoutée(s) : ${dependencyChange.added.join(", ")}.`
        : dependencyChange.available
          ? "Aucune nouvelle clé de dépendance ; un bump de version ne déclenche pas ce signal."
          : "Signal non applicable ou contenu de manifeste indisponible.",
      dependencyChange.available,
    ),
    observed(
      config,
      "full-file-reformat",
      reformatted,
      { detected: reformatted },
      reformatted
        ? "Reformatage intégral observé alors que l'opération était ponctuelle."
        : "Aucun reformatage intégral distinct observé.",
      input.operation?.fullFileReformat !== undefined,
    ),
  ];
}

function triggered(findings: readonly BehaviorFinding[]): BehaviorFinding[] {
  return findings.filter((finding) => finding.available !== false && finding.triggered !== false);
}

function familyFor(config: ScoringConfig, finding: BehaviorFinding): string {
  return config.behavior.signalFamilies[finding.id] ?? finding.id;
}

/** Première règle correspondante d'une table ordonnée, sans somme de bruit. */
export function evaluateBehaviorDecision(
  findings: readonly BehaviorFinding[],
  config: ScoringConfig,
): BehaviorDecision {
  const active = triggered(findings);
  const corroborating = new Set(config.behavior.corroboratingFamilies ?? []);
  for (const rule of config.behavior.decisionTable) {
    const minimum = ORDER[rule.when.minimumSignalSeverity];
    const families = [...new Set(
      active
        .filter((finding) => ORDER[finding.severity] >= minimum)
        .map((finding) => familyFor(config, finding)),
    )];
    // Une famille purement corroborante ne décide jamais seule : sans au moins
    // une famille décisive, la règle ne s'applique pas et l'événement reste
    // journalisé sans alerte.
    if (!families.some((family) => !corroborating.has(family))) continue;
    const required = rule.when.requiredFamilies ?? [];
    if (
      families.length >= rule.when.minimumDistinctFamilies
      && required.every((family) => families.includes(family))
    ) {
      return { verdict: rule.verdict, ruleId: rule.id, activeFamilies: families };
    }
  }
  return {
    verdict: "GREEN",
    ruleId: "no-active-signal",
    activeFamilies: [...new Set(active.map((finding) => familyFor(config, finding)))],
  };
}

export function combineBehaviorFindings(
  findings: readonly BehaviorFinding[],
  config: ScoringConfig,
): Severity {
  return evaluateBehaviorDecision(findings, config).verdict;
}

export function behaviorScoreBreakdown(
  findings: readonly BehaviorFinding[],
  decision: BehaviorDecision,
  config: ScoringConfig,
): ScoreBreakdown {
  return {
    mode: "rules",
    configVersion: config.version,
    score: null,
    unclampedScore: null,
    thresholds: { ...config.thresholds },
    normalizationFactor: 1,
    signals: findings.map((finding) => {
      const available = finding.available !== false;
      const active = available && finding.triggered !== false;
      const weight = config.behavior.severityWeights[finding.severity];
      return {
        id: finding.id,
        available,
        rawValue: finding.rawValue ?? null,
        normalizedValue: active ? 1 : available ? 0 : null,
        weight,
        contribution: active ? weight : 0,
        explanation: finding.reason,
        triggered: active,
        severity: finding.severity,
        family: familyFor(config, finding),
      };
    }),
    unavailableSignals: findings.filter((finding) => finding.available === false).map((finding) => finding.id),
    verdict: decision.verdict,
    decisionRuleId: decision.ruleId,
    activeSignalFamilies: decision.activeFamilies,
  };
}

export function highestBehaviorSeverity(findings: readonly BehaviorFinding[]): Severity {
  return triggered(findings).reduce<Severity>(
    (highest, finding) => ORDER[finding.severity] > ORDER[highest] ? finding.severity : highest,
    "GREEN",
  );
}
