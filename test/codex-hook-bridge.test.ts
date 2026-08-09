import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import type { ScopeLightAdapter, ScopeLightEvent } from "../src/adapters/types.js";
import type { ScopeLightEventSink } from "../src/core/local-event-inbox.js";
import { runCodexHookBridge } from "../src/adapters/codex/hook-bridge.js";

const event: ScopeLightEvent = {
  protocol_version: 1,
  agent: "codex",
  session_id: "thr_123",
  workspace: "D:/work/sample",
  timestamp: "2026-08-09T11:00:00.000Z",
  event: "SESSION_STARTED",
  payload: {},
};

const adapter: ScopeLightAdapter = {
  detect: async () => true,
  install: async () => undefined,
  uninstall: async () => undefined,
  healthCheck: async () => ({ state: "CONNECTED", adapterVersion: "test", codexDetected: true }),
  normalize: () => [event],
};

test("Codex hook reste fail-open lorsque le Core local est indisponible", async () => {
  const sink: ScopeLightEventSink = { publish: async () => { throw new Error("offline"); } };
  const result = await runCodexHookBridge(JSON.stringify({ hook_event_name: "SessionStart" }), { adapter, sink });
  assert.deepEqual(result, { exitCode: 0, stdout: "", delivered: 0 });
});

test("Codex Stop retourne du JSON valide même si le Core est indisponible", async () => {
  const sink: ScopeLightEventSink = { publish: async () => { throw new Error("offline"); } };
  const result = await runCodexHookBridge(JSON.stringify({ hook_event_name: "Stop" }), { adapter, sink });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "{}");
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});

test("Codex hook livre les événements puis marque la connexion", async () => {
  const delivered: ScopeLightEvent[] = [];
  let marked = false;
  const sink: ScopeLightEventSink = { publish: async (value) => { delivered.push(value); } };
  const result = await runCodexHookBridge(JSON.stringify({ hook_event_name: "SessionStart" }), {
    adapter,
    sink,
    onDelivered: async () => { marked = true; },
  });
  assert.equal(result.delivered, 1);
  assert.deepEqual(delivered, [event]);
  assert.equal(marked, true);
});

test("Codex hook ignore un stdin illisible sans planter", async () => {
  const result = await runCodexHookBridge("{not-json", { adapter });
  assert.deepEqual(result, { exitCode: 0, stdout: "", delivered: 0 });
});

test("Codex hook CLI reste fail-open avec un stdin illisible", () => {
  const hookCli = path.resolve("dist", "src", "adapters", "codex", "hook-cli.js");
  const result = spawnSync(process.execPath, [hookCli], {
    input: "{not-json",
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("Codex: PreToolUse reste advisory et laisse la politique native décider", async () => {
  const sink: ScopeLightEventSink = { publish: async () => undefined };
  const result = await runCodexHookBridge(
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    { adapter, sink },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "", "DriftLight ne fabrique aucune décision ou UI d'approbation");
});

test("Codex: sans verdict du Core, aucune décision n'est renvoyée", async () => {
  const sink: ScopeLightEventSink = { publish: async () => undefined };
  const result = await runCodexHookBridge(
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    { adapter, sink },
  );

  assert.equal(result.stdout, "", "un silence vaut laissez-passer");
});

test("Codex: un Core en panne ne bloque jamais l'agent", async () => {
  const sink: ScopeLightEventSink = { publish: async () => { throw new Error("offline"); } };
  const result = await runCodexHookBridge(
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    { adapter, sink },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
});
