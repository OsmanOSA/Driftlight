import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DeterministicClassifier } from "../src/classification/deterministic-classifier.js";
import { classifyCommand } from "../src/classification/rules.js";
import { projectConfigPath, projectStateDirectory, projectStatePath } from "../src/shared/state-paths.js";
import type {
  AgentReadRecord,
  ChangeKind,
  ClassificationInput,
  GitBaseline,
  RepositorySnapshot,
} from "../src/domain/types.js";

const emptyBaseline: GitBaseline = {
  isGit: true,
  root: "/repo",
  branch: "main",
  commit: "abc",
  capturedAt: "2026-01-01T00:00:00.000Z",
  files: [],
};

const intentRoots: string[] = [];
after(() => {
  for (const root of intentRoots) rmSync(root, { recursive: true, force: true });
});

function intentRoot(task: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "driftlight-classifier-"));
  intentRoots.push(root);
  mkdirSync(projectStateDirectory(root), { recursive: true });
  writeFileSync(projectStatePath(root, "current-intent.json"), JSON.stringify({
    schemaVersion: 1,
    version: 1,
    turnId: `turn-${intentRoots.length}`,
    text: task,
    scopeAdditions: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  return root;
}

function snapshot(
  files: Record<string, string>,
  dependencies: Record<string, string> = {},
): RepositorySnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    files: Object.fromEntries(Object.entries(files).map(([name, hash]) => [name, { hash, size: 1 }])),
    manifests: Object.keys(files).includes("package.json")
      ? {
          "package.json": {
            dependencies,
            devDependencies: {},
            optionalDependencies: {},
            peerDependencies: {},
          },
        }
      : {},
  };
}

function input(
  task: string,
  filePath: string,
  kind: ChangeKind,
  options: {
    baseline?: GitBaseline;
    initial?: RepositorySnapshot;
    current?: RepositorySnapshot;
    changedFileCount?: number;
    readPathsThisTurn?: string[];
    readPathsPreviously?: string[];
    operation?: ClassificationInput["operation"];
    emittedRuleIds?: string[];
  } = {},
): ClassificationInput {
  const initial = options.initial ?? snapshot({ [filePath]: "before" });
  const current = options.current ?? (kind === "deleted" ? snapshot({}) : snapshot({ [filePath]: "after" }));
  const root = intentRoot(task);
  const currentTurnId = `turn-${intentRoots.length}`;
  const reads: AgentReadRecord[] = [
    ...(options.readPathsThisTurn ?? []).map((readPath) => ({
      path: readPath,
      turnId: currentTurnId,
      timestamp: "2026-01-01T00:00:00.000Z",
    })),
    ...(options.readPathsPreviously ?? []).map((readPath) => ({
      path: readPath,
      turnId: "previous-turn",
      timestamp: "2025-12-31T00:00:00.000Z",
    })),
  ];
  return {
    root,
    change: { path: filePath, kind, before: initial.files[filePath], after: current.files[filePath] },
    baseline: options.baseline ?? emptyBaseline,
    initialSnapshot: initial,
    currentSnapshot: current,
    changedFileCount: options.changedFileCount ?? 1,
    deletedFileCount: kind === "deleted" ? 1 : 0,
    agentReads: reads,
    emittedRuleIds: options.emittedRuleIds ?? [],
    ...(options.operation ? { operation: options.operation } : {}),
  };
}

test("the current turn can explicitly exonerate a package version and a named sensitive path", () => {
  const classifier = new DeterministicClassifier();
  const packageInitial = snapshot({ "playground/package.json": "before" });
  const packageCurrent = snapshot({ "playground/package.json": "after" });
  assert.equal(
    classifier.classify(input(
      "Change la version du projet de démonstration de 1.0.0 à 1.0.1 dans playground",
      "playground/package.json",
      "modified",
      { initial: packageInitial, current: packageCurrent },
    )).level,
    "GREEN",
  );
  assert.equal(
    classifier.classify(input(
      "Crée playground/.env.driftlight-test avec DRIFTLIGHT_DEMO=true",
      "playground/.env.driftlight-test",
      "created",
      { initial: snapshot({}), current: snapshot({ "playground/.env.driftlight-test": "after" }) },
    )).level,
    "GREEN",
  );
});

test("pre-existing work alerts only for destructive out-of-scope operations", () => {
  const classifier = new DeterministicClassifier();
  const modifiedBaseline: GitBaseline = {
    ...emptyBaseline,
    files: [{ path: "src/work.ts", status: " M", kind: "modified", headHash: "head", workingHash: "work" }],
  };

  const namedEdit = classifier.classify(input(
    "Continue src/work.ts",
    "src/work.ts",
    "modified",
    {
      baseline: modifiedBaseline,
      initial: snapshot({ "src/work.ts": "work" }),
      current: snapshot({ "src/work.ts": "new-work" }),
      operation: { kind: "edit" },
    },
  ));
  assert.equal(namedEdit.level, "GREEN");

  const readEdit = classifier.classify(input(
    "Fix another file",
    "src/work.ts",
    "modified",
    {
      baseline: modifiedBaseline,
      initial: snapshot({ "src/work.ts": "work" }),
      current: snapshot({ "src/work.ts": "new-work" }),
      readPathsThisTurn: ["src/work.ts"],
      operation: { kind: "edit" },
    },
  ));
  assert.equal(readEdit.level, "GREEN");

  const untrackedBaseline: GitBaseline = {
    ...emptyBaseline,
    files: [{ path: "notes.txt", status: "??", kind: "untracked", workingHash: "work" }],
  };
  const deleted = classifier.classify(input(
    "Fix another file",
    "notes.txt",
    "deleted",
    { baseline: untrackedBaseline, initial: snapshot({ "notes.txt": "work" }), current: snapshot({}) },
  ));
  assert.equal(deleted.level, "RED");
  assert.ok(deleted.codes.includes("preexisting-file-deleted"));
  assert.match(deleted.reasons[0] ?? "", /modifications non sauvegardées/i);
  assert.match(deleted.reasons[0] ?? "", /Annuler|historique local/i);

  const explicitlyDeleted = classifier.classify(input(
    "Supprime notes.txt",
    "notes.txt",
    "deleted",
    { baseline: untrackedBaseline, initial: snapshot({ "notes.txt": "work" }), current: snapshot({}) },
  ));
  assert.equal(explicitlyDeleted.level, "GREEN", "current intent must disable the pre-existing protection alert");

  const fullRewrite = classifier.classify(input(
    "Change something else",
    "src/work.ts",
    "modified",
    {
      baseline: modifiedBaseline,
      initial: snapshot({ "src/work.ts": "work" }),
      current: snapshot({ "src/work.ts": "rewritten" }),
      operation: { kind: "write" },
    },
  ));
  assert.equal(fullRewrite.level, "RED");
  assert.equal(fullRewrite.ruleId, "preexisting-file-rewritten");

  const previouslyReadNormalEdit = classifier.classify(input(
    "Change something else",
    "src/work.ts",
    "modified",
    {
      baseline: modifiedBaseline,
      initial: snapshot({ "src/work.ts": "work" }),
      current: snapshot({ "src/work.ts": "continued" }),
      readPathsPreviously: ["src/work.ts"],
      operation: { kind: "edit" },
    },
  ));
  assert.equal(previouslyReadNormalEdit.level, "GREEN");
});

test("the significant line-deletion threshold is configurable", () => {
  const classifier = new DeterministicClassifier();
  const baseline: GitBaseline = {
    ...emptyBaseline,
    files: [{ path: "src/work.ts", status: " M", kind: "modified", workingHash: "work" }],
  };
  const classificationInput = input(
    "Fix another file",
    "src/work.ts",
    "modified",
    {
      baseline,
      initial: snapshot({ "src/work.ts": "work" }),
      current: snapshot({ "src/work.ts": "trimmed" }),
      readPathsPreviously: ["src/work.ts"],
      operation: { kind: "edit", deletedLineCount: 3 },
    },
  );
  // La configuration reste dans le dépôt, contrairement à l'état dérivé.
  mkdirSync(path.dirname(projectConfigPath(classificationInput.root)), { recursive: true });
  writeFileSync(projectConfigPath(classificationInput.root), JSON.stringify({
    largeLineDeletionThreshold: 3,
  }));

  const result = classifier.classify(classificationInput);
  assert.equal(result.level, "ORANGE");
  assert.equal(result.ruleId, "destructive-edit");
});

test("destructive Git commands are observed as red and never auto-executed", () => {
  const findings = classifyCommand("git restore .", { ...emptyBaseline, files: [{ path: "work.ts", status: " M", kind: "modified" }] });
  assert.equal(findings[0]?.severity, "RED");
  assert.equal(findings[0]?.code, "destructive-git-command");
});

/**
 * Régression : effacer un dossier temporaire hors du dépôt allumait le rouge.
 * DriftLight surveille un périmètre, pas la machine entière.
 */
test("file deletion is only a signal when it can reach the observed repository", () => {
  const code = (command: string): string | undefined =>
    classifyCommand(command, emptyBaseline).find((finding) => finding.code === "destructive-file-command")?.code;

  assert.equal(code("rm -rf /tmp/build-cache"), undefined, "hors du dépôt : aucun signal");
  assert.equal(code("rm -rf src/generated"), "destructive-file-command", "dans le dépôt : signal");

  // Prudence : une cible non résolvable statiquement peut viser le dépôt.
  assert.equal(code("rm -rf \"$TMPDIR\""), "destructive-file-command", "variable shell : on reste prudent");
  assert.equal(code("rm -rf ../autre-projet"), "destructive-file-command", "remontée de chemin : on reste prudent");
  assert.equal(code("rm -rf"), "destructive-file-command", "sans cible explicite : on reste prudent");
});

test("PowerShell cleanup of an isolated temporary test directory stays silent", () => {
  const command = [
    '$taskState = Join-Path $env:TEMP ("driftlight-notification-tests-" + [guid]::NewGuid().ToString("N"))',
    'New-Item -ItemType Directory -Path $taskState | Out-Null',
    '$resolvedState = [IO.Path]::GetFullPath($taskState)',
    'Remove-Item -LiteralPath $resolvedState -Recurse -Force',
  ].join("\n");

  assert.equal(
    classifyCommand(command, emptyBaseline).find((finding) => finding.code === "destructive-file-command"),
    undefined,
  );
  assert.equal(
    classifyCommand('$taskState = Join-Path $env:TEMP $name\nRemove-Item -LiteralPath $taskState -Recurse -Force', emptyBaseline)[0]?.code,
    "destructive-file-command",
    "un enfant variable reste impossible à résoudre statiquement",
  );
});

test("command classification ignores dry-runs, branch checkout and heredoc bodies", () => {
  assert.deepEqual(classifyCommand("git clean -n", emptyBaseline), []);
  assert.deepEqual(classifyCommand("git clean -nfd", emptyBaseline), []);
  assert.deepEqual(classifyCommand("git checkout feature/my-branch", emptyBaseline), []);
  assert.deepEqual(classifyCommand("node <<'EOF'\ngit clean -fd\nEOF", emptyBaseline), []);
  assert.equal(classifyCommand("git clean -fd", emptyBaseline)[0]?.code, "destructive-git-command");
  assert.equal(classifyCommand("git checkout -- src/file.ts", emptyBaseline)[0]?.code, "destructive-git-command");
});
