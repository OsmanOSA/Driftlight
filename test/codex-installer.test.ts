import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import {
  buildCodexHookCommands,
  CODEX_HOOK_DEFINITIONS,
  countDriftLightCodexHandlers,
  quotePosixArgument,
  quoteWindowsArgument,
  type CodexHooksDocument,
} from "../src/adapters/codex/hook-config.js";
import { codexHooksPath, resolveCodexHome } from "../src/adapters/codex/paths.js";

async function fixture(): Promise<{ root: string; codexHome: string; adapter: CodexAdapter }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-codex-installer-"));
  const codexHome = path.join(root, "Codex Home");
  await fs.mkdir(codexHome, { recursive: true });
  const adapter = new CodexAdapter({
    env: { CODEX_HOME: codexHome },
    detectCodex: async () => true,
    nodeExecutable: path.join(root, "Node Runtime", "node.exe"),
    hookEntry: path.join(root, "Drift Light", "hook-cli.js"),
    now: () => new Date("2026-08-09T10:00:00.000Z"),
  });
  return { root, codexHome, adapter };
}

async function readConfig(adapter: CodexAdapter): Promise<CodexHooksDocument> {
  return JSON.parse(await fs.readFile(adapter.hooksPath, "utf8")) as CodexHooksDocument;
}

async function readToml(adapter: CodexAdapter): Promise<string> {
  return await fs.readFile(adapter.configPath, "utf8");
}

test("Codex: installation sans configuration existante", async (context) => {
  const { root, adapter } = await fixture();
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await adapter.install();
  const config = await readConfig(adapter);
  assert.equal(countDriftLightCodexHandlers(config), CODEX_HOOK_DEFINITIONS.length);
  assert.deepEqual(Object.keys(config.hooks ?? {}).sort(), CODEX_HOOK_DEFINITIONS.map((item) => item.event).sort());
  assert.match(await readToml(adapter), /^approval_policy = "untrusted"$/m);
  assert.match(await readToml(adapter), /^approvals_reviewer = "user"$/m);
  assert.equal((await adapter.healthCheck()).state, "INSTALLED_NEEDS_APPROVAL");
});

test("Codex: installation préserve les hooks utilisateur", async (context) => {
  const { root, adapter } = await fixture();
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const thirdParty = {
    description: "existing user hooks",
    hooks: {
      PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "third-party check" }] }],
      CustomFutureEvent: [{ hooks: [{ type: "command", command: "future-hook" }] }],
    },
    futureTopLevelField: { enabled: true },
  };
  await fs.writeFile(adapter.hooksPath, `${JSON.stringify(thirdParty, null, 2)}\n`, "utf8");

  await adapter.install();
  const config = await readConfig(adapter);
  assert.equal(config.description, thirdParty.description);
  assert.deepEqual(config.futureTopLevelField, thirdParty.futureTopLevelField);
  const preToolUse = config.hooks?.PreToolUse as unknown[];
  assert.deepEqual(preToolUse[0], thirdParty.hooks.PreToolUse[0]);
  assert.deepEqual(config.hooks?.CustomFutureEvent, thirdParty.hooks.CustomFutureEvent);
});

test("Codex: installation répétée reste idempotente", async (context) => {
  const { root, adapter } = await fixture();
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await adapter.install();
  await adapter.install();
  assert.equal(countDriftLightCodexHandlers(await readConfig(adapter)), CODEX_HOOK_DEFINITIONS.length);
  const config = await readToml(adapter);
  assert.equal((config.match(/^approval_policy\s*=/gm) ?? []).length, 1);
  assert.equal((config.match(/^approvals_reviewer\s*=/gm) ?? []).length, 1);
});

test("Codex: uninstall restaure intégralement les hooks tiers", async (context) => {
  const { root, adapter } = await fixture();
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const original: CodexHooksDocument = {
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "notes-loader" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "policy-check" }] }],
    },
    custom: "preserve-me",
  };
  await fs.writeFile(adapter.hooksPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  const originalToml = [
    'model = "gpt-5.6-sol"',
    'approval_policy = "on-request"',
    'approvals_reviewer = "auto_review"',
    '',
  ].join("\n");
  await fs.writeFile(adapter.configPath, originalToml, "utf8");

  await adapter.install();
  await adapter.uninstall();
  assert.deepEqual(await readConfig(adapter), original);
  assert.equal(await readToml(adapter), originalToml);
});

test("Codex: chemins globaux macOS et Windows suivent CODEX_HOME", () => {
  assert.equal(resolveCodexHome({ platform: "darwin", homeDir: "/Users/ada", env: {} }), "/Users/ada/.codex");
  assert.equal(codexHooksPath({ platform: "darwin", homeDir: "/Users/ada", env: {} }), "/Users/ada/.codex/hooks.json");
  assert.equal(resolveCodexHome({ platform: "win32", homeDir: "C:\\Users\\Ada", env: {} }), "C:\\Users\\Ada\\.codex");
  assert.equal(codexHooksPath({
    platform: "win32",
    homeDir: "C:\\Users\\Ada",
    env: { CODEX_HOME: "D:\\Codex Data" },
  }), "D:\\Codex Data\\hooks.json");
});

test("Codex: commandes macOS et Windows échappent les chemins avec espaces", () => {
  assert.equal(quotePosixArgument("/Applications/Drift Light/hook.js"), "'/Applications/Drift Light/hook.js'");
  assert.equal(quoteWindowsArgument("C:\\Program Files\\nodejs\\node.exe"), '"C:\\Program Files\\nodejs\\node.exe"');
  const commands = buildCodexHookCommands(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files\\DriftLight\\hook-cli.js",
  );
  assert.match(commands.commandWindows, /^powershell\.exe .* -EncodedCommand /);
  const encoded = commands.commandWindows.split(" ").at(-1);
  assert.ok(encoded);
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, /'C:\\Program Files\\DriftLight\\hook-cli\.js'/);
  assert.match(script, /driftlight-codex-v1/);
});

test("Codex: la commande Windows s'exécute réellement via cmd.exe avec un chemin contenant des espaces", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Test spécifique à cmd.exe.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight codex command "));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const hookEntry = path.join(root, "Drift Light", "hook test.cjs");
  await fs.mkdir(path.dirname(hookEntry), { recursive: true });
  await fs.writeFile(hookEntry, "process.stdin.resume();\n", "utf8");

  const commands = buildCodexHookCommands("C:\\Program Files\\nodejs\\node.exe", hookEntry, "win32");
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commands.commandWindows], {
    cwd: root,
    input: "{}\n",
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("Codex: la définition conserve le délai déjà approuvé tout en respectant SessionEnd", () => {
  for (const definition of CODEX_HOOK_DEFINITIONS) {
    assert.equal(
      definition.timeout,
      3,
      `${definition.event} conserve la définition de confiance existante`,
    );
  }
});

test("Codex: un événement reçu ne contourne pas l'approbation des hooks", async (context) => {
  const { root, adapter } = await fixture();
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await adapter.install();
  await adapter.recordEventReceived();
  const status = await adapter.healthCheck();
  assert.equal(status.state, "INSTALLED_NEEDS_APPROVAL");
  assert.equal(status.lastEventAt, "2026-08-09T10:00:00.000Z");
});
