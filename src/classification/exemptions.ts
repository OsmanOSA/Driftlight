import type {
  ClassificationInput,
  CurrentIntentState,
  RepoProfile,
  ScoringConfig,
} from "../domain/types.js";
import { toPosixPath } from "../shared/paths.js";
import { dependencyAdditions } from "./manifest-signals.js";
import { gitignoreSource, secretPatternSources } from "./path-signals.js";
import { pathExplicitlyExpected } from "./rules.js";

export type ExemptionId =
  | "named-in-intent"
  | "read-this-turn"
  | "git-ignored"
  | "created-this-session";

export interface ExemptionContext {
  intent: CurrentIntentState | null;
  profile: RepoProfile | null;
  scoringConfig: ScoringConfig;
  readPathsThisTurn: readonly string[];
  createdPathsThisTurn: readonly string[];
  largeLineDeletionThreshold: number;
}

export interface ExemptionVerdict {
  id: ExemptionId;
  reason: string;
}

export function isDestructiveOperation(
  input: ClassificationInput,
  largeLineDeletionThreshold: number,
): boolean {
  if (input.change.kind === "deleted") return true;
  if (input.operation?.kind === "write" || input.operation?.kind === "rename") return true;
  return (input.operation?.deletedLineCount ?? 0) >= largeLineDeletionThreshold;
}

function pathIncluded(paths: readonly string[], filePath: string): boolean {
  const normalized = toPosixPath(filePath).toLowerCase();
  return paths.some((candidate) => toPosixPath(candidate).toLowerCase() === normalized);
}

export function evaluateExemptions(
  input: ClassificationInput,
  context: ExemptionContext,
): ExemptionVerdict | null {
  const filePath = toPosixPath(input.change.path);
  const destructive = isDestructiveOperation(input, context.largeLineDeletionThreshold);
  const secret = secretPatternSources(context.scoringConfig, filePath).length > 0;
  const dependencyAdded = dependencyAdditions(input).added.length > 0;
  // Les exemptions implicites ne doivent pas masquer un fait critique. Seule
  // l'intention utilisateur constitue ici une autorisation explicite.
  const implicitVetoAllowed = !destructive && !secret && !dependencyAdded;

  // 1. Nommé ou résolu depuis current-intent.json.
  if (pathExplicitlyExpected(
    context.intent?.text ?? "",
    context.intent?.scopeAdditions ?? [],
    filePath,
  )) {
    return { id: "named-in-intent", reason: "Fichier nommé ou résolu depuis l'intention courante." };
  }

  // 2. Lu pendant le tour. Une lecture atténue une édition normale, mais ne
  // blanchit jamais une destruction, un secret ou un ajout de dépendance.
  if (implicitVetoAllowed && pathIncluded(context.readPathsThisTurn, filePath)) {
    return { id: "read-this-turn", reason: "Fichier lu par l'agent pendant ce tour." };
  }

  // 3. Ignoré par Git, sauf lorsqu'un motif de secret correspond.
  const ignoredBy = gitignoreSource(input.root, context.profile, filePath);
  if (implicitVetoAllowed && ignoredBy) {
    return { id: "git-ignored", reason: `Fichier ignoré par Git (${ignoredBy}) et sans motif de secret.` };
  }

  // 4. Créé pendant le tour courant uniquement. Le nom historique du champ est
  // conservé pour la compatibilité des journaux, mais l'exemption expire au tour.
  const createdThisTurn = input.change.kind === "created"
    || pathIncluded(context.createdPathsThisTurn, filePath);
  if (implicitVetoAllowed && createdThisTurn) {
    return { id: "created-this-session", reason: "Fichier créé pendant le tour courant." };
  }

  return null;
}
