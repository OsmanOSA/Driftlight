import type { ClassificationInput, PackageManifestSnapshot } from "../domain/types.js";
import { toPosixPath } from "../shared/paths.js";

const SECTIONS: ReadonlyArray<keyof PackageManifestSnapshot> = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function manifestFromContent(content: string | undefined): PackageManifestSnapshot | null {
  if (content === undefined) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      dependencies: stringRecord(parsed.dependencies),
      devDependencies: stringRecord(parsed.devDependencies),
      optionalDependencies: stringRecord(parsed.optionalDependencies),
      peerDependencies: stringRecord(parsed.peerDependencies),
    };
  } catch {
    return null;
  }
}

export interface DependencyChange {
  available: boolean;
  added: string[];
}

/** Un changement de version conserve la même clé et n'apparaît donc jamais ici. */
export function dependencyAdditions(input: ClassificationInput): DependencyChange {
  const filePath = toPosixPath(input.change.path);
  const before = input.initialSnapshot.manifests[filePath];
  const proposed = manifestFromContent(input.operation?.proposedContent);
  const after = proposed ?? input.currentSnapshot.manifests[filePath];
  if (!before || !after) return { available: false, added: [] };
  const added = new Set<string>();
  for (const section of SECTIONS) {
    for (const name of Object.keys(after[section])) {
      if (!Object.hasOwn(before[section], name)) added.add(name);
    }
  }
  return { available: true, added: [...added].sort() };
}
