import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { GitBaseline, GitChangeKind, GitFileState } from "../domain/types.js";
import { hashBuffer } from "../shared/hash.js";
import { toPosixPath } from "../shared/paths.js";

function gitText(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

function gitRawText(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function classifyGitStatus(status: string): GitChangeKind {
  if (status === "??") return "untracked";
  if (status.includes("D")) return "deleted";
  if (status.includes("R") || status.includes("C")) return "renamed";
  if (status.includes("A")) return "added";
  return "modified";
}

export function parsePorcelainV1(output: string): Array<Pick<GitFileState, "path" | "status" | "kind">> {
  const chunks = output.split("\0");
  const entries: Array<Pick<GitFileState, "path" | "status" | "kind">> = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.length < 4) continue;

    const status = chunk.slice(0, 2);
    const filePath = toPosixPath(chunk.slice(3));
    entries.push({ path: filePath, status, kind: classifyGitStatus(status) });

    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return entries;
}

/** Résout seulement la racine Git, sans recalculer la baseline complète. */
export async function resolveGitRoot(cwd: string): Promise<string> {
  const root = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  return path.resolve(root || cwd);
}

export async function captureGitBaseline(cwd: string): Promise<GitBaseline> {
  const rootText = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const fallbackRoot = path.resolve(cwd);

  if (!rootText) {
    return {
      isGit: false,
      root: fallbackRoot,
      branch: null,
      commit: null,
      capturedAt: new Date().toISOString(),
      files: [],
    };
  }

  const root = path.resolve(rootText);
  const statusOutput = await gitRawText(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  const parsed = parsePorcelainV1(statusOutput);

  const files: GitFileState[] = await Promise.all(parsed.map(async (entry) => {
    const absolutePath = path.join(root, ...entry.path.split("/"));
    const [workingBuffer, headBuffer] = await Promise.all([
      existsSync(absolutePath) ? fs.readFile(absolutePath).catch(() => null) : Promise.resolve(null),
      gitBuffer(root, ["show", `HEAD:${entry.path}`]),
    ]);

    return {
      ...entry,
      ...(workingBuffer ? { workingHash: hashBuffer(workingBuffer) } : {}),
      ...(headBuffer ? { headHash: hashBuffer(headBuffer) } : {}),
    };
  }));

  const [branch, commit] = await Promise.all([
    gitText(root, ["branch", "--show-current"]),
    gitText(root, ["rev-parse", "HEAD"]),
  ]);

  return {
    isGit: true,
    root,
    branch: branch || null,
    commit: commit || null,
    capturedAt: new Date().toISOString(),
    files,
  };
}
