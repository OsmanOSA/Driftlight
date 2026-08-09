import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DeterministicClassifier } from "../src/classification/deterministic-classifier.js";
import { classifyCommand } from "../src/classification/rules.js";
import type {
  ChangeKind,
  ClassificationInput,
  GitBaseline,
  RepositorySnapshot,
  Severity,
} from "../src/domain/types.js";

const emptyBaseline: GitBaseline = {
  isGit: true,
  root: "/repo",
  branch: "main",
  commit: "abc",
  capturedAt: "2026-01-01T00:00:00.000Z",
  files: [],
};

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
  } = {},
): ClassificationInput {
  const initial = options.initial ?? snapshot({ [filePath]: "before" });
  const current = options.current ?? (kind === "deleted" ? snapshot({}) : snapshot({ [filePath]: "after" }));
  return {
    task,
    scopeAdditions: [],
    change: { path: filePath, kind, before: initial.files[filePath], after: current.files[filePath] },
    baseline: options.baseline ?? emptyBaseline,
    initialSnapshot: initial,
    currentSnapshot: current,
    changedFileCount: options.changedFileCount ?? 1,
    deletedFileCount: kind === "deleted" ? 1 : 0,
  };
}

test("fixture scenarios classify deterministic drift", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "scenarios.json");
  const scenarios = JSON.parse(await readFile(fixturePath, "utf8")) as Array<{
    name: string;
    task: string;
    path: string;
    kind: ChangeKind;
    dependencies?: string[];
    expected: Severity;
  }>;
  const classifier = new DeterministicClassifier();

  for (const scenario of scenarios) {
    const before = scenario.path === "package.json" ? snapshot({ "package.json": "before" }) : undefined;
    const after = scenario.path === "package.json"
      ? snapshot(
          { "package.json": "after" },
          Object.fromEntries((scenario.dependencies ?? []).map((name) => [name, "1.0.0"])),
        )
      : undefined;
    assert.equal(
      classifier.classify(input(scenario.task, scenario.path, scenario.kind, { initial: before, current: after })).level,
      scenario.expected,
      scenario.name,
    );
  }
});

test("a newly added dependency is orange unless the task explicitly calls for it", () => {
  const classifier = new DeterministicClassifier();
  const initial = snapshot({ "package.json": "before" });
  const current = snapshot({ "package.json": "after" }, { stripe: "^20.0.0" });

  const drift = classifier.classify(input("Change a button color", "package.json", "modified", { initial, current }));
  const expected = classifier.classify(input("Install the Stripe dependency", "package.json", "modified", { initial, current }));

  assert.equal(drift.level, "ORANGE");
  assert.ok(drift.codes.includes("new-dependency"));
  assert.equal(expected.level, "GREEN");
});

test("restoring or deleting pre-existing work is red", () => {
  const classifier = new DeterministicClassifier();
  const modifiedBaseline: GitBaseline = {
    ...emptyBaseline,
    files: [{ path: "src/work.ts", status: " M", kind: "modified", headHash: "head", workingHash: "work" }],
  };
  const restored = classifier.classify(input(
    "Fix another file",
    "src/work.ts",
    "modified",
    {
      baseline: modifiedBaseline,
      initial: snapshot({ "src/work.ts": "work" }),
      current: snapshot({ "src/work.ts": "head" }),
    },
  ));
  assert.equal(restored.level, "RED");
  assert.ok(restored.codes.includes("preexisting-change-restored"));

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
});

test("configuration, secrets, infrastructure, deletion and amplitude are covered", () => {
  const classifier = new DeterministicClassifier();
  assert.equal(classifier.classify(input("Fix typo", "vite.config.ts", "modified")).level, "ORANGE");
  assert.equal(classifier.classify(input("Fix typo", ".env.local", "modified")).level, "RED");
  assert.equal(classifier.classify(input("Fix typo", "infra/main.tf", "modified")).level, "RED");
  assert.equal(classifier.classify(input("Fix typo", "src/old.ts", "deleted")).level, "ORANGE");
  assert.equal(classifier.classify(input("Refactor", "src/a.ts", "modified", { changedFileCount: 8 })).level, "ORANGE");
  assert.equal(classifier.classify(input("Refactor", "src/a.ts", "modified", { changedFileCount: 20 })).level, "RED");
  const massDeletion = input("Cleanup", "src/a.ts", "deleted");
  massDeletion.deletedFileCount = 5;
  assert.equal(classifier.classify(massDeletion).level, "RED");
  assert.ok(classifier.classify(massDeletion).codes.includes("mass-deletion"));
});

test("destructive Git commands are observed as red and never auto-executed", () => {
  const findings = classifyCommand("git restore .", { ...emptyBaseline, files: [{ path: "work.ts", status: " M", kind: "modified" }] });
  assert.equal(findings[0]?.severity, "RED");
  assert.equal(findings[0]?.code, "destructive-git-command");
});
