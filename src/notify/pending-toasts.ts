import { projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomicSync } from "../shared/atomic-write.js";
import { readJsonStateSync } from "../shared/read-state.js";
import { safeIdentifier } from "../shared/paths.js";

/**
 * Notifications persistantes encore affichées, par session.
 *
 * Une alerte qui retient une action reste à l'écran jusqu'à ce qu'on l'écarte.
 * Mais la décision qu'elle attend se prend le plus souvent ailleurs — dans le
 * dialogue de l'agent — et la notification devient alors un résidu. Retenir son
 * étiquette est la seule façon de pouvoir la retirer à ce moment-là.
 *
 * L'état est porté par session : deux sessions ouvertes sur le même dépôt ne
 * doivent pas effacer les alertes l'une de l'autre.
 */

interface PendingState {
  schemaVersion: 1;
  tags: string[];
}

/** Au-delà, une session a de toute façon cessé de suivre ses alertes. */
const RETAINED = 32;

function statePath(root: string, sessionId: string): string {
  return projectStatePath(root, "pending-toasts", `${safeIdentifier(sessionId)}.json`);
}

export function rememberPendingToasts(root: string, sessionId: string, tags: readonly string[]): void {
  if (tags.length === 0) return;
  try {
    const current = readJsonStateSync<PendingState>(statePath(root, sessionId));
    const merged = [...new Set([...(current?.tags ?? []), ...tags])].slice(-RETAINED);
    writeJsonAtomicSync(statePath(root, sessionId), { schemaVersion: 1, tags: merged });
  } catch {
    // Ne pas pouvoir retenir une étiquette ne doit jamais empêcher d'alerter.
  }
}

/** Rend les étiquettes en attente et vide la liste : le retrait n'a lieu qu'une fois. */
export function takePendingToasts(root: string, sessionId: string): string[] {
  try {
    const current = readJsonStateSync<PendingState>(statePath(root, sessionId));
    const tags = current?.tags ?? [];
    if (tags.length > 0) writeJsonAtomicSync(statePath(root, sessionId), { schemaVersion: 1, tags: [] });
    return tags;
  } catch {
    return [];
  }
}
