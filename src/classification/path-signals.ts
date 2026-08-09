import type { RepoProfile, ScoringConfig } from "../domain/types.js";
import {
  matchingGitignorePattern,
  readGitignorePatterns,
} from "../profile/repo-profile.js";
import { toPosixPath } from "../shared/paths.js";

/**
 * Les chemins sensibles viennent exclusivement de la configuration versionnée.
 * Aucune liste de noms n'est cachée dans le classifieur.
 */
export function secretPatternSources(config: ScoringConfig, filePath: string): string[] {
  const normalized = toPosixPath(filePath);
  const sources: string[] = [];
  for (const pattern of config.secretPathPatterns) {
    try {
      if (new RegExp(pattern, "i").test(normalized)) sources.push(`secret-pattern:${pattern}`);
    } catch {
      // Un motif utilisateur invalide est indisponible ; il n'est jamais remplacé.
    }
  }
  return sources;
}

export function gitignoreSource(
  root: string,
  _profile: RepoProfile | null,
  filePath: string,
): string | null {
  // .gitignore peut être modifié sans changer HEAD ; le relire évite un cache
  // de profil périmé sur cette exemption bon marché.
  const patterns = readGitignorePatterns(root);
  const matched = matchingGitignorePattern(toPosixPath(filePath), patterns);
  return matched ? `gitignore:${matched}` : null;
}
