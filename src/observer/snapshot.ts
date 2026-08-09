import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ObservedChange,
  PackageManifestSnapshot,
  RepositorySnapshot,
} from "../domain/types.js";
import { hashFile } from "../shared/hash.js";
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

export async function scanRepository(
  root: string,
  options: ScanOptions = {},
): Promise<RepositorySnapshot> {
  const files: RepositorySnapshot["files"] = {};
  const manifests: RepositorySnapshot["manifests"] = {};
  const excluded = options.excludeDirectories ?? EXCLUDED_DIRECTORIES;

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
          if (!excluded.has(entry.name)) await walk(absolutePath);
          return;
        }
        if (!entry.isFile()) return;

        try {
          const stat = await fs.stat(absolutePath);
          const relativePath = relativeRepoPath(root, absolutePath);
          files[relativePath] = { hash: await hashFile(absolutePath), size: stat.size };
          if (entry.name === "package.json") {
            manifests[relativePath] = await readManifest(absolutePath);
          }
        } catch {
          // The file may disappear between readdir and hashing. The next scan resolves it.
        }
      }),
    );
  }

  await walk(path.resolve(root));
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
