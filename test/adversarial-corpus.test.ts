import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { handleClaudeHook } from "../src/claude/handler.js";
import type { ClaudeHookInput, SessionEvent, Severity } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";
import {
  MUST_CATCH,
  MUST_STAY_SILENT,
  buildRepository,
  type Scenario,
  type Step,
} from "./fixtures/adversarial-scenarios.js";

/**
 * Corpus adverse — la moitié manquante de la calibration.
 *
 * Le rejeu de sessions enregistrées ne mesure que le bruit : il ne contient que
 * ce qui s'est produit, jamais ce qui aurait dû être attrapé. Un taux d'alerte
 * de 2 % est excellent, ou catastrophique si plus rien n'est détecté ; seul un
 * corpus de dérives connues permet de trancher.
 *
 * Les deux directions sont mesurées ensemble, volontairement. Un corpus qui ne
 * mesurerait que le rappel se « corrige » en rendant tout rouge.
 *
 * Chaque scénario passe par `handleClaudeHook`, le vrai point d'entrée, et non
 * par le classifieur. C'est précisément ce court-circuit qui avait laissé un
 * hook non livré invisible derrière un test vert.
 */

function hook(cwd: string, event: string, extra: Record<string, unknown> = {}): ClaudeHookInput {
  return { session_id: "adversarial", cwd, hook_event_name: event, ...extra } as ClaudeHookInput;
}

async function applyStep(root: string, step: Step): Promise<void> {
  const absolute = (relative: string): string => path.join(root, ...relative.split("/"));

  if ("read" in step) {
    await handleClaudeHook(hook(root, "PostToolUse", {
      tool_name: "Read",
      tool_input: { file_path: absolute(step.read) },
    }));
    return;
  }
  if ("grep" in step) {
    await handleClaudeHook(hook(root, "PostToolUse", {
      tool_name: "Grep",
      tool_input: { pattern: step.grep },
      tool_response: { content: step.hit },
    }));
    return;
  }
  if ("plan" in step) {
    await handleClaudeHook(hook(root, "PreToolUse", {
      tool_name: "TodoWrite",
      tool_input: { todos: step.plan.map((content) => ({ content })) },
    }));
    return;
  }
  if ("bash" in step) {
    await handleClaudeHook(hook(root, "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: step.bash },
    }));
    return;
  }
  if ("write" in step) {
    await handleClaudeHook(hook(root, "PreToolUse", {
      tool_name: "Write",
      tool_input: { file_path: absolute(step.write), content: step.content },
    }));
    return;
  }
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: absolute(step.edit), old_string: step.from, new_string: step.to },
  }));
}

const ORDER: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };
const outcomes: Array<{ name: string; direction: "détection" | "silence"; passed: boolean; got: string }> = [];

async function runScenario(context: test.TestContext, scenario: Scenario): Promise<SessionEvent[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-adversarial-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await buildRepository(scenario, root);

  await handleClaudeHook(hook(root, "SessionStart", { source: "startup" }));
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: scenario.intent,
    prompt_id: "turn-adversarial",
  }));

  const store = new SessionStore(root);
  const before = (await store.load("claude-adversarial"))?.events.length ?? 0;
  for (const step of scenario.steps.slice(0, -1)) await applyStep(root, step);
  const beforeAction = (await store.load("claude-adversarial"))?.events.length ?? before;
  await applyStep(root, scenario.steps[scenario.steps.length - 1]!);

  const session = await store.load("claude-adversarial");
  return (session?.events ?? []).slice(beforeAction);
}

function record(scenario: Scenario, events: SessionEvent[]): { passed: boolean; got: string } {
  const alerts = events.filter((event) => event.level === "ORANGE" || event.level === "RED");
  const highest = alerts.reduce<Severity>(
    (top, event) => ORDER[event.level] > ORDER[top] ? event.level : top,
    "GREEN",
  );
  const got = alerts.length === 0
    ? "SILENT"
    : `${highest} (${[...new Set(alerts.map((event) => event.ruleId))].join(", ")})`;

  const exemption = events.find((event) => event.exemptedBy !== undefined)?.exemptedBy;
  if (scenario.exempt && exemption !== scenario.exempt) {
    return { passed: false, got: `${got} — exemption ${exemption ?? "aucune"} au lieu de ${scenario.exempt}` };
  }
  if (scenario.expect === "SILENT") return { passed: alerts.length === 0, got };
  const severeEnough = ORDER[highest] >= ORDER[scenario.expect];
  const ruleMatches = !scenario.rule || alerts.some((event) => event.ruleId === scenario.rule);
  return { passed: severeEnough && ruleMatches, got };
}

for (const scenario of MUST_CATCH) {
  test(`détection — ${scenario.name}`, async (context) => {
    const events = await runScenario(context, scenario);
    const result = record(scenario, events);
    outcomes.push({ name: scenario.name, direction: "détection", ...result });
    assert.ok(
      result.passed,
      `attendu au moins ${scenario.expect}${scenario.rule ? ` (${scenario.rule})` : ""}, obtenu ${result.got}\n  pourquoi : ${scenario.why}`,
    );
  });
}

for (const scenario of MUST_STAY_SILENT) {
  test(`silence — ${scenario.name}`, async (context) => {
    const events = await runScenario(context, scenario);
    const result = record(scenario, events);
    outcomes.push({ name: scenario.name, direction: "silence", ...result });
    assert.ok(
      result.passed,
      `attendu aucune alerte, obtenu ${result.got}\n  pourquoi : ${scenario.why}`,
    );
  });
}

after(() => {
  const rate = (direction: string): string => {
    const subset = outcomes.filter((item) => item.direction === direction);
    const passed = subset.filter((item) => item.passed).length;
    return subset.length ? `${passed}/${subset.length}` : "0/0";
  };
  console.log(`\nCorpus adverse — détection ${rate("détection")} · silence ${rate("silence")}`);
  for (const item of outcomes.filter((entry) => !entry.passed)) {
    console.log(`  ✗ ${item.direction} · ${item.name} → ${item.got}`);
  }
});
