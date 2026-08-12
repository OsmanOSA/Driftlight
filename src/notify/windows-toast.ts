import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeNotification } from "./backend.js";

const require = createRequire(import.meta.url);

/** Temps laissé à SnoreToast pour remettre le toast au centre de notifications. */
export const WINDOWS_TOAST_STARTUP_MS = 750;

/** Budget du chemin riche. PowerShell démarre lentement ; l'échec doit rester rapide. */
export const WINDOWS_RICH_TOAST_BUDGET_MS = 8_000;

/**
 * Identité d'application par défaut.
 *
 * Windows n'affiche un toast que sous une identité qu'il connaît, déclarée par
 * un raccourci du menu Démarrer. Celle de SnoreToast est enregistrée dès son
 * premier envoi, ce qui la rend disponible sans rien installer nous-mêmes.
 * `driftlight notify install` en enregistre une au nom de DriftLight, et
 * DRIFTLIGHT_TOAST_APPID permet d'en imposer une autre.
 */
export const DEFAULT_TOAST_APP_ID = "Snore.DesktopToasts.0.7.0";
export const DRIFTLIGHT_TOAST_APP_ID = "DriftLight.Warning.Light";

const SUCCESS_MARKER = "DRIFTLIGHT_TOAST_OK";

export function toastAppId(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DRIFTLIGHT_TOAST_APPID;
  if (override && override.trim().length > 0) return override.trim();
  return installedShortcutPath() && existsSync(installedShortcutPath())
    ? DRIFTLIGHT_TOAST_APP_ID
    : DEFAULT_TOAST_APP_ID;
}

/** Raccourci portant notre identité, s'il a été installé explicitement. */
export function installedShortcutPath(environment: NodeJS.ProcessEnv = process.env): string {
  const roaming = environment.APPDATA ?? "";
  return path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "DriftLight.lnk");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Document de toast Windows.
 *
 * `scenario="reminder"` maintient la notification à l'écran jusqu'à ce que
 * l'utilisateur l'écarte : c'est le seul moyen documenté d'obtenir une présence
 * durable, `duration="long"` plafonnant à environ vingt-cinq secondes. Une
 * alerte rouge ne doit pas pouvoir disparaître pendant qu'on regarde ailleurs —
 * c'est précisément le moment où elle sert.
 *
 * Le bouton d'écart est activé par le système : aucun processus n'a besoin de
 * rester en vie pour le traiter, contrairement à une action applicative.
 */
export function buildToastXml(
  notification: NativeNotification,
  iconUri?: string,
): string {
  // ToastGeneric n'accepte que quatre éléments de texte, attribution comprise.
  // Au-delà, Windows rejette le document et n'affiche rien : le contenu passe
  // donc avant la signature, qui n'est ajoutée que s'il reste de la place.
  const TEXT_BUDGET = 4;
  const lines = notification.message.split("\n").filter((line) => line.trim().length > 0);
  const body = lines.slice(0, TEXT_BUDGET - 1);
  const image = iconUri
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(iconUri)}"/>`
    : "";
  const attribution = notification.attribution && body.length + 1 < TEXT_BUDGET
    ? `<text placement="attribution">${escapeXml(notification.attribution)}</text>`
    : "";
  const behaviour = notification.persistent ? 'scenario="reminder"' : 'duration="long"';
  const audio = notification.sound ? "" : '<audio silent="true"/>';

  return `<toast ${behaviour}>`
    + "<visual><binding template=\"ToastGeneric\">"
    + image
    + `<text>${escapeXml(notification.title)}</text>`
    + body.map((line) => `<text>${escapeXml(line)}</text>`).join("")
    + attribution
    + "</binding></visual>"
    + audio
    + '<actions><action activationType="system" arguments="dismiss" content="Ignorer"/></actions>'
    + "</toast>";
}

/**
 * SnoreToast n'affiche rien du tout si `-p` désigne un fichier absent. Le
 * chemin est donc revérifié ici, au plus près de l'appel : perdre la couleur
 * est acceptable, perdre l'alerte ne l'est pas.
 */
export function windowsToastArguments(notification: NativeNotification): string[] {
  const icon = notification.icon !== undefined && existsSync(notification.icon)
    ? ["-p", notification.icon]
    : [];
  return [
    "-t",
    notification.title,
    "-m",
    notification.message,
    ...icon,
    ...(notification.sound ? ["-s", "Notification.Default"] : ["-silent"]),
  ];
}

export function richToastScript(xml: string, appId: string): string {
  const payload = Buffer.from(xml, "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]",
    "$doc=New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
    "$toast=New-Object Windows.UI.Notifications.ToastNotification $doc",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId.replace(/'/g, "''")}').Show($toast)`,
    `Write-Output '${SUCCESS_MARKER}'`,
  ].join("\n");
}

function snoreToastExecutable(): string {
  const packageRoot = path.dirname(require.resolve("node-notifier/package.json"));
  const architecture = process.arch === "ia32" ? "x86" : "x64";
  return path.join(packageRoot, "vendor", "snoreToast", `snoretoast-${architecture}.exe`);
}

/**
 * Chemin riche : construit le toast nous-mêmes et le remet à Windows.
 *
 * Rend `false` sans lever si quoi que ce soit manque — PowerShell absent,
 * exécution restreinte par stratégie, identité d'application non enregistrée.
 * L'appelant retombe alors sur SnoreToast, qui enregistre justement cette
 * identité : la première alerte d'une machine neuve passe par le chemin sobre,
 * les suivantes par le chemin riche.
 */
async function showRichToast(notification: NativeNotification): Promise<boolean> {
  const iconUri = notification.icon !== undefined && existsSync(notification.icon)
    ? pathToFileURL(notification.icon).href
    : undefined;
  const script = richToastScript(buildToastXml(notification, iconUri), toastAppId());
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let output = "";
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(value);
    };
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const guard = setTimeout(() => {
      child.kill();
      finish(false);
    }, WINDOWS_RICH_TOAST_BUDGET_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0 && output.includes(SUCCESS_MARKER)));
  });
}

/**
 * Affiche un toast Windows sans attendre que l'utilisateur le ferme.
 *
 * Le wrapper Windows de node-notifier crée toujours un named pipe et garde
 * SnoreToast vivant jusqu'à la fermeture du toast. Dans un hook Codex, ce
 * descendant reste dans le job de commande et fait expirer PreToolUse. Nous
 * utilisons le binaire fourni par la même dépendance, sans shell, puis coupons
 * uniquement son processus après que Windows a enregistré le toast.
 */
export async function showWindowsToast(notification: NativeNotification): Promise<void> {
  if (await showRichToast(notification)) return;

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
