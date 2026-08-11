import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoProfile, RepositorySnapshot, ScoringConfig } from "../domain/types.js";
import { toPosixPath } from "../shared/paths.js";
import { projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomic } from "../shared/atomic-write.js";
import { readJsonStateSync } from "../shared/read-state.js";

function gitText(root: string, args: string[], maxBuffer = 100 * 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer,
    }).trim();
  } catch {
    return null;
  }
}

function parseCommitFiles(output: string): string[][] {
  return output
    .split("\x1e")
    .map((record) => [...new Set(
      record.split(/\r?\n/).map((line) => toPosixPath(line.trim())).filter(Boolean),
    )])
    .filter((files) => files.length > 0);
}

export function cooccurrenceKey(left: string, right: string): string {
  return JSON.stringify([left, right].sort());
}

function gitignoreRegex(pattern: string): RegExp | null {
  let value = toPosixPath(pattern.trim());
  if (!value || value.startsWith("#")) return null;
  if (value.startsWith("!")) value = value.slice(1);
  const anchored = value.startsWith("/");
  if (anchored) value = value.slice(1);
  const directory = value.endsWith("/");
  if (directory) value = value.slice(0, -1);
  const escaped = value
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*");
  const prefix = anchored || value.includes("/") ? "^" : "(^|/)";
  return new RegExp(`${prefix}${escaped}${directory ? "(?:/.*)?" : "(?:$|/)"}`);
}

export function matchingGitignorePattern(filePath: string, patterns: string[]): string | null {
  let matched: string | null = null;
  for (const pattern of patterns) {
    const regex = gitignoreRegex(pattern);
    if (!regex || !regex.test(filePath)) continue;
    matched = pattern.startsWith("!") ? null : pattern;
  }
  return matched;
}

export function sensitivitySourcesForPath(profile: RepoProfile, filePath: string): string[] {
  const normalized = toPosixPath(filePath);
  const sources: string[] = [];
  const ignoredBy = matchingGitignorePattern(normalized, profile.sensitivity.gitignorePatterns);
  if (ignoredBy) sources.push(`gitignore:${ignoredBy}`);
  for (const pattern of profile.sensitivity.secretPathPatterns) {
    try {
      if (new RegExp(pattern, "i").test(normalized)) sources.push(`secret-pattern:${pattern}`);
    } catch {
      // Invalid user patterns are ignored in the derived profile, never replaced by hidden defaults.
    }
  }
  return sources;
}

export function readGitignorePatterns(root: string): string[] {
  try {
    return readFileSync(path.join(root, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

export function repoProfilePath(root: string): string {
  return projectStatePath(root, "repo-profile.json");
}

export function readRepoProfileSync(root: string): RepoProfile | null {
  return readJsonStateSync<RepoProfile>(repoProfilePath(root));
}

export async function buildRepoProfile(
  root: string,
  snapshot: RepositorySnapshot,
  config: ScoringConfig,
): Promise<RepoProfile> {
  const sourceCommit = gitText(root, ["rev-parse", "HEAD"]);
  const configVersion = `${config.version}:${createHash("sha256")
    .update(JSON.stringify({
      secretPathPatterns: config.secretPathPatterns,
      minimumModificationCommits: config.signalParameters.minimumModificationCommits,
      minimumCooccurrenceCommits: config.signalParameters.minimumCooccurrenceCommits,
    }))
    .digest("hex")
    .slice(0, 12)}`;
  const cached = readRepoProfileSync(root);
  if (cached?.sourceCommit === sourceCommit && cached.configVersion === configVersion) return cached;
  const commitCount = Number(gitText(root, ["rev-list", "--count", "HEAD"]) ?? "0") || 0;
  const rateMinimum = config.signalParameters.minimumModificationCommits;
  const cooccurrenceMinimum = config.signalParameters.minimumCooccurrenceCommits;
  const enoughForRates = commitCount >= rateMinimum;
  const enoughForCooccurrence = commitCount >= cooccurrenceMinimum;
  const commits = enoughForRates
    ? parseCommitFiles(gitText(root, ["log", "--format=%x1e", "--name-only", "--no-renames"]) ?? "")
    : [];
  const touchCounts: Record<string, number> = {};
  for (const files of commits) {
    for (const filePath of files) touchCounts[filePath] = (touchCounts[filePath] ?? 0) + 1;
  }
  const rates = Object.fromEntries(
    Object.entries(touchCounts).map(([filePath, count]) => [filePath, count / commitCount]),
  );

  const pairCounts = new Map<string, number>();
  if (enoughForCooccurrence) {
    for (const files of commits) {
      const sorted = [...files].sort();
      for (let left = 0; left < sorted.length; left += 1) {
        for (let right = left + 1; right < sorted.length; right += 1) {
          const leftPath = sorted[left];
          const rightPath = sorted[right];
          if (!leftPath || !rightPath) continue;
          const key = cooccurrenceKey(leftPath, rightPath);
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const frequencies: Record<string, number> = {};
  for (const [key, together] of pairCounts) {
    const [left, right] = JSON.parse(key) as [string, string];
    const denominator = Math.min(touchCounts[left] ?? 0, touchCounts[right] ?? 0);
    if (denominator > 0) frequencies[key] = together / denominator;
  }

  const gitignorePatterns = readGitignorePatterns(root);
  const profile: RepoProfile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    sourceCommit,
    configVersion,
    commitCount,
    modificationRates: {
      available: enoughForRates,
      minimumCommits: rateMinimum,
      rates: enoughForRates ? rates : {},
      touchCounts: enoughForRates ? touchCounts : {},
      ...(!enoughForRates ? { reason: `Historique insuffisant : ${commitCount}/${rateMinimum} commits.` } : {}),
    },
    cooccurrence: {
      available: enoughForCooccurrence,
      minimumCommits: cooccurrenceMinimum,
      frequencies: enoughForCooccurrence ? frequencies : {},
      ...(!enoughForCooccurrence ? { reason: `Historique insuffisant : ${commitCount}/${cooccurrenceMinimum} commits.` } : {}),
    },
    sensitivity: {
      gitignorePatterns,
      secretPathPatterns: [...config.secretPathPatterns],
      files: {},
    },
  };
  for (const filePath of Object.keys(snapshot.files)) {
    const sources = sensitivitySourcesForPath(profile, filePath);
    if (sources.length > 0) profile.sensitivity.files[filePath] = sources;
  }

  await writeJsonAtomic(repoProfilePath(root), profile);
  return profile;
}

/** Lance le calcul Git hors du chemin critique du hook SessionStart. */
export function startRepoProfileBuild(root: string): void {
  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT !== undefined) return;
  try {
    const worker = fileURLToPath(new URL("./profile-worker.js", import.meta.url));
    const child = spawn(process.execPath, [worker, root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Le profil restera indisponible ; le classifieur se dégrade explicitement.
  }
}
