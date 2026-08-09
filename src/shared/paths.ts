import path from "node:path";

export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function relativeRepoPath(root: string, filePath: string): string {
  return toPosixPath(path.relative(root, filePath));
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function safeIdentifier(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
  return safe || "session";
}
