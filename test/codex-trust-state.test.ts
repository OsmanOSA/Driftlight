import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import { buildCodexHookCommands, CODEX_HOOK_DEFINITIONS } from "../src/adapters/codex/hook-config.js";
import { readCodexTrust, toCodexStateKey } from "../src/adapters/codex/trust-state.js";

interface Fixture {
  root: string;
  codexHome: string;
  adapter: CodexAdapter;
}

async function fixture(context: test.TestContext): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-codex-trust-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "Codex Home");
  await fs.mkdir(codexHome, { recursive: true });
  const adapter = new CodexAdapter({
    env: { CODEX_HOME: codexHome },
    detectCodex: async () => true,
    nodeExecutable: path.join(root, "node.exe"),
    hookEntry: path.join(root, "hook-cli.js"),
  });
  await adapter.install();
  return { root, codexHome, adapter };
}

/** Reproduit la forme réelle de `[hooks.state]` observée dans Codex 0.147. */
function writeTrust(
  codexHome: string,
  hooksPath: string,
  entries: Array<{ event: string; enabled?: boolean }>,
): Promise<void> {
  const blocks = entries.map(({ event, enabled }) => {
    const lines = [
      `[hooks.state.'${hooksPath}:${toCodexStateKey(event)}:0:0']`,
      `trusted_hash = "sha256:${event.toLowerCase()}"`,
    ];
    if (enabled === false) lines.push("enabled = false");
    return lines.join("\n");
  });
  return fs.writeFile(
    path.join(codexHome, "config.toml"),
    `approval_policy = "untrusted"\napprovals_reviewer = "user"\n\n[projects.'d:\\driftlight']\ntrust_level = "trusted"\n\n[hooks.state]\n\n${blocks.join("\n\n")}\n`,
    "utf8",
  );
}

const allEvents = CODEX_HOOK_DEFINITIONS.map((definition) => ({ event: definition.event }));

/** Rend les empreintes plus récentes que hooks.json, comme après une approbation. */
async function markTrustFresh(codexHome: string, hooksPath: string): Promise<void> {
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(codexHome, "config.toml"), later, later);
  const earlier = new Date(Date.now() - 60_000);
  await fs.utimes(hooksPath, earlier, earlier);
}

test("Codex: le champ command est exécutable sur la plateforme d'installation", () => {
  const nodeExe = String.raw`C:\Program Files\nodejs\node.exe`;
  const entry = String.raw`D:\Driftlight\dist\src\adapters\codex\hook-cli.js`;

  // Codex 0.147 sous Windows exécute `command` et ignore `commandWindows`.
  // EncodedCommand évite que cmd.exe transforme les guillemets des chemins.
  const windows = buildCodexHookCommands(nodeExe, entry, "win32");
  assert.equal(windows.command, windows.commandWindows);
  assert.match(windows.command, /^powershell\.exe .* -EncodedCommand /);

  const posix = buildCodexHookCommands("/usr/bin/node", "/opt/driftlight/hook-cli.js", "darwin");
  assert.match(posix.command, /^'\/usr\/bin\/node'/, "POSIX hosts keep POSIX quoting");
  assert.notEqual(posix.command, posix.commandWindows);
});

test("Codex: le nom d'état suit la convention snake_case de Codex", () => {
  assert.equal(toCodexStateKey("PreToolUse"), "pre_tool_use");
  assert.equal(toCodexStateKey("UserPromptSubmit"), "user_prompt_submit");
  assert.equal(toCodexStateKey("SubagentStart"), "subagent_start");
  assert.equal(toCodexStateKey("Stop"), "stop");
});

test("Codex: un hook explicitement désactivé est lu comme tel", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await writeTrust(codexHome, adapter.hooksPath, [
    ...allEvents.filter((entry) => entry.event !== "PreToolUse"),
    { event: "PreToolUse", enabled: false },
  ]);

  const trust = await readCodexTrust(adapter.hooksPath, { env: { CODEX_HOME: codexHome } });
  assert.equal(trust.configPresent, true);
  assert.deepEqual(trust.disabledEvents, ["PreToolUse"]);
  assert.deepEqual(trust.unregisteredEvents, []);
  // L'absence de clé `enabled` vaut actif : Codex ne l'écrit que pour désactiver.
  assert.equal(trust.hooks.find((hook) => hook.event === "PostToolUse")?.enabled, true);
});

test("Codex: une configuration absente ne fait pas passer les hooks pour approuvés", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await fs.rm(path.join(codexHome, "config.toml"), { force: true });
  const trust = await readCodexTrust(adapter.hooksPath, { env: { CODEX_HOME: codexHome } });

  assert.equal(trust.configPresent, false);
  assert.equal(trust.unregisteredEvents.length, CODEX_HOOK_DEFINITIONS.length);
  assert.equal(trust.hooks.every((hook) => !hook.enabled), true, "unknown must never read as enabled");
  assert.equal(trust.staleTrust, false, "nothing was ever trusted, so nothing can be stale");
});

test("Codex: l'état de confiance d'un autre fichier de hooks est ignoré", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await writeTrust(codexHome, path.join(codexHome, "autre-hooks.json"), allEvents);

  const trust = await readCodexTrust(adapter.hooksPath, { env: { CODEX_HOME: codexHome } });
  assert.equal(trust.unregisteredEvents.length, CODEX_HOOK_DEFINITIONS.length);
});

test("Codex: status nomme le hook désactivé au lieu d'accuser l'approbation", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await writeTrust(codexHome, adapter.hooksPath, [
    ...allEvents.filter((entry) => entry.event !== "PreToolUse"),
    { event: "PreToolUse", enabled: false },
  ]);
  await markTrustFresh(codexHome, adapter.hooksPath);

  const status = await adapter.healthCheck();
  assert.equal(status.state, "HOOKS_DISABLED");
  assert.deepEqual(status.blockingEvents, ["PreToolUse"]);
  assert.match(status.message ?? "", /PreToolUse/);
  assert.equal(status.hooks?.find((hook) => hook.event === "PreToolUse")?.enabled, false);
  assert.equal(status.trustPath, path.join(codexHome, "config.toml"));
});

test("Codex: status distingue une approbation jamais donnée", async (context) => {
  const { adapter } = await fixture(context);
  const status = await adapter.healthCheck();

  assert.equal(status.state, "INSTALLED_NEEDS_APPROVAL");
  assert.equal(status.blockingEvents?.length, CODEX_HOOK_DEFINITIONS.length);
  assert.match(status.message ?? "", /\/hooks/);
});

test("Codex: une politique native absente est signalée même après un événement reçu", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await fs.rm(path.join(codexHome, "config.toml"), { force: true });
  await adapter.recordEventReceived();

  const status = await adapter.healthCheck();
  assert.equal(status.state, "DEGRADED");
  assert.ok(status.lastEventAt);
  assert.match(status.message ?? "", /approval_policy=untrusted/);
});

test("Codex: un hook désactivé prime en revanche sur un événement reçu", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await adapter.recordEventReceived();
  await writeTrust(codexHome, adapter.hooksPath, [
    ...allEvents.filter((entry) => entry.event !== "PreToolUse"),
    { event: "PreToolUse", enabled: false },
  ]);
  await markTrustFresh(codexHome, adapter.hooksPath);

  // D'autres hooks peuvent alimenter lastEventAt pendant que PreToolUse est mort :
  // c'est le cas réel où l'utilisateur « ne reçoit pas les modifications ».
  const status = await adapter.healthCheck();
  assert.equal(status.state, "HOOKS_DISABLED");
  assert.deepEqual(status.blockingEvents, ["PreToolUse"]);
});

/** Approbation d'abord, réécriture de hooks.json ensuite : l'ordre du cas réel. */
async function makeTrustStale(codexHome: string, hooksPath: string): Promise<void> {
  const trustedAt = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(codexHome, "config.toml"), trustedAt, trustedAt);
  const rewrittenAt = new Date();
  await fs.utimes(hooksPath, rewrittenAt, rewrittenAt);
}

test("Codex: status détecte des empreintes périmées par réécriture des hooks", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await writeTrust(codexHome, adapter.hooksPath, allEvents);
  await makeTrustStale(codexHome, adapter.hooksPath);

  const status = await adapter.healthCheck();
  assert.equal(status.state, "TRUST_STALE");
  assert.match(status.message ?? "", /périmées/);
});

test("Codex: la péremption prime sur un hook désactivé et signale les deux", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await writeTrust(codexHome, adapter.hooksPath, [
    ...allEvents.filter((entry) => entry.event !== "PreToolUse"),
    { event: "PreToolUse", enabled: false },
  ]);
  await makeTrustStale(codexHome, adapter.hooksPath);

  // Les deux défauts coexistent. Signaler le blocage partiel ferait corriger le
  // symptôme mineur en laissant le majeur : plus aucun hook ne s'exécute.
  const status = await adapter.healthCheck();
  assert.equal(status.state, "TRUST_STALE");
  assert.match(status.message ?? "", /aucun hook/);
  assert.match(status.message ?? "", /PreToolUse/, "the disabled hook must still be named");
  assert.equal(
    status.blockingEvents?.length,
    CODEX_HOOK_DEFINITIONS.length,
    "stale trust blocks every registered hook, not just the disabled one",
  );
});

test("Codex: status ne déclare CONNECTED qu'avec des hooks actifs et un événement reçu", async (context) => {
  const { codexHome, adapter } = await fixture(context);
  await writeTrust(codexHome, adapter.hooksPath, allEvents);
  await markTrustFresh(codexHome, adapter.hooksPath);

  // Hooks approuvés mais aucun événement : la session n'a pas encore été relancée.
  const pending = await adapter.healthCheck();
  assert.equal(pending.state, "INSTALLED_NEEDS_APPROVAL");
  assert.match(pending.message ?? "", /nouvelle session/);

  await adapter.recordEventReceived();
  await markTrustFresh(codexHome, adapter.hooksPath);
  const connected = await adapter.healthCheck();
  assert.equal(connected.state, "CONNECTED");
  assert.ok(connected.lastEventAt);
  assert.equal(connected.hooks?.every((hook) => hook.enabled), true);
});
