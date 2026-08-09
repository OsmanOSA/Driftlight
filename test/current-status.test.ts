import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionEvent } from "../src/domain/types.js";
import {
  acknowledgeCurrentStatus,
  currentStatusPath,
  readCurrentStatusSync,
  recordCurrentStatus,
} from "../src/status/current-status.js";

function event(id: string, level: SessionEvent["level"], timestamp: string): SessionEvent {
  return {
    id,
    timestamp,
    type: "change",
    path: `${id}.txt`,
    changeKind: "modified",
    level,
    reasons: [id],
    codes: [id],
    ruleId: id,
    scoreBreakdown: {
      mode: "absolute",
      configVersion: "test",
      score: null,
      unclampedScore: null,
      thresholds: { orange: 40, red: 70 },
      normalizationFactor: 1,
      signals: [],
      unavailableSignals: [],
      verdict: level,
      absoluteRuleId: id,
    },
    expected: false,
  };
}

test("current status remains at the highest level until ack resets it", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-status-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));

  recordCurrentStatus(root, [
    event("ordinary", "GREEN", "2026-01-01T00:00:00.000Z"),
    event("manifest", "ORANGE", "2026-01-01T00:00:01.000Z"),
    event("secret", "RED", "2026-01-01T00:00:02.000Z"),
  ]);
  recordCurrentStatus(root, [event("later-green", "GREEN", "2026-01-01T00:00:03.000Z")]);

  const status = readCurrentStatusSync(root);
  assert.equal(status.level, "RED");
  assert.deepEqual(status.counts, { GREEN: 2, ORANGE: 1, RED: 1 });
  assert.equal(status.lastEventAt, "2026-01-01T00:00:03.000Z");
  assert.equal(status.acknowledgedAt, null);

  const acknowledged = await acknowledgeCurrentStatus(root);
  assert.equal(acknowledged.level, "GREEN");
  assert.deepEqual(acknowledged.counts, { GREEN: 0, ORANGE: 0, RED: 0 });
  assert.equal(acknowledged.lastEventAt, null);
  assert.ok(acknowledged.acknowledgedAt);
  assert.deepEqual(JSON.parse(await fs.readFile(currentStatusPath(root), "utf8")), acknowledged);
});
