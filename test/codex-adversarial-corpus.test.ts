import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { normalizeCodexEvent } from "../src/adapters/codex/normalizer.js";
import { NormalizedEventProcessor } from "../src/core/normalized-event-processor.js";
import type { SessionEvent, Severity } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";
import {
  MUST_CATCH,
  MUST_STAY_SILENT,
  buildRepository,
  type Scenario,
  type Step,
} from "./fixtures/adversarial-scenarios.js";

/**
 * Le même corpus, joué par Codex.
 *
 * Codex ne parle pas le même dialecte : les éditions arrivent par les en-têtes
 * d'`apply_patch` plutôt que par des entrées d'outil typées, et les lectures
 * s'appellent `read_file`. Une dérive attrapée sous Claude Code et manquée ici
 * serait un angle mort, pas une différence d'implémentation acceptable — d'où
 * le choix de rejouer les scénarios à l'identique plutôt que d'en écrire
 * d'autres, plus indulgents.
 */

const SESSION = "thread-adversarial";

async function deliver(root: string, native: Record<string, unknown>): Promise<void> {
  const processor = new NormalizedEventProcessor({ notify: async () => [] });
  for (const event of normalizeCodexEvent({ session_id: SESSION, cwd: root, ...native })) {
    await processor.process(event);
  }
}

/** En-tête `apply_patch` équivalent à l'écriture demandée par le scénario. */
function applyPatch(relative: string, operation: "Add" | "Update" | "Delete", body: string): string {
  return `*** Begin Patch\n*** ${operation} File: ${relative}\n${body}\n*** End Patch`;
}

async function applyCodexStep(root: string, step: Step): Promise<void> {
  const absolute = (relative: string): string => path.join(root, ...relative.split("/"));

  if ("read" in step) {
    await deliver(root, {
      hook_event_name: "PostToolUse",
      tool_name: "read_file",
      tool_input: { path: absolute(step.read) },
    });
    return;
  }
  if ("grep" in step) {
    await deliver(root, {
      hook_event_name: "PostToolUse",
      tool_name: "grep",
      tool_input: { pattern: step.grep },
      tool_response: { content: step.hit },
    });
    return;
  }
  if ("plan" in step) {
    await deliver(root, {
      hook_event_name: "PreToolUse",
      tool_name: "update_plan",
      tool_input: { plan: step.plan.map((content) => ({ step: content })) },
    });
    return;
  }
  if ("bash" in step) {
    await deliver(root, {
      hook_event_name: "PreToolUse",
      tool_name: "shell_command",
      tool_input: { command: step.bash },
    });
    return;
  }
  if ("write" in step) {
    const previous = await fs.readFile(absolute(step.write), "utf8").catch(() => null);
    const added = step.content.trimEnd().split("\n").map((line) => `+${line}`);
    if (previous === null) {
      await deliver(root, {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: applyPatch(step.write, "Add", added.join("\n")) },
      });
      return;
    }
    // Remplacer un fichier existant retire ses lignes avant d'ajouter les
    // nouvelles : c'est la forme qu'a réellement un patch de réécriture.
    const removed = previous.trimEnd().split("\n").map((line) => `-${line}`);
    await deliver(root, {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: applyPatch(step.write, "Update", [...removed, ...added].join("\n")) },
    });
    return;
  }
  await deliver(root, {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: applyPatch(step.edit, "Update", `-${step.from}\n+${step.to}`) },
  });
}

const ORDER: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };
const outcomes: Array<{ name: string; direction: string; passed: boolean; got: string; declared?: boolean }> = [];

async function runScenario(context: test.TestContext, scenario: Scenario): Promise<SessionEvent[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-codex-adv-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await buildRepository(scenario, root);

  await deliver(root, { hook_event_name: "SessionStart", source: "startup" });
  await deliver(root, { hook_event_name: "UserPromptSubmit", prompt: scenario.intent, turn_id: "turn-adversarial" });

  const store = new SessionStore(root);
  for (const step of scenario.steps.slice(0, -1)) await applyCodexStep(root, step);
  const before = (await store.load(`codex-${SESSION}`))?.events.length ?? 0;
  await applyCodexStep(root, scenario.steps[scenario.steps.length - 1]!);

  const session = await store.load(`codex-${SESSION}`);
  return (session?.events ?? []).slice(before);
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

  if (scenario.expect === "SILENT") return { passed: alerts.length === 0, got };
  return { passed: ORDER[highest] >= ORDER[scenario.expect], got };
}

/** Applique réellement l'étape au disque, comme le ferait Codex après accord. */
async function applyToDisk(root: string, step: Step): Promise<void> {
  const absolute = (relative: string): string => path.join(root, ...relative.split("/"));
  if ("write" in step) {
    await fs.mkdir(path.dirname(absolute(step.write)), { recursive: true });
    await fs.writeFile(absolute(step.write), step.content);
    return;
  }
  if ("edit" in step) {
    const current = await fs.readFile(absolute(step.edit), "utf8");
    await fs.writeFile(absolute(step.edit), current.replace(step.from, step.to));
  }
}

for (const scenario of MUST_CATCH) {
  test(`codex · détection — ${scenario.name}`, async (context) => {
    const blind = scenario.blindAtProposal?.codex;
    const result = record(scenario, await runScenario(context, scenario));
    outcomes.push({ name: scenario.name, direction: "détection", ...result, declared: Boolean(blind) });
    if (!blind) {
      assert.ok(
        result.passed,
        `attendu au moins ${scenario.expect}, obtenu ${result.got}\n  pourquoi : ${scenario.why}`,
      );
    }
  });
}

/**
 * Un écart déclaré doit rester un écart borné. Ces scénarios ne sont pas
 * dispensés de détection : ils la rendent une étape plus tard, et c'est cette
 * détection-là qui est vérifiée ici.
 */
for (const scenario of MUST_CATCH.filter((item) => item.blindAtProposal?.codex)) {
  test(`codex · détection après application — ${scenario.name}`, async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-codex-post-"));
    context.after(async () => await fs.rm(root, { recursive: true, force: true }));
    await buildRepository(scenario, root);
    await deliver(root, { hook_event_name: "SessionStart", source: "startup" });
    await deliver(root, { hook_event_name: "UserPromptSubmit", prompt: scenario.intent, turn_id: "turn-post" });

    const store = new SessionStore(root);
    for (const step of scenario.steps.slice(0, -1)) await applyCodexStep(root, step);
    const last = scenario.steps[scenario.steps.length - 1]!;
    await applyCodexStep(root, last);
    const before = (await store.load(`codex-${SESSION}`))?.events.length ?? 0;

    // Codex applique le patch accepté, puis annonce la fin de l'outil.
    await applyToDisk(root, last);
    await deliver(root, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} });

    const events = ((await store.load(`codex-${SESSION}`))?.events ?? []).slice(before);
    const alerts = events.filter((event) => event.level === "ORANGE" || event.level === "RED");
    assert.ok(
      alerts.length > 0,
      `${scenario.blindAtProposal?.codex}\n  la détection doit alors survenir après application, et elle manque`,
    );
  });
}

for (const scenario of MUST_STAY_SILENT) {
  test(`codex · silence — ${scenario.name}`, async (context) => {
    const result = record(scenario, await runScenario(context, scenario));
    outcomes.push({ name: scenario.name, direction: "silence", ...result });
    assert.ok(result.passed, `attendu aucune alerte, obtenu ${result.got}\n  pourquoi : ${scenario.why}`);
  });
}

after(() => {
  const rate = (direction: string): string => {
    const subset = outcomes.filter((item) => item.direction === direction);
    return `${subset.filter((item) => item.passed).length}/${subset.length}`;
  };
  const atProposal = outcomes.filter((item) => item.direction === "détection" && !item.declared);
  const detected = atProposal.filter((item) => item.passed).length;
  console.log(
    `\nCorpus adverse Codex — détection ${detected}/${atProposal.length} à la proposition`
    + ` · silence ${rate("silence")}`,
  );
  for (const item of outcomes.filter((entry) => !entry.passed && !entry.declared)) {
    console.log(`  ✗ ${item.direction} · ${item.name} → ${item.got}`);
  }
  for (const item of outcomes.filter((entry) => entry.declared)) {
    console.log(`  · écart déclaré, couvert après application : ${item.name}`);
  }
});
