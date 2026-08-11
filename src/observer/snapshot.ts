import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ObservedChange,
  PackageManifestSnapshot,
  RepositorySnapshot,
} from "../domain/types.js";
import { inspectFile } from "../shared/hash.js";
import { relativeRepoPath } from "../shared/paths.js";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".driftlight",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  "target",
]);

function emptyManifest(): PackageManifestSnapshot {
  return {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function readManifest(filePath: string): Promise<PackageManifestSnapshot> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    return {
      dependencies: stringRecord(parsed.dependencies),
      devDependencies: stringRecord(parsed.devDependencies),
      optionalDependencies: stringRecord(parsed.optionalDependencies),
      peerDependencies: stringRecord(parsed.peerDependencies),
    };
  } catch {
    return emptyManifest();
  }
}

export interface ScanOptions {
  excludeDirectories?: ReadonlySet<string>;
}

/**
 * Répertoires que `.gitignore` exclut entièrement, demandés à Git.
 *
 * La liste d'exclusions en dur ne connaît que huit dossiers. Elle suffisait sur
 * un dépôt choisi ; installée sur toute la machine, elle ferait parcourir et
 * hacher `.venv/`, `vendor/`, `Library/` ou `build/` à chaque appel d'outil.
 *
 * Seuls les *répertoires* sont élagués, jamais les fichiers. Un fichier ignoré
 * isolé reste observé — `.env` l'est dans presque tous les projets, et c'est
 * précisément la catégorie que DriftLight doit protéger. `--directory` demande
 * à Git de replier un dossier entièrement ignoré en une seule entrée au lieu de
 * l'énumérer, ce qui est aussi ce qui rend l'appel bon marché.
 */
function listIgnoredDirectories(root: string): Promise<ReadonlySet<string>> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(new Set(
        error ? [] : stdout.split("\0").filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)),
      )),
    );
  });
}

export async function scanRepository(
  root: string,
  options: ScanOptions = {},
): Promise<RepositorySnapshot> {
  const files: RepositorySnapshot["files"] = {};
  const manifests: RepositorySnapshot["manifests"] = {};
  const excluded = options.excludeDirectories ?? EXCLUDED_DIRECTORIES;
  let ignoredDirectories: ReadonlySet<string> = new Set();

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const relative = relativeRepoPath(root, absolutePath);
          if (!excluded.has(entry.name) && !ignoredDirectories.has(relative)) await walk(absolutePath);
          return;
        }
        if (!entry.isFile()) return;

        await inspect(absolutePath, entry.name);
      }),
    );
  }

  async function inspect(absolutePath: string, name: string): Promise<void> {
    try {
      const stat = await fs.stat(absolutePath);
      const relativePath = relativeRepoPath(root, absolutePath);
      files[relativePath] = { ...await inspectFile(absolutePath), size: stat.size };
      if (name === "package.json") manifests[relativePath] = await readManifest(absolutePath);
    } catch {
      // Le fichier peut disparaître entre l'inventaire et la lecture — ou être
      // suivi par Git sans exister sur le disque. Le prochain scan tranche.
    }
  }

  const resolvedRoot = path.resolve(root);
  ignoredDirectories = options.excludeDirectories
    ? new Set()
    : await listIgnoredDirectories(resolvedRoot);
  await walk(resolvedRoot);
  return { capturedAt: new Date().toISOString(), files, manifests };
}

export function diffSnapshots(
  previous: RepositorySnapshot,
  current: RepositorySnapshot,
): ObservedChange[] {
  const paths = new Set([...Object.keys(previous.files), ...Object.keys(current.files)]);
  const changes: ObservedChange[] = [];

  for (const filePath of [...paths].sort()) {
    const before = previous.files[filePath];
    const after = current.files[filePath];
    if (!before && after) {
      changes.push({ path: filePath, kind: "created", after });
    } else if (before && !after) {
      changes.push({ path: filePath, kind: "deleted", before });
    } else if (before && after && before.hash !== after.hash) {
      changes.push({ path: filePath, kind: "modified", before, after });
    }
  }

  return changes;
}

export function addedDependencies(
  manifestPath: string,
  initial: RepositorySnapshot,
  current: RepositorySnapshot,
): string[] {
  const before = initial.manifests[manifestPath] ?? emptyManifest();
  const after = current.manifests[manifestPath] ?? emptyManifest();
  const sections: Array<keyof PackageManifestSnapshot> = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  const added = new Set<string>();

  for (const section of sections) {
    for (const name of Object.keys(after[section])) {
      if (!(name in before[section])) added.add(name);
    }
  }

  return [...added].sort();
}
