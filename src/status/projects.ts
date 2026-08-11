import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { readJsonState } from "../shared/read-state.js";
import { PROJECT_MARKER, driftlightHome } from "../shared/state-paths.js";

export interface ProjectSummary {
  /** Dossier d'état sous ~/.driftlight/projects. */
  directory: string;
  /** Dépôt d'origine, ou `null` si le marqueur est absent ou illisible. */
  root: string | null;
  /** Le dépôt existe-t-il encore sur le disque ? */
  present: boolean;
  sessions: number;
  lastActivity: string | null;
  /** Dernière dégradation enregistrée par le filet de sécurité du hook. */
  degraded: string | null;
  bytes: number;
}

export function projectsDirectory(): string {
  return path.join(driftlightHome(), "projects");
}

async function directorySize(target: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return await walk(absolute);
      try {
        total += (await fs.stat(absolute)).size;
      } catch {
        // Fichier disparu entre l'inventaire et la mesure.
      }
    }));
  };
  await walk(target);
  return total;
}

/**
 * L'empreinte du chemin n'est pas réversible : sans marqueur, un dossier d'état
 * serait inattribuable et donc impurgeable à jamais. Chaque session enregistre
 * pourtant sa racine — cette information suffit à rattacher le dossier, et le
 * marqueur est réécrit au passage pour que la question ne se repose plus.
 */
async function recoverRoot(directory: string, sessions: readonly string[]): Promise<string | null> {
  for (const name of sessions) {
    const session = await readJsonState<{ cwd?: unknown }>(path.join(directory, "sessions", name));
    if (typeof session?.cwd !== "string") continue;
    await fs.writeFile(
      path.join(directory, PROJECT_MARKER),
      `${JSON.stringify({ root: session.cwd, recoveredAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    ).catch(() => undefined);
    return session.cwd;
  }
  return null;
}

async function summarise(directory: string): Promise<ProjectSummary> {
  const marker = await readJsonState<{ root?: unknown }>(path.join(directory, PROJECT_MARKER));
  const health = await readJsonState<{ degraded?: unknown }>(path.join(directory, "hook-health.json"));

  let sessions: string[] = [];
  try {
    sessions = (await fs.readdir(path.join(directory, "sessions"))).filter((name) => name.endsWith(".json"));
  } catch {
    // Aucun historique enregistré pour ce projet.
  }

  const root = typeof marker?.root === "string" ? marker.root : await recoverRoot(directory, sessions);

  let lastActivity: string | null = null;
  for (const name of sessions) {
    try {
      const stat = await fs.stat(path.join(directory, "sessions", name));
      const at = stat.mtime.toISOString();
      if (!lastActivity || at > lastActivity) lastActivity = at;
    } catch {
      // Session disparue pendant l'inventaire.
    }
  }

  return {
    directory,
    root,
    // Sans marqueur lisible, on ne peut pas conclure à l'absence : le dossier
    // est conservé et signalé, jamais supprimé sur une simple ignorance.
    present: root === null ? true : existsSync(root),
    sessions: sessions.length,
    lastActivity,
    degraded: typeof health?.degraded === "string" ? health.degraded : null,
    bytes: await directorySize(directory),
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(projectsDirectory());
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    names.map(async (name) => await summarise(path.join(projectsDirectory(), name))),
  );
  return summaries.sort((left, right) => (right.lastActivity ?? "").localeCompare(left.lastActivity ?? ""));
}

/**
 * Ne supprime que l'état des dépôts qui n'existent plus. Un projet simplement
 * inactif garde son historique : l'ancienneté n'est pas une preuve d'abandon,
 * et l'historique est ce qui permet de calibrer.
 */
export async function purgeVanishedProjects(
  options: { dryRun?: boolean } = {},
): Promise<ProjectSummary[]> {
  const vanished = (await listProjects()).filter((project) => !project.present);
  if (options.dryRun) return vanished;
  for (const project of vanished) {
    await fs.rm(project.directory, { recursive: true, force: true }).catch(() => undefined);
  }
  return vanished;
}

/** Temporaires laissés par une écriture interrompue, sans cible correspondante. */
export async function sweepStaleTemporaries(): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.name.endsWith(".tmp")) {
        await fs.rm(absolute, { force: true }).catch(() => undefined);
        removed.push(absolute);
      }
    }
  };
  await walk(projectsDirectory());
  return removed;
}
