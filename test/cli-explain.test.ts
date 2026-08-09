import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import type { SessionRecord } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";

test("driftlight explain prints the stored score decomposition", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-explain-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const timestamp = "2026-01-01T00:00:00.000Z";
  const snapshot = { capturedAt: timestamp, files: {}, manifests: {} };
  const session: SessionRecord = {
    schemaVersion: 1,
    id: "explain-session",
    source: "cli",
    cwd: root,
    startedAt: timestamp,
    intents: [],
    baseline: { isGit: false, root, branch: null, commit: null, capturedAt: timestamp, files: [] },
    initialSnapshot: snapshot,
    lastSnapshot: snapshot,
    events: [{
      id: "event-explain-cli",
      timestamp,
      type: "change",
      path: "src/unconnected.ts",
      changeKind: "modified",
      level: "ORANGE",
      reasons: ["Score cumulé"],
      codes: ["cumulative-score"],
      ruleId: "cumulative-score",
      scoreBreakdown: {
        mode: "scored",
        configVersion: "test-v1",
        score: 45,
        unclampedScore: 45,
        thresholds: { orange: 40, red: 70 },
        normalizationFactor: 1,
        signals: [{
          id: "importDistance",
          available: true,
          rawValue: "disconnected",
          normalizedValue: 1,
          weight: 30,
          contribution: 30,
          explanation: "Aucun chemin vers une ancre.",
        }],
        unavailableSignals: ["fileRarity"],
        verdict: "ORANGE",
      },
      expected: false,
    }],
    expectedEventIds: [],
  };
  await new SessionStore(root).save(session);

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  context.after(() => { console.log = originalLog; });
  await main(["explain", "event-explain-cli", "--cwd", root]);
  console.log = originalLog;

  assert.match(output.join("\n"), /event-explain-cli/);
  assert.match(output.join("\n"), /importDistance .* contribution 30/);
  assert.match(output.join("\n"), /Indisponibles : fileRarity/);
});
