import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexEvent } from "../src/adapters/codex/normalizer.js";

const now = (): Date => new Date("2026-08-09T11:00:00.000Z");
const common = {
  session_id: "thr_123",
  transcript_path: "D:/private/transcript.jsonl",
  cwd: "D:/work/sample",
  model: "gpt-5.6-codex",
  permission_mode: "default",
};

test("Codex normalize SessionStart depuis le payload officiel", () => {
  const events = normalizeCodexEvent({ ...common, hook_event_name: "SessionStart", source: "startup" }, now);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "SESSION_STARTED");
  assert.equal(events[0]?.session_id, "thr_123");
  assert.equal(events[0]?.payload.source, "startup");
  assert.equal(JSON.stringify(events).includes("transcript.jsonl"), false);
});

test("Codex normalize UserPromptSubmit", () => {
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "UserPromptSubmit",
    turn_id: "turn_1",
    prompt: "Create a file called scopelight-test.txt",
  }, now);
  assert.equal(events[0]?.event, "USER_PROMPT");
  assert.equal(events[0]?.payload.prompt, "Create a file called scopelight-test.txt");
  assert.equal((events[0]?.payload.native as Record<string, unknown>).turnId, "turn_1");
});

test("Codex masque les secrets évidents dans prompts et commandes", () => {
  const prompt = normalizeCodexEvent({
    ...common,
    hook_event_name: "UserPromptSubmit",
    turn_id: "turn_secret",
    prompt: "Use token=super-secret-value and sk-abcdefghijklmnopqrst",
  }, now)[0];
  const command = normalizeCodexEvent({
    ...common,
    hook_event_name: "PreToolUse",
    turn_id: "turn_secret",
    tool_name: "Bash",
    tool_use_id: "tool_secret",
    tool_input: { command: "curl -H 'Authorization: Bearer abc.def.ghi' -d password=hunter2" },
  }, now)[1];
  assert.equal(JSON.stringify(prompt).includes("super-secret-value"), false);
  assert.equal(JSON.stringify(prompt).includes("sk-abcdefghijklmnopqrst"), false);
  assert.equal(JSON.stringify(command).includes("abc.def.ghi"), false);
  assert.equal(JSON.stringify(command).includes("hunter2"), false);
});

test("Codex normalize PreToolUse Bash en outil proposé et commande proposée", () => {
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "PreToolUse",
    turn_id: "turn_1",
    tool_name: "Bash",
    tool_use_id: "tool_1",
    tool_input: { command: "npm test" },
  }, now);
  assert.deepEqual(events.map((event) => event.event), ["TOOL_PROPOSED", "COMMAND_PROPOSED"]);
  assert.equal(events[1]?.payload.command, "npm test");
  assert.equal("actionFingerprint" in (events[0]?.payload ?? {}), false);
});

test("Codex normalize PreToolUse apply_patch et extrait les fichiers", () => {
  const patch = `*** Begin Patch
*** Add File: src/new file.ts
+export const value = 1;
*** Update File: src/existing.ts
@@
-old
+new
*** Delete File: src/obsolete.ts
*** End Patch`;
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "PreToolUse",
    turn_id: "turn_2",
    tool_name: "apply_patch",
    tool_use_id: "tool_patch",
    tool_input: { command: patch },
  }, now);
  assert.deepEqual(events.map((event) => event.event), ["TOOL_PROPOSED", "FILE_EDITED", "FILE_EDITED", "FILE_EDITED"]);
  assert.deepEqual(events.slice(1).map((event) => [event.payload.path, event.payload.changeKind, event.payload.phase]), [
    ["src/new file.ts", "created", "proposed"],
    ["src/existing.ts", "modified", "proposed"],
    ["src/obsolete.ts", "deleted", "proposed"],
  ]);
  assert.equal(JSON.stringify(events).includes("export const value"), false);
  assert.equal(events.every((event) => !("actionFingerprint" in event.payload)), true);
});

test("Codex normalize PostToolUse sans persister l'output complet", () => {
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "PostToolUse",
    turn_id: "turn_2",
    tool_name: "Bash",
    tool_use_id: "tool_2",
    tool_input: { command: "echo ok" },
    tool_response: { isError: false, content: "secret output that must not be stored" },
  }, now);
  assert.equal(events[0]?.event, "TOOL_COMPLETED");
  assert.deepEqual(events[0]?.payload.response, { kind: "object", isError: false });
  assert.equal(JSON.stringify(events).includes("secret output"), false);
});

test("Codex conserve seulement le chemin utile d'un outil de lecture", () => {
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "PostToolUse",
    turn_id: "turn_read",
    tool_name: "Read",
    tool_use_id: "tool_read",
    tool_input: { file_path: "src/anchor.ts", offset: 1, limit: 20 },
    tool_response: { content: "contenu non persisté" },
  }, now);
  assert.equal(events[0]?.payload.filePath, "src/anchor.ts");
  assert.deepEqual(events[0]?.payload.readFiles, ["src/anchor.ts"]);
  assert.equal(JSON.stringify(events).includes("contenu non persisté"), false);
});

test("Codex normalise les chemins d'un plan sans persister son texte complet", () => {
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "PreToolUse",
    turn_id: "turn_plan",
    tool_name: "update_plan",
    tool_input: { plan: [{ step: "Modifier src/anchor.ts avec détail privé", status: "pending" }] },
  }, now);
  const plan = events.find((event) => event.event === "PLAN_DECLARED");
  assert.deepEqual(plan?.payload.paths, ["src/anchor.ts"]);
  assert.equal(JSON.stringify(events).includes("détail privé"), false);
});

test("Codex normalize Stop sans persister le dernier message complet", () => {
  const events = normalizeCodexEvent({
    ...common,
    hook_event_name: "Stop",
    turn_id: "turn_3",
    stop_hook_active: false,
    last_assistant_message: "full assistant response",
  }, now);
  assert.equal(events[0]?.event, "AGENT_STOPPED");
  assert.equal(events[0]?.payload.hadAssistantMessage, true);
  assert.equal(JSON.stringify(events).includes("full assistant response"), false);
});

test("Codex ignore les événements inconnus et payloads invalides", () => {
  assert.deepEqual(normalizeCodexEvent({ ...common, hook_event_name: "FutureHook" }, now), []);
  assert.deepEqual(normalizeCodexEvent({ hook_event_name: "SessionStart" }, now), []);
  assert.deepEqual(normalizeCodexEvent(null, now), []);
});

test("Codex couvre SessionEnd et les hooks de sous-agents", () => {
  assert.equal(normalizeCodexEvent({ ...common, hook_event_name: "SessionEnd", reason: "other" }, now)[0]?.event, "SESSION_ENDED");
  assert.equal(normalizeCodexEvent({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "turn_4",
    agent_id: "agent_1",
    agent_type: "reviewer",
  }, now)[0]?.event, "SUBAGENT_STARTED");
  assert.equal(normalizeCodexEvent({
    ...common,
    hook_event_name: "SubagentStop",
    turn_id: "turn_4",
    agent_id: "agent_1",
    agent_type: "reviewer",
    stop_hook_active: false,
  }, now)[0]?.event, "SUBAGENT_STOPPED");
});
