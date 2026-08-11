import { readFileSync } from "node:fs";
import path from "node:path";
import { projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomicSync } from "../shared/atomic-write.js";

/**
 * Registre des notifications déjà émises.
 *
 * Chaque hook Claude Code s'exécute dans un processus neuf : tout état de
 * déduplication en mémoire serait perdu entre deux événements. Le registre est
 * donc persisté à côté des autres états DriftLight.
 *
 * Il applique trois garde-fous successifs :
 *  - un `eventId` ne notifie jamais deux fois ;
 *  - un même couple chemin + règle ne renotifie pas dans la fenêtre de silence ;
 *  - une session ne dépasse jamais le plafond dur de notifications, les alertes
 *    au-delà étant comptées sans bruit et rendues dans le résumé du hook Stop.
 */

/** Fenêtre pendant laquelle un même couple chemin + règle reste silencieux. */
export const SILENCE_WINDOW_MS = 10 * 60 * 1000;

/** Plafond dur de notifications par session. */
export const SESSION_NOTIFICATION_CAP = 3;

const RETAINED_ENTRIES = 500;

export type ReservationOutcome =
  | "accepted"
  | "duplicate-event"
  | "duplicate-recent"
  | "session-cap";

export interface ReservationRequest {
  eventId: string;
  subject: string;
  ruleId: string;
  sessionId: string;
  /**
   * Le hook a effectivement retenu l'action et attend une réponse humaine.
   *
   * Un blocage n'est pas du bruit répétitif : c'est une demande de décision, et
   * l'agent reste arrêté tant qu'elle n'est pas rendue. Le taire parce qu'une
   * alerte identique a déjà été émise laisserait l'utilisateur ignorer que
   * l'agent l'attend. La fenêtre de silence et le plafond ne s'y appliquent donc
   * pas — la cadence est de toute façon bornée par le temps de réponse humain.
   */
  blocking?: boolean;
  now?: number;
}

interface LedgerEntry {
  eventId: string;
  subject: string;
  ruleId: string;
  notifiedAt: string;
}

export interface LedgerState {
  schemaVersion: 2;
  sessionId: string | null;
  notifiedInSession: number;
  suppressedByCap: number;
  entries: LedgerEntry[];
}

function emptyState(): LedgerState {
  return {
    schemaVersion: 2,
    sessionId: null,
    notifiedInSession: 0,
    suppressedByCap: 0,
    entries: [],
  };
}

export function notifiedLogPath(root: string): string {
  return projectStatePath(root, "notified-events.json");
}

function isEntry(value: unknown): value is LedgerEntry {
  const entry = value as LedgerEntry;
  return typeof value === "object"
    && value !== null
    && typeof entry.eventId === "string"
    && typeof entry.subject === "string"
    && typeof entry.ruleId === "string"
    && typeof entry.notifiedAt === "string";
}

export function readLedger(root: string): LedgerState {
  try {
    const parsed = JSON.parse(readFileSync(notifiedLogPath(root), "utf8")) as Partial<LedgerState>;
    // Un registre d'un ancien schéma est reparti de zéro plutôt que deviné.
    if (parsed.schemaVersion !== 2) return emptyState();
    return {
      schemaVersion: 2,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      notifiedInSession: typeof parsed.notifiedInSession === "number" ? parsed.notifiedInSession : 0,
      suppressedByCap: typeof parsed.suppressedByCap === "number" ? parsed.suppressedByCap : 0,
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [],
    };
  } catch {
    return emptyState();
  }
}

function writeLedger(root: string, state: LedgerState): void {
  const bounded: LedgerState = { ...state, entries: state.entries.slice(-RETAINED_ENTRIES) };
  writeJsonAtomicSync(notifiedLogPath(root), bounded);
}

/** Nombre d'alertes tues par le plafond pour la session en cours. */
export function suppressedByCap(root: string, sessionId: string): number {
  const state = readLedger(root);
  return state.sessionId === sessionId ? state.suppressedByCap : 0;
}

export class NotificationLedger {
  constructor(private readonly root: string) {}

  /**
   * Réserve le droit de notifier. Seul `"accepted"` autorise l'envoi.
   *
   * La réservation précède l'envoi : un backend défaillant ne doit pas provoquer
   * de nouvelle tentative au tour suivant, la garantie étant « au plus une
   * notification par eventId ».
   */
  reserve(request: ReservationRequest): ReservationOutcome {
    try {
      const now = request.now ?? Date.now();
      const state = readLedger(this.root);

      // Nouvelle session : les compteurs repartent à zéro. Les entrées récentes
      // survivent, car un redémarrage ne rend pas la même alerte moins répétitive.
      if (state.sessionId !== request.sessionId) {
        state.sessionId = request.sessionId;
        state.notifiedInSession = 0;
        state.suppressedByCap = 0;
      }

      // Idempotence : un même eventId ne notifie jamais deux fois, y compris
      // pour un blocage — c'est la même demande, pas une nouvelle.
      if (state.entries.some((entry) => entry.eventId === request.eventId)) {
        return "duplicate-event";
      }

      // Un blocage court-circuite l'anti-bruit : l'agent est arrêté et attend
      // une réponse. Une deuxième tentative sur le même fichier est une
      // deuxième demande de décision, pas une répétition à taire.
      if (!request.blocking) {
        const recent = state.entries.some((entry) =>
          entry.subject === request.subject
          && entry.ruleId === request.ruleId
          && now - Date.parse(entry.notifiedAt) < SILENCE_WINDOW_MS,
        );
        if (recent) {
          writeLedger(this.root, state);
          return "duplicate-recent";
        }

        if (state.notifiedInSession >= SESSION_NOTIFICATION_CAP) {
          state.suppressedByCap += 1;
          writeLedger(this.root, state);
          return "session-cap";
        }
      }

      state.entries.push({
        eventId: request.eventId,
        subject: request.subject,
        ruleId: request.ruleId,
        notifiedAt: new Date(now).toISOString(),
      });
      state.notifiedInSession += 1;
      writeLedger(this.root, state);
      return "accepted";
    } catch {
      // Registre illisible ou disque en lecture seule : on préfère se taire
      // plutôt que risquer de renotifier à chaque événement.
      return "duplicate-event";
    }
  }
}
