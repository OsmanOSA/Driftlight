import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GitBaseline, GitChangeKind, GitFileState } from "../domain/types.js";
import { hashBuffer } from "../shared/hash.js";
import { toPosixPath } from "../shared/paths.js";

function gitText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitRawText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function gitBuffer(cwd: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return null;
  }
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

export async function captureGitBaseline(cwd: string): Promise<GitBaseline> {
  const rootText = gitText(cwd, ["rev-parse", "--show-toplevel"]);
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
  const statusOutput = gitRawText(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  const parsed = parsePorcelainV1(statusOutput);

  const files: GitFileState[] = parsed.map((entry) => {
    const absolutePath = path.join(root, ...entry.path.split("/"));
    const workingBuffer = existsSync(absolutePath) ? gitBuffer(root, ["hash-object", "--no-filters", "--", absolutePath]) : null;
    const headBuffer = gitBuffer(root, ["show", `HEAD:${entry.path}`]);

    return {
      ...entry,
      ...(workingBuffer ? { workingHash: workingBuffer.toString("utf8").trim() } : {}),
      ...(headBuffer ? { headHash: hashBuffer(headBuffer) } : {}),
    };
  });

  return {
    isGit: true,
    root,
    branch: gitText(root, ["branch", "--show-current"]) || null,
    commit: gitText(root, ["rev-parse", "HEAD"]) || null,
    capturedAt: new Date().toISOString(),
    files,
  };
}
