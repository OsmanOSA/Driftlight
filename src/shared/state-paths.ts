import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fichier qui rattache un dossier d'état au dépôt dont il provient. */
export const PROJECT_MARKER = "project.json";

/**
 * Racine de l'état DriftLight sur la machine. `DRIFTLIGHT_HOME` permet de
 * l'isoler — les tests s'en servent pour ne jamais écrire dans le vrai profil.
 */
export function driftlightHome(): string {
  const configured = process.env.DRIFTLIGHT_HOME;
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".driftlight");
}

/**
 * L'état contient les demandes de l'utilisateur et les commandes proposées.
 * Sur une machine partagée, les droits par défaut d'un dossier POSIX (0755)
 * les rendraient lisibles par les autres comptes locaux ; 0700 réserve la
 * lecture à son propriétaire. Windows ignore ce mode et applique les ACL du
 * profil, déjà privées.
 */
export const STATE_DIRECTORY_MODE = 0o700;

let homePrepared = false;

export function ensurePrivateHome(): string {
  const home = driftlightHome();
  if (homePrepared) return home;
  try {
    mkdirSync(home, { recursive: true, mode: STATE_DIRECTORY_MODE });
    if (process.platform !== "win32") chmodSync(home, STATE_DIRECTORY_MODE);
  } catch {
    // Un état non créable sera signalé par l'écriture qui suit, pas ici.
  }
  homePrepared = true;
  return home;
}

/** Nom lisible suivi d'une empreinte : deux `api/` distincts ne se mélangent pas. */
function projectSlug(root: string): string {
  const normalized = path.resolve(root).replaceAll("\\", "/").toLowerCase();
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const name = path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return `${name || "project"}-${digest}`;
}

/** Configuration du dépôt : écrite par l'humain, elle reste avec le projet. */
export function projectConfigPath(root: string): string {
  return path.join(path.resolve(root), ".driftlight", "config.json");
}

export function globalConfigPath(): string {
  return path.join(driftlightHome(), "config.json");
}

const resolvedDirectories = new Map<string, string>();

/**
 * Emplacement de l'état dérivé d'un projet — sessions, intention courante,
 * profil, graphe, journaux.
 *
 * Il vit hors du projet : en mode global le hook s'exécute dans n'importe quel
 * dépôt, et y déposer un dossier ferait apparaître DriftLight dans le
 * `git status` de chaque projet ouvert, avec un risque de commit accidentel.
 */
export function projectStateDirectory(root: string): string {
  const resolved = path.resolve(root);
  const cached = resolvedDirectories.get(resolved);
  if (cached) return cached;

  const central = path.join(ensurePrivateHome(), "projects", projectSlug(resolved));
  const legacy = path.join(resolved, ".driftlight");
  let chosen = central;

  if (!existsSync(central) && hasLegacyState(legacy) && !adoptLegacyState(legacy, central, resolved)) {
    // Reprise impossible : poursuivre sur l'historique hérité vaut mieux que
    // repartir d'un état vide.
    chosen = legacy;
  }
  if (chosen === central) ensureProjectMarker(central, resolved);

  resolvedDirectories.set(resolved, chosen);
  return chosen;
}

/**
 * Le marqueur dit à quel dépôt appartient un dossier d'état. Sans lui, le
 * stockage central n'est qu'une liste d'empreintes illisibles : impossible de
 * présenter les projets, ni de savoir lesquels ne correspondent plus à rien.
 */
function ensureProjectMarker(central: string, root: string): void {
  try {
    if (existsSync(path.join(central, PROJECT_MARKER))) return;
    mkdirSync(central, { recursive: true });
    writeFileSync(
      path.join(central, PROJECT_MARKER),
      `${JSON.stringify({ root, adoptedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Confort de diagnostic : son absence ne doit rien empêcher.
  }
}

/**
 * Copie puis efface. Le profil utilisateur et le dépôt vivent souvent sur des
 * volumes distincts — `C:` et `D:` sous Windows, un montage réseau ailleurs —
 * où renommer est impossible. Cet ordre garantit qu'aucune donnée n'est absente
 * des deux emplacements à un instant donné.
 */
export function copyThenRemove(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true });
  rmSync(source, { recursive: true, force: true });
}

/** Déplacement robuste : renommage quand le système le permet, copie sinon. */
export function relocateDirectory(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch {
    copyThenRemove(source, destination);
  }
}

/** Reprend l'état d'une installation antérieure rangée dans le dépôt. */
function adoptLegacyState(legacy: string, central: string, root: string): boolean {
  try {
    mkdirSync(path.dirname(central), { recursive: true });
    relocateDirectory(legacy, central);

    // La configuration a suivi l'état dans le déplacement : elle appartient au
    // dépôt et doit y revenir, sinon un réglage volontaire disparaîtrait.
    const movedConfig = path.join(central, "config.json");
    if (existsSync(movedConfig)) {
      mkdirSync(legacy, { recursive: true });
      cpSync(movedConfig, path.join(legacy, "config.json"));
      rmSync(movedConfig, { force: true });
    }

    writeFileSync(
      path.join(central, "project.json"),
      `${JSON.stringify({ root, adoptedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Un `.driftlight/` ne contenant qu'une configuration n'est pas un état à
 * déplacer : la configuration appartient au dépôt et doit y rester.
 */
function hasLegacyState(legacy: string): boolean {
  if (!existsSync(legacy)) return false;
  return ["sessions", "current-intent.json", "current-status.json", "repo-profile.json", "import-graph.json"]
    .some((entry) => existsSync(path.join(legacy, entry)));
}

export function projectStatePath(root: string, ...segments: string[]): string {
  return path.join(projectStateDirectory(root), ...segments);
}
