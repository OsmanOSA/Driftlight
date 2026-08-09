import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scoreClassification } from "../src/classification/scoring-engine.js";
import { loadScoringConfigSync } from "../src/config/scoring-config.js";
import type {
  ClassificationInput,
  CurrentIntentState,
  ImportGraph,
  RepoProfile,
  RepositorySnapshot,
  SessionEvent,
} from "../src/domain/types.js";
import { scanRepository } from "../src/observer/snapshot.js";
import { buildImportGraph } from "../src/profile/import-graph.js";
import { buildRepoProfile, repoProfilePath } from "../src/profile/repo-profile.js";
import { formatScoreExplanation } from "../src/ui/terminal.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function snapshot(paths: string[]): RepositorySnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    files: Object.fromEntries(paths.map((filePath) => [filePath, { hash: filePath, size: 1, lineCount: 1 }])),
    manifests: {},
  };
}

function classificationInput(filePath: string): ClassificationInput {
  const repository = snapshot(["src/anchor.ts", "src/direct.ts", "src/unconnected.ts", filePath]);
  return {
    root: process.cwd(),
    change: {
      path: filePath,
      kind: "modified",
      before: repository.files[filePath],
      after: { hash: `${filePath}-after`, size: 1, lineCount: 1 },
    },
    baseline: {
      isGit: true,
      root: process.cwd(),
      branch: "main",
      commit: "abc",
      capturedAt: "2026-01-01T00:00:00.000Z",
      files: [],
    },
    initialSnapshot: repository,
    currentSnapshot: repository,
    changedFileCount: 1,
    deletedFileCount: 0,
    agentReads: [],
    emittedRuleIds: [],
    operation: { kind: "edit", deletedLineCount: 0 },
  };
}

function youngProfile(configRoot: string): RepoProfile {
  const config = loadScoringConfigSync(configRoot);
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    root: configRoot,
    commitCount: 12,
    modificationRates: {
      available: false,
      minimumCommits: 50,
      rates: {},
      touchCounts: {},
      reason: "Historique insuffisant : 12/50 commits.",
    },
    cooccurrence: {
      available: false,
      minimumCommits: 100,
      frequencies: {},
      reason: "Historique insuffisant : 12/100 commits.",
    },
    sensitivity: {
      gitignorePatterns: [],
      secretPathPatterns: [...config.secretPathPatterns],
      files: {},
    },
  };
}

function graph(): ImportGraph {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    nodes: ["src/anchor.ts", "src/direct.ts", "src/unconnected.ts"],
    edges: {
      "src/anchor.ts": ["src/direct.ts"],
      "src/direct.ts": [],
      "src/unconnected.ts": [],
    },
    unresolvedImports: {},
  };
}

function intent(text: string): CurrentIntentState {
  return {
    schemaVersion: 1,
    version: 1,
    turnId: "turn-score",
    text,
    scopeAdditions: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("young repositories expose unavailable history signals and renormalize without crashing", () => {
  const config = loadScoringConfigSync(process.cwd());
  const breakdown = scoreClassification(
    classificationInput("src/unconnected.ts"),
    intent("Fix src/anchor.ts"),
    youngProfile(process.cwd()),
    graph(),
    config,
  );

  assert.ok(breakdown.unavailableSignals.includes("fileRarity"));
  assert.ok(breakdown.unavailableSignals.includes("anchorCooccurrence"));
  assert.ok(breakdown.normalizationFactor > 1);
  assert.ok(Number.isFinite(breakdown.score ?? Number.NaN));
});

test("an explicitly named sensitive file remains green through its negative score", () => {
  const config = loadScoringConfigSync(process.cwd());
  const breakdown = scoreClassification(
    classificationInput(".env"),
    intent("Crée .env"),
    youngProfile(process.cwd()),
    graph(),
    config,
  );

  assert.equal(breakdown.verdict, "GREEN");
  assert.ok((breakdown.signals.find((signal) => signal.id === "explicitIntent")?.contribution ?? 0) < 0);
});

test("a disconnected file scores high while a direct dependency stays low", () => {
  const config = loadScoringConfigSync(process.cwd());
  const profile = youngProfile(process.cwd());
  const currentIntent = intent("Fix src/anchor.ts");
  const direct = scoreClassification(classificationInput("src/direct.ts"), currentIntent, profile, graph(), config);
  const disconnected = scoreClassification(classificationInput("src/unconnected.ts"), currentIntent, profile, graph(), config);

  assert.equal(direct.verdict, "GREEN");
  assert.ok((direct.score ?? 100) < config.thresholds.orange);
  assert.ok((disconnected.score ?? 0) >= config.thresholds.orange);
  assert.ok((disconnected.score ?? 0) > (direct.score ?? 0));
  assert.equal(disconnected.signals.find((signal) => signal.id === "importDistance")?.rawValue, "disconnected");
});

test("score contributions are coherent with explain output", () => {
  const config = loadScoringConfigSync(process.cwd());
  const breakdown = scoreClassification(
    classificationInput("src/unconnected.ts"),
    intent("Fix src/anchor.ts"),
    youngProfile(process.cwd()),
    graph(),
    config,
  );
  const contributionSum = breakdown.signals.reduce((sum, signal) => sum + signal.contribution, 0);
  assert.ok(Math.abs(contributionSum - (breakdown.unclampedScore ?? 0)) < 0.01);

  const event: SessionEvent = {
    id: "event-explain",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "change",
    path: "src/unconnected.ts",
    changeKind: "modified",
    level: breakdown.verdict,
    reasons: ["score"],
    codes: ["cumulative-score"],
    ruleId: "cumulative-score",
    scoreBreakdown: breakdown,
    expected: false,
  };
  const explanation = formatScoreExplanation(event);
  assert.match(explanation, /Score :/);
  assert.match(explanation, /importDistance .* brut disconnected .* poids 30 .* contribution/);
  assert.match(explanation, /Indisponibles : fileRarity, anchorCooccurrence/);
});

test("repo profile marks short history unavailable and import graph resolves tsconfig aliases", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-profile-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "*.secret\n");
  await fs.writeFile(path.join(root, "ignored.secret"), "TOKEN=local\n");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
  }));
  await fs.writeFile(path.join(root, "src", "anchor.ts"), 'import { direct } from "@lib/direct";\nconst lazy = import("@lib/lazy");\n');
  await fs.writeFile(path.join(root, "src", "lib", "direct.ts"), "export const direct = 1;\n");
  await fs.writeFile(path.join(root, "src", "lib", "lazy.ts"), "export const lazy = 1;\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  const repository = await scanRepository(root);
  const profile = await buildRepoProfile(root, repository, loadScoringConfigSync(root));
  const importGraph = await buildImportGraph(root, repository);
  assert.equal(profile.modificationRates.available, false);
  assert.equal(profile.cooccurrence.available, false);
  assert.deepEqual(profile.modificationRates.rates, {});
  assert.deepEqual(profile.cooccurrence.frequencies, {});
  assert.ok(profile.sensitivity.files["ignored.secret"]?.some((source) => source.startsWith("gitignore:")));
  assert.ok((await fs.stat(repoProfilePath(root))).isFile());
  assert.deepEqual(importGraph.edges["src/anchor.ts"], ["src/lib/direct.ts", "src/lib/lazy.ts"]);
});
