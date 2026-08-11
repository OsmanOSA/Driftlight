import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CurrentIntentState } from "../domain/types.js";
import { safeIdentifier } from "../shared/paths.js";
import { projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomic } from "../shared/atomic-write.js";
import { readJsonStateSync } from "../shared/read-state.js";

/**
 * L'intention appartient à une session, pas à un dépôt.
 *
 * Deux fenêtres de l'agent ouvertes sur le même projet poursuivent deux
 * demandes différentes. Partager un fichier unique faisait que la dernière à
 * parler écrasait l'intention des autres — dans les deux directions : une
 * session se faisait signaler le fichier qu'elle avait pourtant nommé, et pire,
 * l'intention d'une session pouvait exempter une destruction commise hors
 * périmètre par une autre.
 */
export function currentIntentPath(root: string, sessionId?: string): string {
  return sessionId
    ? projectStatePath(root, "intents", `${safeIdentifier(sessionId)}.json`)
    : projectStatePath(root, "current-intent.json");
}

const readIntentFile = (filePath: string): CurrentIntentState | null =>
  readJsonStateSync<CurrentIntentState>(filePath);

/**
 * L'intention de cette session seulement, sans reprise de l'intention partagée.
 *
 * La citation affichée dans une notification doit être la demande que
 * l'utilisateur vient d'écrire ici. Reprendre celle d'une autre session lui
 * ferait relire une phrase vieille de plusieurs heures et juger l'alerte
 * dessus ; mieux vaut ne rien citer que citer la mauvaise demande.
 */
export function readOwnCurrentIntentSync(root: string, sessionId?: string): CurrentIntentState | null {
  return readIntentFile(currentIntentPath(root, sessionId));
}

export function readCurrentIntentSync(root: string, sessionId?: string): CurrentIntentState | null {
  const own = readIntentFile(currentIntentPath(root, sessionId));
  if (own || !sessionId) return own;
  // Reprise : une session ouverte avant la séparation n'a pas encore de fichier
  // propre. Elle repart de l'intention partagée jusqu'à son prochain prompt.
  return readIntentFile(currentIntentPath(root));
}

async function saveCurrentIntent(
  root: string,
  state: CurrentIntentState,
  sessionId?: string,
): Promise<CurrentIntentState> {
  await writeJsonAtomic(currentIntentPath(root, sessionId), state);
  return state;
}

export async function writeCurrentIntent(
  root: string,
  text: string,
  options: { turnId?: string; resetScope?: boolean; sessionId?: string } = {},
): Promise<CurrentIntentState> {
  const previous = readCurrentIntentSync(root, options.sessionId);
  return await saveCurrentIntent(root, {
    schemaVersion: 1,
    version: (previous?.version ?? 0) + 1,
    turnId: options.turnId ?? `turn-${Date.now()}-${randomUUID().slice(0, 8)}`,
    text: text.trim(),
    scopeAdditions: options.resetScope ? [] : previous?.scopeAdditions ?? [],
    updatedAt: new Date().toISOString(),
  }, options.sessionId);
}

export async function addCurrentScope(
  root: string,
  text: string,
  sessionId?: string,
): Promise<CurrentIntentState> {
  const previous = readCurrentIntentSync(root, sessionId) ?? {
    schemaVersion: 1 as const,
    version: 0,
    turnId: `turn-${Date.now()}-${randomUUID().slice(0, 8)}`,
    text: "",
    scopeAdditions: [],
    updatedAt: new Date().toISOString(),
  };
  const addition = text.trim();
  const additions = addition && !previous.scopeAdditions.includes(addition)
    ? [...previous.scopeAdditions, addition]
    : previous.scopeAdditions;
  return await saveCurrentIntent(root, {
    ...previous,
    version: previous.version + 1,
    scopeAdditions: additions,
    updatedAt: new Date().toISOString(),
  }, sessionId);
}
