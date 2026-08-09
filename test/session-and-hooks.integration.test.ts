import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleClaudeHook } from "../src/claude/handler.js";
import type { ClaudeHookInput } from "../src/domain/types.js";
import { readCurrentIntentSync } from "../src/intent/current-intent.js";
import { SessionStore } from "../src/session/store.js";
import { readCurrentStatusSync } from "../src/status/current-status.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function hook(root: string, event: string, extra: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    session_id: "integration-hook",
    cwd: root,
    hook_event_name: event,
    ...extra,
  };
}

/**
 * Un hook peut légitimement répondre (titre du terminal via `terminalSequence`)
 * sans pour autant retenir l'action. Seul `hookSpecificOutput` bloque.
 */
function assertDoesNotBlock(output: Awaited<ReturnType<typeof handleClaudeHook>>, message?: string): void {
  assert.equal(output?.hookSpecificOutput, undefined, message ?? "the action must not be held");
}

async function setup(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-hook-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await fs.writeFile(path.join(root, "src", "anchor.ts"), 'import { direct } from "./direct";\nexport const anchor = direct;\n');
  await fs.writeFile(path.join(root, "src", "direct.ts"), "export const direct = 1;\n");
  await fs.writeFile(path.join(root, "src", "unconnected.ts"), "export const unconnected = 1;\n");
  assertDoesNotBlock(await handleClaudeHook(hook(root, "SessionStart", { source: "startup" })));
  return root;
}

async function setupPreexistingWork(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-preexisting-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  await fs.writeFile(path.join(root, "protected.txt"), "committed\n");
  await fs.writeFile(path.join(root, "README.md"), "readme\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  await fs.writeFile(path.join(root, "protected.txt"), "user work\n");
  await handleClaudeHook(hook(root, "SessionStart", { source: "startup" }));
  return root;
}

test("a red PreToolUse verdict forces user confirmation and records its ruleId", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-red",
  }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=local-only\n" },
    tool_use_id: "tool-red",
  }));

  assert.equal(output?.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason ?? "", /cumulative-score/);
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason ?? "", /\.env/);
  const session = await new SessionStore(root).load("claude-integration-hook");
  const event = session?.events.find((item) => item.path === ".env");
  assert.equal(event?.level, "RED");
  assert.equal(event?.ruleId, "cumulative-score");
  assert.equal(event?.scoreBreakdown.mode, "scored");
  assert.equal(event?.turnId, "turn-red");
  assert.equal(readCurrentStatusSync(root).level, "RED");
});

test("a red verdict with blockOnRed cannot let the agent proceed", async (context) => {
  const root = await setup(context);
  await fs.mkdir(path.join(root, ".driftlight"), { recursive: true });
  await fs.writeFile(path.join(root, ".driftlight", "config.json"), JSON.stringify({ blockOnRed: true }));
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-contract",
  }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=local-only\n" },
    tool_use_id: "tool-contract",
  }));

  const specific = output?.hookSpecificOutput;
  assert.ok(specific, "a red verdict must produce a hookSpecificOutput, otherwise the agent just proceeds");
  assert.equal(specific?.hookEventName, "PreToolUse", "Claude Code ignores the block without the matching event name");

  // Le contrat Claude Code : seuls "deny" et "ask" retiennent l'action.
  // "allow" et "defer" la laissent passer — les accepter ici serait un faux voyant.
  const decision = specific?.permissionDecision as string | undefined;
  assert.ok(
    decision === "ask" || decision === "deny",
    `permissionDecision must hold the action, got ${JSON.stringify(decision)}`,
  );
  assert.ok(
    (specific?.permissionDecisionReason ?? "").length > 0,
    "a refusal with no reason gives the user nothing to decide on",
  );
});

test("an orange verdict is recorded but does not interrupt by default", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-orange",
  }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "unconnected.ts"), content: "export const changed = 2;\n" },
    tool_use_id: "tool-orange",
  }));

  assertDoesNotBlock(output);
  const session = await new SessionStore(root).load("claude-integration-hook");
  const event = session?.events.find((item) => item.path === "src/unconnected.ts");
  assert.equal(event?.level, "ORANGE");
  assert.equal(event?.ruleId, "cumulative-score");
});

test("blocking behavior follows local blockOnRed and blockOnOrange settings", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-config",
  }));
  await fs.writeFile(path.join(root, ".driftlight", "config.json"), JSON.stringify({
    blockOnRed: false,
    blockOnOrange: true,
  }));

  const red = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=1\n" },
  }));
  assertDoesNotBlock(red, "blockOnRed=false must disable only the confirmation prompt");

  const orange = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "unconnected.ts"), content: "export const changed = 2;\n" },
  }));
  assert.equal(orange?.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(orange?.hookSpecificOutput?.permissionDecisionReason ?? "", /cumulative-score/);
});

test("an explicitly named file is never signaled, including a sensitive path", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Crée .env avec SECRET=local-only",
    prompt_id: "turn-explicit",
  }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=local-only\n" },
  }));

  assertDoesNotBlock(output);
  const session = await new SessionStore(root).load("claude-integration-hook");
  const event = session?.events.find((item) => item.path === ".env");
  assert.equal(event?.level, "GREEN");
  assert.equal(event?.ruleId, "cumulative-score");
  assert.ok((event?.scoreBreakdown.score ?? 1) < (event?.scoreBreakdown.thresholds.orange ?? 0));
});

test("the classifier reloads current-intent.json between successive turns", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Crée .env",
    prompt_id: "turn-one",
  }));
  const first = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "ONE=1\n" },
  }));
  assertDoesNotBlock(first);
  assert.equal(readCurrentIntentSync(root)?.turnId, "turn-one");

  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-two",
  }));
  const second = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "TWO=2\n" },
  }));
  assert.equal(second?.hookSpecificOutput?.permissionDecision, "ask");
  assert.equal(readCurrentIntentSync(root)?.turnId, "turn-two");
});

test("Stop summarizes only orange and red events from the current turn", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-before-summary",
  }));
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env.previous"), content: "OLD=1\n" },
  }));
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix src/anchor.ts",
    prompt_id: "turn-summary",
  }));
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "direct.ts"), content: "export const direct = 2;\n" },
  }));
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "unconnected.ts"), content: "export const changed = 2;\n" },
  }));
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=1\n" },
  }));

  const output = await handleClaudeHook(hook(root, "Stop", { prompt_id: "turn-summary" }));
  assert.match(output?.systemMessage ?? "", /ORANGE · src\/unconnected\.ts · cumulative-score · event-/);
  assert.match(output?.systemMessage ?? "", /RED · \.env · cumulative-score · event-/);
  assert.doesNotMatch(output?.systemMessage ?? "", /src\/direct\.ts|GREEN|\.env\.previous/);
});

test("Stop emits nothing when the current turn contains only green events", async (context) => {
  const root = await setup(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix README.md",
    prompt_id: "turn-green-only",
  }));
  await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "README.md"), content: "fixed\n" },
  }));

  assert.equal(await handleClaudeHook(hook(root, "Stop")), undefined);
});

test("normal editing of a named pre-existing file emits no alert", async (context) => {
  const root = await setupPreexistingWork(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Continue le travail dans protected.txt",
    prompt_id: "turn-named-preexisting",
  }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(root, "protected.txt"),
      old_string: "user work",
      new_string: "continued user work",
    },
  }));

  assertDoesNotBlock(output);
  const session = await new SessionStore(root).load("claude-integration-hook");
  assert.equal(session?.events.filter((event) => event.path === "protected.txt" && event.level !== "GREEN").length, 0);
});

test("editing a pre-existing file after reading it in the turn emits no alert", async (context) => {
  const root = await setupPreexistingWork(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix README.md",
    prompt_id: "turn-read-preexisting",
  }));
  await handleClaudeHook(hook(root, "PostToolUse", {
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "protected.txt") },
  }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(root, "protected.txt"),
      old_string: "user work",
      new_string: "continued user work",
    },
  }));

  assertDoesNotBlock(output);
  const session = await new SessionStore(root).load("claude-integration-hook");
  assert.equal(session?.agentReads?.[0]?.path, "protected.txt");
  assert.equal(session?.events.filter((event) => event.path === "protected.txt" && event.level !== "GREEN").length, 0);
});

test("deleting an out-of-scope pre-existing file emits one red recovery alert", async (context) => {
  const root = await setupPreexistingWork(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix README.md",
    prompt_id: "turn-delete-preexisting",
  }));
  await fs.rm(path.join(root, "protected.txt"));
  await handleClaudeHook(hook(root, "PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "simulated fixture deletion" },
  }));

  const session = await new SessionStore(root).load("claude-integration-hook");
  const alerts = session?.events.filter((event) => event.path === "protected.txt" && event.ruleId === "preexisting-file-deleted") ?? [];
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.level, "RED");
  assert.match(alerts[0]?.reasons[0] ?? "", /modifications non sauvegardées/i);
  assert.match(alerts[0]?.reasons[0] ?? "", /Annuler|historique local/i);
});

test("rewriting an unread out-of-scope pre-existing file emits orange", async (context) => {
  const root = await setupPreexistingWork(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix README.md",
    prompt_id: "turn-write-preexisting",
  }));

  assertDoesNotBlock(await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "protected.txt"), content: "replacement\n" },
  })));

  const session = await new SessionStore(root).load("claude-integration-hook");
  const alert = session?.events.find((event) => event.path === "protected.txt" && event.ruleId === "preexisting-destructive-edit");
  assert.equal(alert?.level, "ORANGE");
});

test("the pre-existing protection rule emits at most once per file and turn", async (context) => {
  const root = await setupPreexistingWork(context);
  await handleClaudeHook(hook(root, "UserPromptSubmit", {
    prompt: "Fix README.md",
    prompt_id: "turn-deduplicate-preexisting",
  }));

  for (let index = 0; index < 3; index += 1) {
    await handleClaudeHook(hook(root, "PreToolUse", {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(root, "protected.txt"),
        old_string: `old ${index}`,
        new_string: `new ${index}`,
      },
    }));
  }

  const session = await new SessionStore(root).load("claude-integration-hook");
  const alerts = session?.events.filter(
    (event) => event.path === "protected.txt" && event.ruleId === "preexisting-destructive-edit",
  ) ?? [];
  assert.equal(alerts.length, 1);
});
