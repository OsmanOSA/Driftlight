/**
 * Minimise les secrets évidents dans tout texte destiné à quitter le processus.
 *
 * Le besoin est né côté Codex, mais il vaut partout : une notification système
 * est archivée par le centre de notifications du système d'exploitation et
 * survit largement à la session qui l'a produite. Une commande d'infrastructure
 * portant un jeton en argument y resterait lisible longtemps après coup.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password|credential)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1$2[REDACTED]",
    );
}
