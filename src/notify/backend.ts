import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Severity } from "../domain/types.js";
import type { NotificationDetail } from "./message.js";

/**
 * Adaptateur vers la bibliothèque de notifications natives.
 *
 * La bibliothèque n'est jamais requise : DriftLight doit rester utilisable si
 * elle est absente, cassée ou silencieuse. Rien ici ne rejette ni ne bloque.
 *
 * node-notifier est le backend retenu (SnoreToast sous Windows,
 * NSUserNotification sous macOS, même appel des deux côtés). `toasted-notifier`
 * est un fork à l'API identique : le remplacer se limite à changer
 * BACKEND_MODULE, ici et dans notify-runner.ts.
 */

const BACKEND_MODULE = "node-notifier";

/**
 * Ce qu'un bouton de la notification déclenche réellement.
 *
 * Autoriser n'exécute pas l'action refusée : cela inscrit le sujet au périmètre
 * annoncé, de sorte qu'une nouvelle tentative passe. Le tour de l'agent, lui,
 * est déjà clos — rien ne peut le relancer depuis l'extérieur, et `confirmation`
 * doit donc dire à l'utilisateur qu'il lui reste à redemander l'action.
 */
export interface NotificationAuthorization {
  label: string;
  exe: string;
  args: string[];
  confirmation: string;
  failure: string;
}

export interface NativeNotification {
  title: string;
  message: string;
  sound: boolean;
  /** Pastille de sévérité. Facultative : voir notify/icons.ts. */
  icon?: string;
  /**
   * Gravité de l'alerte. Elle choisit la surface d'affichage sous Windows, et
   * évite d'avoir à la déduire du nom d'un fichier d'icône ou d'un titre.
   */
  level?: Severity;
  /**
   * Maintient la notification à l'écran jusqu'à ce que l'utilisateur l'écarte.
   * Réservé aux alertes qui retiennent une action : disparaître pendant qu'on
   * regarde ailleurs est précisément ce qu'elles ne doivent pas faire.
   */
  persistent?: boolean;
  /** Ligne discrète en pied de notification, sous le corps du message. */
  attribution?: string;
  /**
   * Étiquette permettant de retirer la notification plus tard. Sans elle, une
   * alerte persistante ne peut plus être rappelée une fois affichée.
   */
  tag?: string;
  /**
   * Même alerte, en champs séparés. Les backends qui ne savent afficher que du
   * texte l'ignorent et s'en tiennent à `message` ; le panneau Windows s'en sert
   * pour dessiner une hiérarchie plutôt qu'empiler des lignes.
   */
  detail?: NotificationDetail;
  /**
   * Décision que l'utilisateur peut rendre depuis la notification elle-même.
   *
   * N'accompagne que le refus ferme : c'est le seul cas où l'agent est arrêté
   * et où quelque chose attend vraiment une réponse. Une notification qui
   * n'interrompt rien n'a pas à proposer de trancher.
   *
   * La commande est transportée décomposée — exécutable et arguments séparés —
   * pour qu'aucun chemin ni texte d'alerte n'ait à traverser un interpréteur.
   */
  authorize?: NotificationAuthorization;
  /** Accusé de démarrage interne du panneau de prévisualisation Windows. */
  readyFile?: string;
}

export interface NotifierBackend {
  readonly name: string;
  send(notification: NativeNotification): Promise<void>;
  /** Retire des notifications déjà affichées, désignées par leur étiquette. */
  dismiss?(tags: readonly string[]): Promise<void>;
}

export type BackendLoader = () => Promise<NotifierBackend | null>;

const require = createRequire(import.meta.url);

/**
 * Vérifie que la bibliothèque est installée sans la charger : résoudre le module
 * suffit, et évite de payer son initialisation quand elle est absente.
 */
function isBackendInstalled(): boolean {
  try {
    require.resolve(BACKEND_MODULE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Relecture d'une notification remise au processus d'affichage.
 *
 * Elle vit à côté de son envoi, et non dans le lanceur : recopier champ par
 * champ à distance de la structure d'origine en fait oublier, et un champ
 * oublié ne casse rien de visible — il dégrade l'affichage en silence. La
 * notification arrive quand même, simplement moins bien.
 */
export function notificationFromPayload(payload: Partial<NativeNotification>): NativeNotification {
  return {
    title: payload.title ?? "DriftLight",
    message: payload.message ?? "",
    sound: payload.sound ?? true,
    ...(payload.level ? { level: payload.level } : {}),
    ...(payload.detail ? { detail: payload.detail } : {}),
    ...(payload.authorize ? { authorize: payload.authorize } : {}),
    ...(payload.persistent === true ? { persistent: true } : {}),
    ...(payload.attribution ? { attribution: payload.attribution } : {}),
    ...(payload.tag ? { tag: payload.tag } : {}),
    ...(payload.readyFile ? { readyFile: payload.readyFile } : {}),
    // Seule vérification qui doit rester tardive : SnoreToast n'affiche rien du
    // tout si l'icône a disparu entre l'envoi et l'affichage.
    ...(payload.icon !== undefined && existsSync(payload.icon) ? { icon: payload.icon } : {}),
  };
}

function runnerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "notify-runner.js");
}

/**
 * Détaché : l'appelant reprend la main tout de suite, et le processus
 * d'affichage survit à la fin du hook au lieu d'être tué avec lui.
 */
function runDetached(payload: unknown): void {
  const child = spawn(process.execPath, [runnerPath(), JSON.stringify(payload)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // Node introuvable ou spawn refusé : la notification est perdue, pas le verdict.
  });
  child.unref();
}

export const loadNativeBackend: BackendLoader = async () => {
  // Le panneau WPF Windows ne dépend pas de node-notifier. La dépendance reste
  // nécessaire ailleurs et fournit le dernier repli SnoreToast sous Windows.
  if (process.platform !== "win32" && !isBackendInstalled()) return null;
  return {
    name: BACKEND_MODULE,
    send: async (notification) => runDetached(notification),
    dismiss: async (tags) => {
      if (tags.length > 0) runDetached({ dismiss: [...tags] });
    },
  };
};
