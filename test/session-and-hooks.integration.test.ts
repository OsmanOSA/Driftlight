import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleClaudeHook, validateObservationOnlyOutput } from "../src/claude/handler.js";
import type { ClaudeHookInput } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";

function hook(root: string, event: string, extra: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    session_id: "integration-hook",
    cwd: root,
    hook_event_name: event,
    ...extra,
  };
}

test("Claude hooks persist a local session, surface alerts and never return a blocking decision", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-hook-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "README.md"), "hello\n");

  const started = await handleClaudeHook(hook(root, "SessionStart", { source: "startup" }));
  assert.equal(validateObservationOnlyOutput(started), true);
  assert.match(started?.systemMessage ?? "", /observation locale active/);

  const promptOutput = await handleClaudeHook(hook(root, "UserPromptSubmit", { prompt: "Fix the README typo" }));
  assert.equal(promptOutput, undefined);

  const proposed = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Bash",
    tool_input: { command: "git restore ." },
  }));
  assert.equal(validateObservationOnlyOutput(proposed), true);
  assert.match(proposed?.systemMessage ?? "", /Commande Git potentiellement destructive/);
  assert.doesNotMatch(JSON.stringify(proposed), /permissionDecision|"decision"|"continue"/);

  await fs.writeFile(path.join(root, ".env"), "SECRET=local-only\n");
  const observed = await handleClaudeHook(hook(root, "PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".env"), content: "SECRET=local-only\n" },
    tool_response: { success: true },
  }));
  assert.equal(validateObservationOnlyOutput(observed), true);
  assert.match(observed?.systemMessage ?? "", /🔴/);

  const store = new SessionStore(root);
  const session = await store.load("claude-integration-hook");
  assert.ok(session);
  assert.equal(session.intents[0]?.text, "Fix the README typo");
  assert.ok(session.events.some((event) => event.codes.includes("destructive-git-command")));
  assert.ok(session.events.some((event) => event.path === ".env" && event.level === "RED"));
});
