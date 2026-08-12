import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CurrentIntentState, DriftLightConfig, SessionEvent, Severity } from "../domain/types.js";
import { readOwnCurrentIntentSync } from "../intent/current-intent.js";
import {
  loadNativeBackend,
  type BackendLoader,
  type NativeNotification,
  type NotificationAuthorization,
  type NotifierBackend,
} from "./backend.js";
import { severityIconPath } from "./icons.js";
import { notificationDetail, notificationMessage, notificationTitle, type HookOutcome } from "./message.js";
import { NotificationLedger, type ReservationOutcome } from "./notified-log.js";
import { rememberPendingToasts, takePendingToasts } from "./pending-toasts.js";
import { awaitPanelDecision, type PanelDecision } from "./windows-panel.js";

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
  /** Identifiants des événements pour lesquels le hook a réellement retenu l'action. */
  blockedEventIds?: readonly string[];
  /** Sous-ensemble refusé fermement, que l'agent hôte ne peut pas contourner. */
  deniedEventIds?: readonly string[];
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

/** `dist/src/cli.js`, depuis n'importe quel module de `dist/src/notify/`. */
function commandLineInterfacePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

/**
 * Le geste que l'utilisateur peut faire depuis la notification.
 *
 * Réservé au refus ferme : c'est le seul moment où l'agent est arrêté et où
 * quelque chose attend réellement une réponse. Autoriser inscrit le sujet au
 * périmètre annoncé — cela n'exécute rien, et le tour de l'agent étant clos,
 * la confirmation doit dire qu'il reste à redemander l'action.
 */
export function buildAuthorization(
  root: string,
  event: SessionEvent,
): NotificationAuthorization | undefined {
  const scope = event.path ?? event.detail;
  if (scope === undefined || scope.trim() === "") return undefined;
  return {
    label: "Autoriser",
    exe: process.execPath,
    args: [commandLineInterfacePath(), "add-scope", "--cwd", root, scope],
    confirmation: "Autorisé. Redemandez l'action à l'agent : son tour a été arrêté.",
    failure: "L'autorisation a échoué. Passez par `driftlight add-scope`.",
  };
}

export function buildNotification(
  root: string,
  event: SessionEvent,
  config: DriftLightConfig,
  outcome: HookOutcome | boolean,
  intent: CurrentIntentState | null = null,
): NativeNotification {
  const icon = severityIconPath(event.level);
  const resolved: HookOutcome = typeof outcome === "boolean"
    ? outcome ? "asked" : "recorded"
    : outcome;
  return {
    // Une alerte qui retient une action doit rester visible jusqu'à ce qu'on
    // s'en occupe : elle attend une décision, elle n'informe pas au passage.
    ...(resolved === "recorded" ? {} : { persistent: true, tag: event.id }),
    attribution: "DriftLight — voyant local de dérive",
    title: notificationTitle(root, event, resolved),
    message: notificationMessage(root, event, intent),
    detail: notificationDetail(root, event, intent, resolved),
    level: event.level,
    ...(resolved === "denied"
      ? { halted: true, authorize: buildAuthorization(root, event) }
      : {}),
    sound: config.notificationSound,
    ...(icon ? { icon } : {}),
  };
}

/**
 * L'utilisateur peut-il être consulté sur place ?
 *
 * Le panneau est propre à Windows, et une suite de tests ne doit jamais faire
 * surgir de fenêtre bloquante sur la machine qui l'exécute. Partout ailleurs,
 * l'appelant retombe sur un refus sec.
 */
export function interactiveDecisionAvailable(environment: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "win32" && !notificationsDisabledByEnvironment(environment);
}

/**
 * Suspend l'appelant jusqu'à ce que l'utilisateur tranche, puis rend sa réponse.
 *
 * C'est le modèle de la fenêtre de permission de l'agent hôte : l'action est
 * retenue, la main revient à l'utilisateur, et l'agent repart de lui-même dès
 * qu'il a répondu. Un refus sec obtenait la retenue mais pas la reprise — il
 * fallait relancer l'agent à la main, ce que personne ne devrait avoir à faire.
 *
 * Ne rejette jamais et ne rend jamais rien : toute défaillance vaut refus.
 */
export async function askUserDecision(
  root: string,
  event: SessionEvent,
  config: DriftLightConfig,
  sessionId: string,
): Promise<PanelDecision> {
  try {
    let intent: CurrentIntentState | null = null;
    try {
      intent = readOwnCurrentIntentSync(root, sessionId);
    } catch {
      intent = null;
    }
    return await awaitPanelDecision(buildNotification(root, event, config, "denied", intent));
  } catch {
    return "deny";
  }
}

/**
 * Retire les alertes de cette session encore affichées.
 *
 * Appelée dès que la décision qu'elles attendaient est prise — l'outil a tourné,
 * le tour s'est terminé, un nouveau prompt est arrivé. Laisser une notification
 * réclamer une décision déjà rendue apprend à l'utilisateur à les ignorer, ce
 * qu'un voyant ne doit jamais enseigner.
 *
 * Ne rejette jamais : un retrait manqué laisse une notification de trop, ce qui
 * reste infiniment moins grave qu'un hook interrompu.
 */
export async function dismissPendingNotifications(
  root: string,
  sessionId: string,
  options: DispatchOptions = {},
): Promise<string[]> {
  try {
    if (notificationsDisabledByEnvironment(options.environment)) return [];
    const tags = takePendingToasts(root, sessionId);
    if (tags.length === 0) return [];
    const backend = await (options.loadBackend ?? loadNativeBackend)().catch(() => null);
    await backend?.dismiss?.(tags);
    return tags;
  } catch {
    return [];
  }
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
    const refused = new Set(options.deniedEventIds ?? []);
    const outcomeFor = (event: SessionEvent): HookOutcome =>
      refused.has(event.id) ? "denied" : blocked.has(event.id) ? "asked" : "recorded";
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

    const persistent: string[] = [];
    for (const event of pending) {
      if (!backend) {
        decisions.push({ eventId: event.id, level: event.level, outcome: "backend-unavailable" });
        continue;
      }
      try {
        const notification = buildNotification(root, event, config, outcomeFor(event), intent);
        await backend.send(notification);
        if (notification.tag) persistent.push(notification.tag);
        decisions.push({ eventId: event.id, level: event.level, outcome: "sent" });
      } catch {
        decisions.push({ eventId: event.id, level: event.level, outcome: "backend-unavailable" });
      }
    }
    rememberPendingToasts(root, sessionId, persistent);
    return decisions;
  } catch {
    return decisions;
  }
}
