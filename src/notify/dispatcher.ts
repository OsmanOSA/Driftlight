import type { CurrentIntentState, DriftLightConfig, SessionEvent, Severity } from "../domain/types.js";
import { readOwnCurrentIntentSync } from "../intent/current-intent.js";
import { loadNativeBackend, type BackendLoader, type NativeNotification, type NotifierBackend } from "./backend.js";
import { severityIconPath } from "./icons.js";
import { notificationMessage, notificationTitle } from "./message.js";
import { NotificationLedger, type ReservationOutcome } from "./notified-log.js";

export type NotificationOutcome =
  | "sent"
  | "duplicate-event"
  | "duplicate-recent"
  | "session-cap"
  | "level-disabled"
  | "environment-disabled"
  | "backend-unavailable";

export interface NotificationDecision {
  eventId: string;
  level: Severity;
  outcome: NotificationOutcome;
}

export interface DispatchOptions {
  loadBackend?: BackendLoader;
  ledger?: NotificationLedger;
  /** Identifiants des événements pour lesquels le hook a réellement renvoyé un refus. */
  blockedEventIds?: readonly string[];
  environment?: NodeJS.ProcessEnv;
}

/**
 * Coupe-circuit d'environnement.
 *
 * Une suite de tests qui invoque le vrai binaire ne doit jamais faire surgir de
 * notification système sur la machine qui l'exécute ; un agent d'intégration
 * continue non plus.
 */
export function notificationsDisabledByEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === "test"
    || environment.CI !== undefined
    || environment.DRIFTLIGHT_NO_NOTIFY !== undefined;
}

export function shouldNotify(event: SessionEvent, config: DriftLightConfig): boolean {
  if (event.type === "lifecycle") return false;
  if (event.level === "RED") return config.notifyOnRed;
  if (event.level === "ORANGE") return config.notifyOnOrange;
  return false;
}

/** Sujet de l'alerte : chemin de fichier, ou commande pour un événement sans fichier. */
export function notificationSubject(event: SessionEvent): string {
  return event.path ?? event.detail ?? "action";
}

export function buildNotification(
  root: string,
  event: SessionEvent,
  config: DriftLightConfig,
  blocked: boolean,
  intent: CurrentIntentState | null = null,
): NativeNotification {
  const icon = severityIconPath(event.level);
  return {
    title: notificationTitle(root, event, blocked),
    message: notificationMessage(root, event, intent),
    sound: config.notificationSound,
    ...(icon ? { icon } : {}),
  };
}

const RESERVATION_TO_OUTCOME: Record<Exclude<ReservationOutcome, "accepted">, NotificationOutcome> = {
  "duplicate-event": "duplicate-event",
  "duplicate-recent": "duplicate-recent",
  "session-cap": "session-cap",
};

/**
 * Notifie les événements éligibles.
 *
 * Ne rejette jamais : la notification est un complément au verdict, jamais un
 * point de défaillance du hook qui l'appelle.
 */
export async function dispatchNotifications(
  root: string,
  events: SessionEvent[],
  config: DriftLightConfig,
  sessionId: string,
  options: DispatchOptions = {},
): Promise<NotificationDecision[]> {
  const decisions: NotificationDecision[] = [];
  try {
    if (notificationsDisabledByEnvironment(options.environment)) {
      return events.map((event) => ({
        eventId: event.id,
        level: event.level,
        outcome: "environment-disabled" as const,
      }));
    }

    const ledger = options.ledger ?? new NotificationLedger(root);
    const blocked = new Set(options.blockedEventIds ?? []);
    const pending: SessionEvent[] = [];

    for (const event of events) {
      if (!shouldNotify(event, config)) {
        decisions.push({ eventId: event.id, level: event.level, outcome: "level-disabled" });
        continue;
      }
      const reservation = ledger.reserve({
        eventId: event.id,
        subject: notificationSubject(event),
        ruleId: event.ruleId,
        sessionId,
        blocking: blocked.has(event.id),
      });
      if (reservation !== "accepted") {
        decisions.push({ eventId: event.id, level: event.level, outcome: RESERVATION_TO_OUTCOME[reservation] });
        continue;
      }
      pending.push(event);
    }

    if (pending.length === 0) return decisions;

    // La demande d'origine est ce qui rend l'alerte jugeable d'un coup d'œil.
    // Son absence dégrade le texte sans jamais empêcher la notification, et
    // seule la demande de cette session-ci peut être citée : voir
    // readOwnCurrentIntentSync.
    let intent: CurrentIntentState | null = null;
    try {
      intent = readOwnCurrentIntentSync(root, sessionId);
    } catch {
      intent = null;
    }

    // Chargement tardif : aucun hook ne paie l'import tant qu'il n'y a rien à notifier.
    let backend: NotifierBackend | null = null;
    try {
      backend = await (options.loadBackend ?? loadNativeBackend)();
    } catch {
      backend = null;
    }

    for (const event of pending) {
      if (!backend) {
        decisions.push({ eventId: event.id, level: event.level, outcome: "backend-unavailable" });
        continue;
      }
      try {
        await backend.send(buildNotification(root, event, config, blocked.has(event.id), intent));
        decisions.push({ eventId: event.id, level: event.level, outcome: "sent" });
      } catch {
        decisions.push({ eventId: event.id, level: event.level, outcome: "backend-unavailable" });
      }
    }
    return decisions;
  } catch {
    return decisions;
  }
}
