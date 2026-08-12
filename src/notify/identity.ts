import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { appIconPath } from "./icons.js";
import { DRIFTLIGHT_TOAST_APP_ID, installedShortcutPath } from "./windows-toast.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Identité d'application Windows.
 *
 * Windows n'affiche une notification que sous une identité déclarée par un
 * raccourci du menu Démarrer, et c'est ce raccourci qui fournit le nom et
 * l'icône affichés en en-tête. Sans le nôtre, DriftLight emprunte celle de la
 * bibliothèque qui envoie le toast et s'annonce sous son nom — ce qui donne à
 * l'alerte l'air de venir d'un outil tiers.
 *
 * L'installation reste une commande explicite : elle écrit dans le menu
 * Démarrer de l'utilisateur, ce qu'un outil n'a pas à faire de lui-même. Elle
 * est réversible par `driftlight notify uninstall`.
 */

export interface IdentityStatus {
  supported: boolean;
  installed: boolean;
  shortcut: string;
  appId: string;
}

export function identityStatus(platform: NodeJS.Platform = process.platform): IdentityStatus {
  const shortcut = installedShortcutPath();
  return {
    supported: platform === "win32",
    installed: platform === "win32" && shortcut !== "" && existsSync(shortcut),
    shortcut,
    appId: DRIFTLIGHT_TOAST_APP_ID,
  };
}

function snoreToastExecutable(): string {
  const packageRoot = path.dirname(require.resolve("node-notifier/package.json"));
  const architecture = process.arch === "ia32" ? "x86" : "x64";
  return path.join(packageRoot, "vendor", "snoreToast", `snoretoast-${architecture}.exe`);
}

/** Pose l'icône du raccourci ; l'identité y survit, c'est vérifié par test. */
async function applyIcon(shortcut: string): Promise<boolean> {
  const icon = appIconPath("ico");
  if (!icon) return false;
  const script = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$sc = $ws.CreateShortcut('${shortcut.replace(/'/g, "''")}')`,
    `$sc.IconLocation = '${icon.replace(/'/g, "''")},0'`,
    "$sc.Description = 'DriftLight — voyant local de dérive'",
    "$sc.Save()",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
    return true;
  } catch {
    // Une icône manquante ne compromet pas l'identité, seulement son allure.
    return false;
  }
}

export async function installIdentity(): Promise<{ ok: boolean; detail: string }> {
  const status = identityStatus();
  if (!status.supported) {
    return { ok: false, detail: "Identité d'application propre à Windows ; rien à faire ici." };
  }
  try {
    await run(snoreToastExecutable(), [
      "-install",
      path.basename(status.shortcut),
      process.execPath,
      status.appId,
    ]);
  } catch (error) {
    return {
      ok: false,
      detail: `Le raccourci n'a pas pu être créé : ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!existsSync(status.shortcut)) {
    return { ok: false, detail: "Le raccourci n'existe pas après installation." };
  }
  const decorated = await applyIcon(status.shortcut);
  return {
    ok: true,
    detail: decorated
      ? `Identité installée : ${status.appId}`
      : `Identité installée : ${status.appId} (sans icône : asset introuvable)`,
  };
}

export async function removeIdentity(): Promise<{ ok: boolean; detail: string }> {
  const status = identityStatus();
  if (!status.supported) return { ok: false, detail: "Rien à retirer sur cette plateforme." };
  if (!status.installed) return { ok: true, detail: "Aucune identité installée." };
  await rm(status.shortcut, { force: true });
  return { ok: true, detail: "Identité retirée ; les notifications repassent par l'identité par défaut." };
}
