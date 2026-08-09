import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImportGraph, RepositorySnapshot } from "../domain/types.js";
import { toPosixPath } from "../shared/paths.js";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface TsConfigAliases {
  directory: string;
  baseUrl: string;
  paths: Record<string, string[]>;
}

function stripJsonComments(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

async function loadTsConfig(root: string, filePath: string): Promise<TsConfigAliases | null> {
  try {
    const parsed = JSON.parse(stripJsonComments(await fs.readFile(path.join(root, filePath), "utf8"))) as {
      compilerOptions?: { baseUrl?: unknown; paths?: unknown };
    };
    const options = parsed.compilerOptions ?? {};
    const paths = options.paths && typeof options.paths === "object" && !Array.isArray(options.paths)
      ? Object.fromEntries(
          Object.entries(options.paths).filter(
            (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string"),
          ),
        )
      : {};
    return {
      directory: toPosixPath(path.posix.dirname(filePath)) === "." ? "" : toPosixPath(path.posix.dirname(filePath)),
      baseUrl: typeof options.baseUrl === "string" ? toPosixPath(options.baseUrl) : ".",
      paths,
    };
  } catch {
    return null;
  }
}

function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const staticPattern = /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicPattern = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticPattern, dynamicPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function resolveCandidate(candidate: string, nodes: Set<string>): string | null {
  const normalized = toPosixPath(path.posix.normalize(candidate)).replace(/^\.\//, "");
  const sourceVariants = normalized.endsWith(".js")
    ? [`${normalized.slice(0, -3)}.ts`, `${normalized.slice(0, -3)}.tsx`]
    : normalized.endsWith(".jsx")
      ? [`${normalized.slice(0, -4)}.tsx`]
      : normalized.endsWith(".mjs")
        ? [`${normalized.slice(0, -4)}.mts`]
        : normalized.endsWith(".cjs")
          ? [`${normalized.slice(0, -4)}.cts`]
          : [];
  const candidates = [
    normalized,
    ...sourceVariants,
    ...RESOLUTION_EXTENSIONS.map((extension) => `${normalized}${extension}`),
    ...RESOLUTION_EXTENSIONS.map((extension) => `${normalized}/index${extension}`),
  ];
  return candidates.find((item) => nodes.has(item)) ?? null;
}

function matchingAlias(specifier: string, aliases: TsConfigAliases): string[] {
  const candidates: string[] = [];
  for (const [alias, targets] of Object.entries(aliases.paths)) {
    const starIndex = alias.indexOf("*");
    const prefix = starIndex >= 0 ? alias.slice(0, starIndex) : alias;
    const suffix = starIndex >= 0 ? alias.slice(starIndex + 1) : "";
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const wildcard = starIndex >= 0 ? specifier.slice(prefix.length, specifier.length - suffix.length) : "";
    for (const target of targets) {
      const expanded = target.replace("*", wildcard);
      candidates.push(path.posix.join(aliases.directory, aliases.baseUrl, expanded));
    }
  }
  return candidates;
}

function aliasesForImporter(configs: TsConfigAliases[], importer: string): TsConfigAliases | null {
  return [...configs]
    .filter((config) => !config.directory || importer.startsWith(`${config.directory}/`))
    .sort((left, right) => right.directory.length - left.directory.length)[0] ?? null;
}

function resolveImport(
  importer: string,
  specifier: string,
  nodes: Set<string>,
  configs: TsConfigAliases[],
): string | null {
  if (specifier.startsWith(".")) {
    return resolveCandidate(path.posix.join(path.posix.dirname(importer), specifier), nodes);
  }
  const aliases = aliasesForImporter(configs, importer);
  if (!aliases) return null;
  for (const candidate of matchingAlias(specifier, aliases)) {
    const resolved = resolveCandidate(candidate, nodes);
    if (resolved) return resolved;
  }
  return null;
}

export function importGraphPath(root: string): string {
  return path.join(root, ".driftlight", "import-graph.json");
}

export function readImportGraphSync(root: string): ImportGraph | null {
  try {
    return JSON.parse(readFileSync(importGraphPath(root), "utf8")) as ImportGraph;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function buildImportGraph(root: string, snapshot: RepositorySnapshot): Promise<ImportGraph> {
  const nodes = Object.keys(snapshot.files).filter((filePath) => SOURCE_EXTENSION.test(filePath)).sort();
  const nodeSet = new Set(nodes);
  const tsconfigPaths = Object.keys(snapshot.files).filter((filePath) => /(^|\/)tsconfig(?:\.[^/]*)?\.json$/i.test(filePath));
  const configs = (await Promise.all(tsconfigPaths.map(async (filePath) => await loadTsConfig(root, filePath))))
    .filter((config): config is TsConfigAliases => config !== null);
  const edges: Record<string, string[]> = {};
  const unresolvedImports: Record<string, string[]> = {};

  await Promise.all(nodes.map(async (filePath) => {
    try {
      const source = await fs.readFile(path.join(root, ...filePath.split("/")), "utf8");
      const resolved = new Set<string>();
      const unresolved: string[] = [];
      for (const specifier of importSpecifiers(source)) {
        const target = resolveImport(filePath, specifier, nodeSet, configs);
        if (target) resolved.add(target);
        else if (specifier.startsWith(".") || matchingAlias(specifier, aliasesForImporter(configs, filePath) ?? { directory: "", baseUrl: ".", paths: {} }).length > 0) {
          unresolved.push(specifier);
        }
      }
      edges[filePath] = [...resolved].sort();
      if (unresolved.length > 0) unresolvedImports[filePath] = unresolved.sort();
    } catch {
      edges[filePath] = [];
    }
  }));

  const graph: ImportGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    unresolvedImports,
  };
  const target = importGraphPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return graph;
}
