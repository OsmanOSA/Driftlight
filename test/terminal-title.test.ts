import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { CurrentStatus, DriftLightConfig, SessionEvent, Severity } from "../src/domain/types.js";
import { recordCurrentStatus } from "../src/status/current-status.js";
import {
  applyTerminalTitle,
  buildTerminalTitle,
  defaultTerminalTitle,
  isTerminalSequenceAllowed,
  pushTerminalTitle,
  restoreTerminalTitle,
  restoreTitleSequence,
  setTitleSequence,
  terminalTitleSequence,
  type TitleSink,
} from "../src/ui/terminal-title.js";

const OSC_PREFIX = "\u001b]0;";
const BEL = "\u0007";
const PUSH = "\u001b[22;0t";
const POP = "\u001b[23;0t";

function fakeSink(): TitleSink & { writes: string[]; closed: number } {
  const writes: string[] = [];
  const state = { closed: 0 };
  return {
    writes,
    get closed() {
      return state.closed;
    },
    write: (data) => void writes.push(data),
    close: () => void (state.closed += 1),
  };
}

function status(level: Severity, counts: Partial<Record<Severity, number>>): CurrentStatus {
  return {
    schemaVersion: 1,
    level,
    counts: { GREEN: 0, ORANGE: 0, RED: 0, ...counts },
    lastEventAt: null,
    acknowledgedAt: null,
  };
}

function event(id: string, level: Severity): SessionEvent {
  return {
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "change",
    path: `${id}.ts`,
    changeKind: "modified",
    level,
    reasons: ["raison"],
    codes: ["regle"],
    ruleId: "regle",
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
      absoluteRuleId: "regle",
    },
    expected: false,
  };
}

const config = (overrides: Partial<DriftLightConfig> = {}): DriftLightConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

test("the title reflects the highest severity and the aggregate alert count", () => {
  assert.equal(buildTerminalTitle(status("RED", { RED: 1 }), "repo"), "🔴 DriftLight — 1 alerte");
  assert.equal(buildTerminalTitle(status("ORANGE", { ORANGE: 3 }), "repo"), "🟠 DriftLight — 3 alertes");
  assert.equal(buildTerminalTitle(status("RED", { RED: 1, ORANGE: 2 }), "repo"), "🔴 DriftLight — 3 alertes");
  assert.equal(buildTerminalTitle(status("GREEN", { GREEN: 7 }), "repo"), "repo", "green shows the plain title");
});

test("the OSC 0 sequence is well formed and cannot be broken by a hostile title", () => {
  assert.equal(setTitleSequence("🔴 DriftLight — 1 alerte"), `${OSC_PREFIX}🔴 DriftLight — 1 alerte${BEL}`);
  const injected = setTitleSequence(`evil${BEL}${OSC_PREFIX}pwned`);
  assert.equal(injected.indexOf(BEL), injected.length - 1, "only the terminating BEL may remain");
  assert.equal(injected.split(OSC_PREFIX).length, 2, "no second OSC introducer may survive");
});

test("the terminal title is restored at the end of a session", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sink = fakeSink();
  const settings = config();

  // Cycle de vie complet : début de session, alerte rouge, fin de session.
  pushTerminalTitle(settings, sink);
  recordCurrentStatus(root, [event("alert", "RED")]);
  applyTerminalTitle(root, settings, sink);
  restoreTerminalTitle(root, settings, sink);

  const neutral = defaultTerminalTitle(root);
  assert.equal(sink.writes[0], PUSH, "the original title must be saved before anything is changed");
  assert.equal(sink.writes[1], `${OSC_PREFIX}🔴 DriftLight — 1 alerte${BEL}`);

  const final = sink.writes[2] ?? "";
  assert.ok(final.endsWith(POP), "restoring must pop the saved title last, so stack-aware terminals win");
  assert.ok(
    final.startsWith(`${OSC_PREFIX}${neutral}${BEL}`),
    "terminals without a title stack must still land on the neutral title",
  );
  assert.ok(!final.includes("DriftLight — 1 alerte"), "no alert may survive in the restored title");
});

test("acknowledging the status returns the title to normal mid-session", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-ack-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sink = fakeSink();

  recordCurrentStatus(root, [event("alert", "ORANGE")]);
  applyTerminalTitle(root, config(), sink);
  assert.equal(sink.writes[0], `${OSC_PREFIX}🟠 DriftLight — 1 alerte${BEL}`);

  const { acknowledgeCurrentStatus } = await import("../src/status/current-status.js");
  await acknowledgeCurrentStatus(root);
  applyTerminalTitle(root, config(), sink);
  assert.equal(sink.writes[1], `${OSC_PREFIX}${defaultTerminalTitle(root)}${BEL}`);
});

test("disabling terminalTitle emits nothing at all", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-off-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sink = fakeSink();
  const disabled = config({ terminalTitle: false });

  recordCurrentStatus(root, [event("alert", "RED")]);
  pushTerminalTitle(disabled, sink);
  applyTerminalTitle(root, disabled, sink);
  restoreTerminalTitle(root, disabled, sink);

  assert.deepEqual(sink.writes, []);
});

test("sequences returned to Claude Code stay inside its escape allowlist", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-allow-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  recordCurrentStatus(root, [event("alert", "RED")]);

  // Claude Code n'accepte que OSC 0/1/2/9/99/777 et BEL, et ignore le champ
  // entier au moindre écart : une séquence refusée serait invisible en production.
  assert.equal(isTerminalSequenceAllowed(terminalTitleSequence(root, config()) ?? ""), true);
  assert.equal(isTerminalSequenceAllowed(restoreTitleSequence(root, config()) ?? ""), true);

  assert.equal(isTerminalSequenceAllowed(PUSH), false, "the XTerm title stack is CSI, outside the allowlist");
  assert.equal(isTerminalSequenceAllowed(POP), false);
  assert.equal(isTerminalSequenceAllowed(`${OSC_PREFIX}titre${BEL}${PUSH}`), false, "one stray sequence voids the field");
});

test("the hook restore sequence carries the neutral title without any stack escape", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-hookrestore-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  recordCurrentStatus(root, [event("alert", "RED")]);

  const restored = restoreTitleSequence(root, config()) ?? "";
  assert.equal(restored, `${OSC_PREFIX}${defaultTerminalTitle(root)}${BEL}`);
  assert.ok(!restored.includes(POP), "a hook cannot pop the stack, it names the neutral title instead");
  assert.ok(!restored.includes("alerte"), "no alert may survive in the restored title");
});

test("terminalTitleSequence is withheld when the feature is disabled", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-seqoff-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  assert.equal(terminalTitleSequence(root, config({ terminalTitle: false })), undefined);
  assert.equal(restoreTitleSequence(root, config({ terminalTitle: false })), undefined);
});

test("a terminal that cannot be opened never breaks the caller", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-title-null-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));

  // `null` traduit l'absence de terminal de contrôle : hook lancé par une extension,
  // sortie redirigée, TERM=dumb. Aucun de ces cas ne doit lever.
  assert.doesNotThrow(() => pushTerminalTitle(config(), null));
  assert.doesNotThrow(() => applyTerminalTitle(root, config(), null));
  assert.doesNotThrow(() => restoreTerminalTitle(root, config(), null));
});
