import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ObservedChange, RepositorySnapshot, SessionRecord } from "../src/domain/types.js";
import { writeCurrentIntent } from "../src/intent/current-intent.js";
import { processChanges } from "../src/session/service.js";

function snapshot(paths: string[]): RepositorySnapshot {
  return {
    capturedAt: new Date().toISOString(),
    files: Object.fromEntries(paths.map((filePath) => [filePath, { hash: `hash-${filePath}`, size: 1, lineCount: 1 }])),
    manifests: {},
  };
}

function additions(paths: string[], current: RepositorySnapshot): ObservedChange[] {
  return paths.map((filePath) => ({ path: filePath, kind: "created", after: current.files[filePath] }));
}

test("file-volume classification emits only once at the first threshold crossing", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-volume-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await writeCurrentIntent(root, "Refactor ordinary source files", { turnId: "turn-volume" });

  const empty = snapshot([]);
  const session: SessionRecord = {
    schemaVersion: 1,
    id: "volume-session",
    source: "cli",
    cwd: root,
    startedAt: new Date().toISOString(),
    intents: [],
    baseline: {
      isGit: true,
      root,
      branch: "main",
      commit: "abc",
      capturedAt: new Date().toISOString(),
      files: [],
    },
    initialSnapshot: empty,
    lastSnapshot: empty,
    events: [],
    expectedEventIds: [],
    agentReads: [],
  };

  const firstPaths = Array.from({ length: 16 }, (_, index) => `src/file-${index}.ts`);
  const firstSnapshot = snapshot(firstPaths);
  processChanges(session, additions(firstPaths, firstSnapshot), firstSnapshot);

  const ninthPath = "src/file-16.ts";
  const ninthSnapshot = snapshot([...firstPaths, ninthPath]);
  processChanges(session, additions([ninthPath], ninthSnapshot), ninthSnapshot);
  const tenthPath = "src/file-17.ts";
  const tenthSnapshot = snapshot([...firstPaths, ninthPath, tenthPath]);
  processChanges(session, additions([tenthPath], tenthSnapshot), tenthSnapshot);

  const volumeEvents = session.events.filter((event) => event.level !== "GREEN");
  assert.equal(volumeEvents.length, 1);
  assert.equal(volumeEvents[0]?.ruleId, "cumulative-score");
  assert.ok((volumeEvents[0]?.scoreBreakdown.signals.find((signal) => signal.id === "turnFileCount")?.contribution ?? 0) > 0);
});
