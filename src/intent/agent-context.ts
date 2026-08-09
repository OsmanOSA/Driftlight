import path from "node:path";
import { isInsideRoot, toPosixPath } from "../shared/paths.js";

function strings(value: unknown, output: string[], depth = 0): void {
  if (depth > 6 || output.length >= 2_000) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) strings(item, output, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) strings(item, output, depth + 1);
  }
}

function candidateTokens(value: string): string[] {
  const tokens = new Set<string>();
  const pattern = /[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+|(?:^|\s)(\.?[\w@-]+\.[A-Za-z][A-Za-z0-9.-]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const raw = (match[1] ?? match[0]).trim()
      .replace(/[,:;!?)}\]]+$/, "")
      .replace(/:\d+(?::\d+)?$/, "");
    if (raw) tokens.add(raw);
  }
  return [...tokens];
}

function relativeCandidate(root: string, candidate: string): string | null {
  const unquoted = candidate.replace(/^['"]|['"]$/g, "");
  const absolute = path.isAbsolute(unquoted) ? path.resolve(unquoted) : path.resolve(root, unquoted);
  if (!isInsideRoot(root, absolute)) return null;
  const relative = toPosixPath(path.relative(root, absolute));
  return relative && relative !== "." ? relative : null;
}

export function extractRepoPaths(root: string, value: unknown): string[] {
  const values: string[] = [];
  strings(value, values);
  const paths = new Set<string>();
  for (const text of values) {
    for (const candidate of candidateTokens(text)) {
      const relative = relativeCandidate(root, candidate);
      if (relative) paths.add(relative);
    }
  }
  return [...paths];
}

export function extractReadPaths(
  root: string,
  toolInput: unknown,
  toolResponse: unknown,
  knownPaths: readonly string[],
): string[] {
  const known = new Set(knownPaths.map(toPosixPath));
  return [...new Set([
    ...extractRepoPaths(root, toolInput),
    ...extractRepoPaths(root, toolResponse),
  ])].filter((filePath) => known.has(filePath));
}

export function extractDeclaredPlanPaths(root: string, toolInput: unknown): string[] {
  return extractRepoPaths(root, toolInput);
}

export function isReadLikeTool(toolName: string): boolean {
  return ["read", "read_file", "grep", "glob"].includes(toolName.toLowerCase());
}

export function isPlanTool(toolName: string): boolean {
  return ["todowrite", "update_plan", "updateplan", "write_todos"].includes(toolName.toLowerCase());
}
