import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFeedbackStats } from "../src/classification/feedback-stats.js";
import type { SessionRecord } from "../src/domain/types.js";
import { markEventFeedback } from "../src/session/service.js";
import { formatSessionSummary, formatSignal } from "../src/ui/terminal.js";

function breakdown(level: "GREEN" | "ORANGE" | "RED", ruleId: string) {
  return {
    mode: "absolute" as const,
    configVersion: "test",
    score: null,
    unclampedScore: null,
    thresholds: { orange: 40, red: 70 },
    normalizationFactor: 1,
    signals: [],
    unavailableSignals: [],
    verdict: level,
    absoluteRuleId: ruleId,
  };
}

function sessionFixture(root = "/repo"): SessionRecord {
  const snapshot = { capturedAt: "2026-01-01T00:00:00.000Z", files: {}, manifests: {} };
  const initial = { version: 1, text: "Fix typo", source: "initial" as const, addedAt: "2026-01-01T00:00:00.000Z" };
  return {
    schemaVersion: 1,
    id: "feedback-session",
    source: "cli",
    cwd: root,
    startedAt: "2026-01-01T00:00:00.000Z",
    intents: [initial],
    currentIntent: initial,
    baseline: { isGit: true, root: "/repo", branch: "main", commit: "abcdef12", capturedAt: initial.addedAt, files: [] },
    initialSnapshot: snapshot,
    lastSnapshot: snapshot,
    expectedEventIds: [],
    events: [
      { id: "green", timestamp: initial.addedAt, type: "change", path: "README.md", changeKind: "modified", level: "GREEN", reasons: ["ok"], codes: ["within-scope"], ruleId: "within-scope", scoreBreakdown: breakdown("GREEN", "within-scope"), expected: false },
      { id: "orange", timestamp: initial.addedAt, type: "change", path: "package.json", changeKind: "modified", level: "ORANGE", reasons: ["manifest"], codes: ["package-manifest"], ruleId: "package-manifest", scoreBreakdown: breakdown("ORANGE", "package-manifest"), expected: false },
      { id: "red", timestamp: initial.addedAt, type: "change", path: ".env", changeKind: "created", level: "RED", reasons: ["secret"], codes: ["environment-or-secret"], ruleId: "environment-or-secret", scoreBreakdown: breakdown("RED", "environment-or-secret"), expected: false },
    ],
  };
}

test("feedback marks alerts and the summary hides green events", () => {
  const session = sessionFixture();
  assert.equal(markEventFeedback(session, "orange", "noise")?.feedback, "noise");
  assert.equal(markEventFeedback(session, "red", "useful")?.feedback, "useful");
  assert.equal(markEventFeedback(session, "green", "useful"), null);

  const summary = formatSessionSummary(session);
  assert.doesNotMatch(summary, /README\.md/);
  assert.match(summary, /Alertes : 2/);
  assert.match(summary, /utiles 1/);
  assert.match(summary, /bruit 1/);
  assert.match(summary, /package\.json/);
  assert.match(summary, /\.env/);
  assert.equal(formatSignal(session.events[0]!), null, "green events must not render anywhere");
});

test("feedback persists behavior precision counters across sessions", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-feedback-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const session = sessionFixture(root);
  const orange = session.events.find((event) => event.id === "orange");
  if (orange) {
    orange.stage = "behavior";
    orange.codes = ["dependency-added"];
  }
  markEventFeedback(session, "orange", "noise");
  markEventFeedback(session, "orange", "useful");
  const stats = readFeedbackStats(root);
  assert.deepEqual(stats.totals, { noise: 0, useful: 1 });
  assert.deepEqual(stats.byStage.behavior, { noise: 0, useful: 1 });
  assert.deepEqual(stats.bySignal["dependency-added"], { noise: 0, useful: 1 });
});
