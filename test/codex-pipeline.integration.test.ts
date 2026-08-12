import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectStatePath } from "../src/shared/state-paths.js";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import { runCodexHookBridge, type HookBridgeResult } from "../src/adapters/codex/hook-bridge.js";
import { LocalCoreEventSink } from "../src/core/local-core-event-sink.js";
import { NormalizedEventProcessor } from "../src/core/normalized-event-processor.js";
import { readCurrentIntentSync } from "../src/intent/current-intent.js";
import { dismissPendingNotifications, dispatchNotifications } from "../src/notify/dispatcher.js";
import type { NativeNotification } from "../src/notify/backend.js";
import { SessionStore } from "../src/session/store.js";
import { readCurrentStatusSync } from "../src/status/current-status.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function fixture(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-codex-pipeline-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  await fs.writeFile(path.join(root, "README.md"), "readme\n");
  await fs.writeFile(path.join(root, "protected.txt"), "committed\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  await fs.writeFile(path.join(root, "protected.txt"), "unsaved user work\n");
  return root;
}

function adapter(root: string): CodexAdapter {
  return new CodexAdapter({
    env: { CODEX_HOME: path.join(root, ".codex-test-home") },
    detectCodex: async () => true,
  });
}

async function deliver(
  root: string,
  sink: LocalCoreEventSink,
  hookEventName: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const result = await deliverResult(root, sink, hookEventName, extra);
  return result.delivered;
}

async function deliverResult(
  root: string,
  sink: LocalCoreEventSink,
  hookEventName: string,
  extra: Record<string, unknown> = {},
): Promise<HookBridgeResult> {
  const result = await runCodexHookBridge(JSON.stringify({
    session_id: "thread-pipeline",
    cwd: root,
    hook_event_name: hookEventName,
    ...extra,
  }), {
    adapter: adapter(root),
    sink,
    onDelivered: async () => undefined,
  });
  assert.equal(result.exitCode, 0);
  return result;
}

function notifyingProcessor(
  notifications: NativeNotification[],
  dismissed: string[][] = [],
): NormalizedEventProcessor {
  const loadBackend = async () => ({
    name: "test-notifier",
    send: async (notification: NativeNotification) => { notifications.push(notification); },
    dismiss: async (tags: readonly string[]) => { dismissed.push([...tags]); },
  });
  return new NormalizedEventProcessor({
    notify: async (root, events, config, sessionId, options) => await dispatchNotifications(
      root,
      events,
      config,
      sessionId,
      {
        ...options,
        environment: {},
        loadBackend,
      },
    ),
    dismiss: async (root, sessionId, options) => await dismissPendingNotifications(root, sessionId, {
      ...options,
      environment: {},
      loadBackend,
    }),
  });
}

test("PermissionRequest garde l'alerte Codex jusqu'à la fin de la décision native", async (context) => {
  const root = await fixture(context);
  const notifications: NativeNotification[] = [];
  const dismissed: string[][] = [];
  const sink = new LocalCoreEventSink(notifyingProcessor(notifications, dismissed));

  await deliver(root, sink, "SessionStart", { source: "startup" });
  await deliver(root, sink, "UserPromptSubmit", {
    turn_id: "turn-approval",
    prompt: "Inspecte seulement le dépôt",
  });
  await deliver(root, sink, "PermissionRequest", {
    turn_id: "turn-approval",
    tool_name: "Bash",
    tool_input: { command: "git clean -fd", description: "Nettoyer le dépôt" },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.persistent, true);
  assert.ok(notifications[0]?.tag);
  assert.match(notifications[0]?.title ?? "", /confirmation demandée$/);
  assert.deepEqual(dismissed, []);

  const stopped = await deliverResult(root, sink, "Stop", {
    turn_id: "turn-approval",
    stop_hook_active: false,
  });
  assert.equal(stopped.stdout, "{}");
  assert.deepEqual(dismissed, [[notifications[0]?.tag]]);
});

test("l'entrée Codex alimente intention, classifieur, statut, historique et notification", async (context) => {
  const root = await fixture(context);
  const notifications: NativeNotification[] = [];
  const sink = new LocalCoreEventSink(notifyingProcessor(notifications));

  assert.equal(await deliver(root, sink, "SessionStart", { source: "startup" }), 1);
  assert.equal(await deliver(root, sink, "UserPromptSubmit", {
    turn_id: "turn-explicit",
    prompt: "Supprime protected.txt",
  }), 1);

  const patch = "*** Begin Patch\n*** Delete File: protected.txt\n*** End Patch";
  assert.equal(await deliver(root, sink, "PreToolUse", {
    turn_id: "turn-explicit",
    tool_name: "apply_patch",
    tool_use_id: "tool-explicit",
    tool_input: { command: patch },
  }), 2);
  assert.equal(notifications.length, 0, "un fichier explicitement demandé reste silencieux");

  assert.equal(await deliver(root, sink, "UserPromptSubmit", {
    turn_id: "turn-drift",
    prompt: "Mets à jour README.md",
  }), 1);
  assert.equal(await deliver(root, sink, "PreToolUse", {
    turn_id: "turn-drift",
    tool_name: "apply_patch",
    tool_use_id: "tool-drift",
    tool_input: { command: patch },
  }), 2);

  const session = await new SessionStore(root).load("codex-thread-pipeline");
  assert.equal(session?.source, "codex");
  assert.equal(session?.currentIntent?.text, "Mets à jour README.md");
  const alert = session?.events.find((event) =>
    event.path === "protected.txt"
    && event.turnId === "turn-drift"
    && event.ruleId === "preexisting-file-deleted"
  );
  assert.equal(alert?.level, "RED");
  assert.equal(readCurrentIntentSync(root, "codex-thread-pipeline")?.turnId, "turn-drift");
  assert.equal(readCurrentStatusSync(root).level, "RED");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.title ?? "", /^DriftLight · .+ — alerte rouge$/);
  assert.match(notifications[0]?.message ?? "", /protected\.txt/);
  // L'identifiant de règle reste sur l'événement, où `explain` le lit ; le
  // toast, lui, dit le fait et rappelle la demande à laquelle le comparer.
  assert.match(notifications[0]?.message ?? "", /travail non sauvegardé/);
  assert.match(notifications[0]?.message ?? "", /Mets à jour README\.md/);

  const inbox = projectStatePath(root, "inbox", "codex");
  assert.ok((await fs.readdir(inbox)).length >= 7, "les enveloppes normalisées restent archivées localement");
});

test("PostToolUse Codex réconcilie le disque sans notifier les événements verts", async (context) => {
  const root = await fixture(context);
  const notifications: NativeNotification[] = [];
  const sink = new LocalCoreEventSink(notifyingProcessor(notifications));
  await deliver(root, sink, "SessionStart", { source: "startup" });
  await deliver(root, sink, "UserPromptSubmit", {
    turn_id: "turn-create",
    prompt: "Crée requested.txt",
  });

  const patch = "*** Begin Patch\n*** Add File: requested.txt\n+requested\n*** End Patch";
  await deliver(root, sink, "PreToolUse", {
    turn_id: "turn-create",
    tool_name: "apply_patch",
    tool_use_id: "tool-create",
    tool_input: { command: patch },
  });
  await fs.writeFile(path.join(root, "requested.txt"), "requested\n");
  assert.equal(await deliver(root, sink, "PostToolUse", {
    turn_id: "turn-create",
    tool_name: "apply_patch",
    tool_use_id: "tool-create",
    tool_input: { command: patch },
    tool_response: { isError: false },
  }), 2);

  const session = await new SessionStore(root).load("codex-thread-pipeline");
  const observed = session?.events.find((event) => event.path === "requested.txt" && event.type === "change");
  assert.equal(observed?.level, "GREEN");
  assert.equal(observed?.turnId, "turn-create");
  assert.equal(notifications.length, 0);
});

test("Codex ignore le dry-run puis signale la commande réellement destructive", async (context) => {
  const root = await fixture(context);
  const notifications: NativeNotification[] = [];
  const sink = new LocalCoreEventSink(notifyingProcessor(notifications));
  await deliver(root, sink, "SessionStart", { source: "startup" });
  await deliver(root, sink, "UserPromptSubmit", {
    turn_id: "turn-command",
    prompt: "Inspecte seulement le dépôt",
  });

  const proposal = {
    turn_id: "turn-command",
    tool_name: "Bash",
    tool_input: { command: "git clean -n" },
  };
  const first = await deliverResult(root, sink, "PreToolUse", {
    ...proposal,
    tool_use_id: "tool-first",
  });
  assert.equal(first.stdout, "", "la fenêtre Autoriser / Refuser appartient uniquement à Codex");
  let session = await new SessionStore(root).load("codex-thread-pipeline");
  assert.equal(session?.events.some((event) => event.ruleId === "destructive-git-command"), false);
  assert.equal(notifications.length, 0);

  await deliverResult(root, sink, "PreToolUse", {
    turn_id: "turn-command",
    tool_name: "Bash",
    tool_use_id: "tool-real",
    tool_input: { command: "git clean -fd" },
  });
  session = await new SessionStore(root).load("codex-thread-pipeline");
  const alert = session?.events.find((event) => event.ruleId === "destructive-git-command");
  assert.equal(alert?.level, "RED");
  assert.equal(readCurrentStatusSync(root).level, "RED");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.title ?? "", /^DriftLight · .+ — alerte rouge$/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /DriftLight (approve|reject)/);
});
