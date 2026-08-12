import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

export interface NotifierBackend {
  readonly name: string;
  send(notification: NativeNotification): Promise<void>;
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

export const loadNativeBackend: BackendLoader = async () => {
  if (!isBackendInstalled()) return null;
  return {
    name: BACKEND_MODULE,
    send: async (notification) => {
      // Détaché : l'appelant reprend la main tout de suite, et le processus
      // d'affichage survit à la fin du hook au lieu d'être tué avec lui.
      const child = spawn(process.execPath, [runnerPath(), JSON.stringify(notification)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {
        // Node introuvable ou spawn refusé : la notification est perdue, pas le verdict.
      });
      child.unref();
    },
  };
};
