import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export interface NativeNotification {
  title: string;
  message: string;
  sound: boolean;
  /** Pastille de sévérité. Facultative : voir notify/icons.ts. */
  icon?: string;
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
