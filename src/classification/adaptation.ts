import type { ScoringConfig } from "../domain/types.js";
import { parseScopeKey, scopeDirectory, type FeedbackStats } from "./feedback-stats.js";
import type { BehaviorFinding } from "./behavior-signals.js";

/**
 * Apprentissage local — ce que l'outil retient de l'usage.
 *
 * Le principe est celui des éditeurs : un diagnostic qu'on écarte
 * systématiquement au même endroit finit par se taire à cet endroit, sans
 * jamais se taire ailleurs. Trois choix rendent cette boucle sûre.
 *
 * 1. La portée est le couple (signal, répertoire), jamais le signal seul.
 *    Apprendre qu'une réécriture est banale dans `test/fixtures` ne dit rien
 *    de `src`, et la neutralisation ne franchit pas la frontière du répertoire
 *    où elle a été gagnée.
 * 2. Un signal RED n'est jamais apprenable. Un secret, une destruction ou une
 *    commande d'infrastructure restent hors de portée du feedback, quel qu'en
 *    soit le volume.
 * 3. L'apprentissage n'agit qu'à l'étage 2. L'étage 0 le précède et ne consulte
 *    rien : aucune accumulation de feedback ne peut rendre destructible du
 *    travail non commité.
 *
 * Un seuil, pas une pente : en deçà des minimums, l'effet est nul plutôt que
 * partiel. Une décroissance progressive s'éteindrait sans que personne ne
 * puisse dire quand.
 */

/** Qualifications nécessaires sur une portée avant tout effet. */
export const LEARNING_MINIMUM_SAMPLE = 8;
/** Fichiers distincts nécessaires : un seul cas ne parle pas de ses voisins. */
export const LEARNING_MINIMUM_FILES = 2;
/** Part de bruit exigée, pour qu'un désaccord réel suffise à réactiver. */
export const LEARNING_NOISE_RATIO = 0.9;

export interface LearnedSuppression {
  signalId: string;
  directory: string;
  noise: number;
  useful: number;
  distinctFiles: number;
}

function learnable(config: ScoringConfig, signalId: string): boolean {
  if (config.behavior.severities[signalId] === undefined) return false;
  return config.behavior.severities[signalId] !== "RED";
}

/** Portées où le feedback accumulé justifie de neutraliser un signal. */
export function learnedSuppressions(
  stats: FeedbackStats,
  config: ScoringConfig,
): LearnedSuppression[] {
  const learned: LearnedSuppression[] = [];
  for (const [key, scope] of Object.entries(stats.byScope ?? {})) {
    const parsed = parseScopeKey(key);
    if (!parsed || !learnable(config, parsed.signalId)) continue;
    const total = scope.noise + scope.useful;
    if (total < LEARNING_MINIMUM_SAMPLE) continue;
    if (scope.files.length < LEARNING_MINIMUM_FILES) continue;
    if (scope.noise < total * LEARNING_NOISE_RATIO) continue;
    learned.push({
      signalId: parsed.signalId,
      directory: parsed.directory,
      noise: scope.noise,
      useful: scope.useful,
      distinctFiles: scope.files.length,
    });
  }
  return learned.sort((left, right) =>
    left.signalId.localeCompare(right.signalId) || left.directory.localeCompare(right.directory),
  );
}

export interface AdaptedFindings {
  findings: BehaviorFinding[];
  suppressed: LearnedSuppression[];
}

/**
 * Neutralise les signaux appris comme bruit sur le répertoire du fichier visé.
 * Le signal reste dans le relevé, marqué non déclenché et motivé : un signal
 * effacé serait indistinguable d'un signal jamais évalué.
 */
export function applyLearnedSuppressions(
  findings: readonly BehaviorFinding[],
  root: string,
  filePath: string,
  learned: readonly LearnedSuppression[],
): AdaptedFindings {
  if (learned.length === 0) return { findings: [...findings], suppressed: [] };
  const directory = scopeDirectory(root, filePath);
  const suppressed: LearnedSuppression[] = [];
  const adapted = findings.map((finding) => {
    if (finding.triggered !== true) return finding;
    const match = learned.find(
      (item) => item.signalId === finding.id && item.directory === directory,
    );
    if (!match || finding.severity === "RED") return finding;
    suppressed.push(match);
    return {
      ...finding,
      triggered: false,
      reason: `${finding.reason} Neutralisé par apprentissage : ${match.noise} qualification(s)`
        + ` « bruit » sur ${match.distinctFiles} fichier(s) de ${match.directory || "la racine"}.`,
    };
  });
  return { findings: adapted, suppressed };
}

export function describeSuppression(item: LearnedSuppression): string {
  return `${item.signalId} dans ${item.directory || "(racine)"}`
    + ` — ${item.noise} bruit / ${item.useful} utile sur ${item.distinctFiles} fichier(s)`;
}
