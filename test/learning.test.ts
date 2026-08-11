import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  learnedSuppressions,
  LEARNING_MINIMUM_SAMPLE,
} from "../src/classification/adaptation.js";
import { readFeedbackStats, recordFeedbackStats } from "../src/classification/feedback-stats.js";
import { handleClaudeHook } from "../src/claude/handler.js";
import { loadScoringConfigSync } from "../src/config/scoring-config.js";
import type { AlertFeedback, ClaudeHookInput, SessionEvent, Severity } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";
import { buildRepository, type Scenario } from "./fixtures/adversarial-scenarios.js";

/**
 * Apprentissage local.
 *
 * Un outil qui apprend peut apprendre à se taire — c'est le même mécanisme vu
 * des deux côtés. Ces tests ne vérifient donc pas seulement que la boucle
 * fonctionne, mais qu'elle ne peut pas éteindre ce qui ne doit jamais s'éteindre.
 */

const SESSION = "learning";

function feedbackEvent(index: number, signalId: string, filePath: string): SessionEvent {
  return {
    id: `event-${signalId}-${index}`,
    timestamp: new Date().toISOString(),
    type: "change",
    path: filePath,
    level: "ORANGE",
    reasons: ["fixture"],
    codes: [signalId],
    ruleId: signalId,
    stage: "behavior",
    expected: false,
    scoreBreakdown: {
      mode: "rules",
      configVersion: "test",
      score: null,
      unclampedScore: null,
      thresholds: { orange: 40, red: 70 },
      normalizationFactor: 1,
      signals: [],
      unavailableSignals: [],
      verdict: "ORANGE",
    },
  };
}

/** Qualifie `repetitions` alertes du signal, réparties sur les fichiers donnés. */
function teach(
  root: string,
  signalId: string,
  files: readonly string[],
  feedback: AlertFeedback,
  repetitions: number,
  offset = 0,
): void {
  for (let index = 0; index < repetitions; index += 1) {
    const filePath = files[(index + offset) % files.length] as string;
    recordFeedbackStats(root, feedbackEvent(index + offset, signalId, filePath), undefined, feedback);
  }
}

test("un signal ne se tait qu'au-delà du seuil, jamais avant", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const config = loadScoringConfigSync(root);

  teach(root, "destructive-edit", ["src/a.ts", "src/b.ts"], "noise", LEARNING_MINIMUM_SAMPLE - 1);
  assert.deepEqual(
    learnedSuppressions(readFeedbackStats(root), config),
    [],
    "en deçà du seuil, l'effet doit être nul et non partiel",
  );

  teach(root, "destructive-edit", ["src/a.ts", "src/b.ts"], "noise", 1, LEARNING_MINIMUM_SAMPLE);
  const suppressions = learnedSuppressions(readFeedbackStats(root), config);
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0]?.signalId, "destructive-edit");
  assert.equal(suppressions[0]?.directory, "src");
});

test("un seul fichier ne parle pas de ses voisins", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-one-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));

  teach(root, "destructive-edit", ["src/generated.ts"], "noise", 40);
  assert.deepEqual(
    learnedSuppressions(readFeedbackStats(root), loadScoringConfigSync(root)),
    [],
    "un fichier requalifié quarante fois ne dit rien du répertoire qui l'entoure",
  );
});

test("un signal rouge n'est jamais neutralisable, quel que soit le volume", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-red-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));

  teach(root, "sensitive-file", ["config/a.env", "config/b.env"], "noise", 200);
  assert.deepEqual(
    learnedSuppressions(readFeedbackStats(root), loadScoringConfigSync(root)),
    [],
    "aucune accumulation de feedback ne rend un secret acceptable",
  );
});

test("un désaccord réel suffit à réactiver un signal appris", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-undo-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const config = loadScoringConfigSync(root);

  teach(root, "destructive-edit", ["src/a.ts", "src/b.ts"], "noise", 10);
  assert.equal(learnedSuppressions(readFeedbackStats(root), config).length, 1);

  teach(root, "destructive-edit", ["src/a.ts", "src/b.ts"], "useful", 2, 10);
  assert.deepEqual(
    learnedSuppressions(readFeedbackStats(root), config),
    [],
    "l'apprentissage doit céder devant un désaccord, sans exiger de purge manuelle",
  );
});

// ---------------------------------------------------------------------------
// Bout en bout : ce que l'utilisateur observe réellement.
// ---------------------------------------------------------------------------

function hook(cwd: string, event: string, extra: Record<string, unknown> = {}): ClaudeHookInput {
  return { session_id: SESSION, cwd, hook_event_name: event, ...extra } as ClaudeHookInput;
}

/** Rejoue une réécriture complète et rend les événements qu'elle a produits. */
async function rewrite(root: string, intent: string, target: string): Promise<SessionEvent[]> {
  await handleClaudeHook(hook(root, "SessionStart", { source: "startup" }));
  await handleClaudeHook(hook(root, "UserPromptSubmit", { prompt: intent, prompt_id: `turn-${target}` }));
  const store = new SessionStore(root);
  const before = (await store.load(`claude-${SESSION}`))?.events.length ?? 0;
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ...target.split("/")), content: "vide\n" },
  }));
  return ((await store.load(`claude-${SESSION}`))?.events ?? []).slice(before);
}

function highest(events: readonly SessionEvent[]): Severity {
  const order: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };
  return events.reduce<Severity>((top, event) => order[event.level] > order[top] ? event.level : top, "GREEN");
}

const WORKSPACE: Scenario = {
  name: "atelier d'apprentissage",
  why: "support des vérifications de bout en bout",
  files: {
    "src/unrelated.ts": "export const a = 1;\n".repeat(80),
    "src/other.ts": "export const b = 1;\n".repeat(80),
    "lib/vendor.ts": "export const c = 1;\n".repeat(80),
  },
  intent: "Corrige src/app.ts",
  steps: [],
  expect: "ORANGE",
};

test("DriftLight se tait là où on lui a répété que c'était du bruit", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-e2e-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await buildRepository(WORKSPACE, root);

  const before = await rewrite(root, "Corrige src/app.ts", "src/unrelated.ts");
  assert.equal(highest(before), "ORANGE", "sans apprentissage, la réécriture hors demande doit alerter");

  teach(root, "destructive-edit", ["src/unrelated.ts", "src/other.ts"], "noise", 10);

  const after = await rewrite(root, "Corrige src/app.ts", "src/other.ts");
  assert.equal(highest(after), "GREEN", "après apprentissage, le même signal ne décide plus seul ici");
  assert.ok(
    after.some((event) => (event.scoreBreakdown.learnedSuppressions ?? []).length > 0),
    "une alerte tue en silence serait indistinguable d'une absence de signal",
  );
});

test("ce qui est appris dans un répertoire n'y déborde pas", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-scope-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await buildRepository(WORKSPACE, root);

  teach(root, "destructive-edit", ["src/unrelated.ts", "src/other.ts"], "noise", 20);

  const events = await rewrite(root, "Corrige src/app.ts", "lib/vendor.ts");
  assert.equal(
    highest(events),
    "ORANGE",
    "la neutralisation ne doit pas franchir la frontière du répertoire où elle a été gagnée",
  );
});

/**
 * La garantie qui compte. L'étage 0 précède l'apprentissage et ne le consulte
 * pas : aucun volume de feedback ne peut rendre destructible du travail que ni
 * Git ni l'agent ne sauront restaurer.
 */
test("l'étage 0 reste intouchable sous apprentissage maximal", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-learn-floor-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await buildRepository({
    ...WORKSPACE,
    files: { "src/legacy.ts": "export const legacy = 1;\n".repeat(40) },
    dirty: { "src/legacy.ts": "export const legacy = 2; // travail en cours\n".repeat(40) },
  }, root);

  // L'utilisateur qualifie tout de bruit, partout, longtemps.
  const config = loadScoringConfigSync(root);
  for (const signalId of Object.keys(config.behavior.severities)) {
    teach(root, signalId, ["src/legacy.ts", "src/other.ts", "src/third.ts"], "noise", 60);
  }

  const events = await rewrite(root, "Corrige src/app.ts", "src/legacy.ts");
  assert.equal(highest(events), "RED", "le travail non commité reste protégé quoi qu'on ait appris");
  assert.ok(
    events.some((event) => event.codes.includes("preexisting-file-rewritten")),
    "et il doit rester protégé par l'étage 0, pas par un signal comportemental résiduel",
  );
});
