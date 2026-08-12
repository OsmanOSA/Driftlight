import { existsSync } from "node:fs";
import { dismissWindowsToasts, showWindowsToast } from "./windows-toast.js";

/**
 * Processus détaché qui affiche une notification native, puis s'éteint.
 *
 * Il existe parce que la bibliothèque garde son processus d'affichage rattaché
 * au sien : sous Windows, SnoreToast meurt dès que son parent se termine, et
 * maintient ce parent en vie tant que le toast est affiché (~9 s mesurées).
 * Attendre depuis un hook Claude Code coûterait donc plusieurs secondes par
 * alerte, pour un timeout de hook fixé à 10 s.
 *
 * Ce lanceur est détaché du hook : celui-ci rend son verdict immédiatement,
 * pendant que la notification vit sa vie ici.
 */

interface NotifierLike {
  notify: (options: Record<string, unknown>, callback: (error: Error | null) => void) => unknown;
}

/**
 * Filet de sécurité : ce processus ne doit jamais devenir orphelin permanent.
 * Le chemin riche de Windows passe par PowerShell, dont le démarrage à froid
 * dépasse largement deux secondes ; le budget suit celui du toast lui-même.
 */
const MAX_LIFETIME_MS = process.platform === "win32" ? 12_000 : 2_000;

function isNotifierLike(value: unknown): value is NotifierLike {
  return typeof value === "object"
    && value !== null
    && typeof (value as NotifierLike).notify === "function";
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) return;

  const payload = JSON.parse(raw) as {
    title?: string;
    message?: string;
    sound?: boolean;
    icon?: string;
    persistent?: boolean;
    attribution?: string;
    tag?: string;
    dismiss?: string[];
  };

  if (Array.isArray(payload.dismiss)) {
    if (process.platform === "win32") {
      await dismissWindowsToasts(payload.dismiss);
      return;
    }
    // macOS : terminal-notifier retire par identifiant de groupe.
    const module: unknown = await import("node-notifier");
    const target = isNotifierLike(module) ? module : (module as { default?: unknown }).default;
    if (!isNotifierLike(target)) return;
    for (const tag of payload.dismiss) {
      await new Promise<void>((resolve) => target.notify({ remove: tag }, () => resolve()));
    }
    return;
  }
  const notification = {
    title: payload.title ?? "DriftLight",
    message: payload.message ?? "",
    sound: payload.sound ?? true,
    ...(payload.persistent === true ? { persistent: true } : {}),
    ...(payload.attribution ? { attribution: payload.attribution } : {}),
    ...(payload.tag ? { tag: payload.tag } : {}),
    ...(payload.icon !== undefined && existsSync(payload.icon) ? { icon: payload.icon } : {}),
  };
  if (process.platform === "win32") {
    await showWindowsToast(notification);
    return;
  }

  const imported: unknown = await import("node-notifier");
  const notifier = isNotifierLike(imported) ? imported : (imported as { default?: unknown }).default;
  if (!isNotifierLike(notifier)) return;

  const guard = setTimeout(() => process.exit(0), MAX_LIFETIME_MS);

  // macOS affiche titre, sous-titre et corps sur trois lignes distinctes. La
  // première ligne du message y gagne à devenir le sous-titre : le corps reste
  // alors lisible sans être écrasé par le chemin du fichier.
  const [subtitle, ...body] = notification.message.split("\n");
  notifier.notify(
    {
      title: notification.title,
      ...(process.platform === "darwin" && body.length > 0
        ? { subtitle, message: body.join("\n") }
        : { message: notification.message }),
      sound: notification.sound,
      // Le groupe est l'identifiant par lequel macOS retire une notification :
      // sans lui, une alerte affichée ne peut plus être rappelée.
      ...(notification.tag ? { group: notification.tag } : {}),
      ...(notification.icon ? { icon: notification.icon, contentImage: notification.icon } : {}),
      wait: false,
    },
    () => {
      clearTimeout(guard);
      process.exit(0);
    },
  );
}

// Aucune sortie, aucun code d'erreur : personne n'écoute ce processus.
void main().catch(() => process.exit(0));
