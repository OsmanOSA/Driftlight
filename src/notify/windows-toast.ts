import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { NativeNotification } from "./backend.js";

const require = createRequire(import.meta.url);

/** Temps laissÃ© Ã  SnoreToast pour remettre le toast au centre de notifications. */
export const WINDOWS_TOAST_STARTUP_MS = 750;

export function windowsToastArguments(notification: NativeNotification): string[] {
  return [
    "-t",
    notification.title,
    "-m",
    notification.message,
    ...(notification.sound ? ["-s", "Notification.Default"] : ["-silent"]),
  ];
}

function snoreToastExecutable(): string {
  const packageRoot = path.dirname(require.resolve("node-notifier/package.json"));
  const architecture = process.arch === "ia32" ? "x86" : "x64";
  return path.join(packageRoot, "vendor", "snoreToast", `snoretoast-${architecture}.exe`);
}

/**
 * Affiche un toast Windows sans attendre que l'utilisateur le ferme.
 *
 * Le wrapper Windows de node-notifier crÃ©e toujours un named pipe et garde
 * SnoreToast vivant jusqu'Ã  la fermeture du toast. Dans un hook Codex, ce
 * descendant reste dans le job de commande et fait expirer PreToolUse. Nous
 * utilisons le binaire fourni par la mÃªme dÃ©pendance, sans shell, puis coupons
 * uniquement son processus aprÃ¨s que Windows a enregistrÃ© le toast.
 */
export async function showWindowsToast(notification: NativeNotification): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let killGuard: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout;
    const child = spawn(snoreToastExecutable(), windowsToastArguments(notification), {
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      if (killGuard) clearTimeout(killGuard);
      resolve();
    };
    child.once("error", finish);
    child.once("exit", finish);
    stopTimer = setTimeout(() => {
      child.kill();
      // Ne jamais garder le hook pour un processus Windows qui refuserait de mourir.
      killGuard = setTimeout(finish, 100);
    }, WINDOWS_TOAST_STARTUP_MS);
  });
}
