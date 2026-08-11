import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HOOK_TIME_BUDGET_MS, runHookSafely } from "../src/claude/safe-hook.js";
import { handleClaudeHook } from "../src/claude/handler.js";
import type { ClaudeHookInput } from "../src/domain/types.js";
import { projectStateDirectory } from "../src/shared/state-paths.js";

/**
 * DriftLight est un voyant, pas un garde-barrière. Il peut se tromper de
 * couleur ; il ne peut pas empêcher de travailler. Rien de ce qui casse chez
 * lui ne doit remonter à l'agent, ni retenir une action par accident.
 */

const envelope = JSON.stringify({
  session_id: "fail-open",
  cwd: process.cwd(),
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "src/app.ts", content: "x" },
});

test("a thrown handler produces silence, never an error for the agent", async () => {
  const outcome = await runHookSafely(envelope, {
    handler: () => Promise.reject(new Error("disque plein")),
  });

  assert.equal(outcome.stdout, "", "aucune sortie ne doit atteindre l'hôte");
  assert.equal(outcome.degraded, "error");
  assert.match(outcome.detail ?? "", /disque plein/, "la cause reste disponible pour le diagnostic");
});

test("a synchronous throw is caught as well", async () => {
  const outcome = await runHookSafely(envelope, {
    handler: () => {
      throw new Error("régression interne");
    },
  });
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.degraded, "error");
});

test("malformed input is ignored instead of crashing", async () => {
  for (const raw of ["{ pas du json", "[]", "null", '"chaîne"', "42"]) {
    const outcome = await runHookSafely(raw);
    assert.equal(outcome.stdout, "", `${raw} ne doit rien produire`);
    assert.equal(outcome.degraded, "invalid-input");
  }
});

test("empty input is a normal no-op, not a degradation", async () => {
  const outcome = await runHookSafely("   \n");
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.degraded, undefined);
});

test("a handler that never settles gives up inside its own budget", async () => {
  const started = Date.now();
  const outcome = await runHookSafely(envelope, {
    budgetMs: 40,
    handler: () => new Promise(() => undefined),
  });

  assert.equal(outcome.stdout, "");
  assert.equal(outcome.degraded, "timeout");
  assert.ok(Date.now() - started < 2_000, "le budget doit rendre la main tout de suite");
  assert.ok(
    HOOK_TIME_BUDGET_MS < 10_000,
    "le budget doit rester sous le délai d'attente de Claude Code, sinon l'hôte tue le hook en pleine écriture",
  );
});

test("an unserialisable response is withheld rather than half written", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const outcome = await runHookSafely(envelope, {
    handler: () => Promise.resolve(circular as never),
  });

  assert.equal(outcome.stdout, "", "mieux vaut se taire qu'écrire un JSON tronqué");
  assert.equal(outcome.degraded, "error");
});

test("a normal verdict still reaches the host untouched", async () => {
  const response = { suppressOutput: true, terminalSequence: "]0;titre" };
  const outcome = await runHookSafely(envelope, { handler: () => Promise.resolve(response) });

  assert.equal(outcome.degraded, undefined);
  assert.deepEqual(JSON.parse(outcome.stdout), response);
});

/**
 * Le contrat qui compte réellement est celui du processus : quoi qu'il arrive,
 * le binaire sort en 0 et n'écrit rien sur stdout que l'hôte ne sache lire.
 */
test("the real binary exits cleanly on garbage input", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-failopen-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });

  const cli = path.resolve("dist", "src", "cli.js");
  for (const input of ["{ cassé", "", '{"hook_event_name":"Inconnu"}']) {
    const result = spawnSync(process.execPath, [cli, "hook"], {
      input,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, `entrée ${JSON.stringify(input)} doit sortir en 0`);
    assert.equal(result.stdout, "", "rien ne doit être écrit sur stdout");
  }
});

/**
 * Le filet est le dernier recours, pas la première ligne. Un état dérivé
 * illisible doit dégrader la précision, jamais éteindre le voyant : sinon un
 * seul fichier tronqué suffirait à désarmer la protection sans que personne ne
 * le remarque, puisque le fail-open est silencieux par construction.
 */
test("corrupted local state degrades precision, it does not blind the light", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-corrupt-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
  for (const args of [["init"], ["config", "user.email", "d@e.test"], ["config", "user.name", "T"]]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });

  const hook = (event: string, extra: Record<string, unknown> = {}): ClaudeHookInput =>
    ({ session_id: "corrupt", cwd: root, hook_event_name: event, ...extra }) as ClaudeHookInput;
  await handleClaudeHook(hook("SessionStart", { source: "startup" }));
  await handleClaudeHook(hook("UserPromptSubmit", { prompt: "Corrige src/app.ts", prompt_id: "t1" }));

  const state = projectStateDirectory(root);
  await fs.writeFile(path.join(state, "intents", "claude-corrupt.json"), "{ tronque");
  await fs.writeFile(path.join(state, "repo-profile.json"), "pas du json");
  await fs.writeFile(path.join(state, "import-graph.json"), "{ moitie ecrit");

  const output = await handleClaudeHook(hook("PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=1\n" },
  }));

  assert.equal(
    output?.hookSpecificOutput?.permissionDecision,
    "ask",
    "un secret doit rester protégé même sans intention, profil ni graphe lisibles",
  );
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason ?? "", /sensitive-file/);
});
