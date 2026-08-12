import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeSettingsPath,
  mergeClaudeHookSettings,
  removeClaudeHookSettings,
  uninstallClaudeHooks,
} from "../src/claude/installer.js";
import { handleClaudeHook } from "../src/claude/handler.js";
import type { ClaudeHookInput } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";
import { redactSensitiveText } from "../src/shared/redact.js";
import { ensurePrivateHome, STATE_DIRECTORY_MODE } from "../src/shared/state-paths.js";

/**
 * Ce qui atterrit sur la machine d'un testeur.
 *
 * DriftLight observe des sessions entières : les demandes de l'utilisateur et
 * les commandes proposées par l'agent passent par lui. Ce qu'il en conserve
 * n'engage pas seulement sa propre sécurité, mais celle de quiconque accepte
 * de l'installer — d'où ces vérifications séparées du reste.
 */

function hook(root: string, event: string, extra: Record<string, unknown> = {}): ClaudeHookInput {
  return { session_id: "confidentialite", cwd: root, hook_event_name: event, ...extra } as ClaudeHookInput;
}

async function repository(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-privacy-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "a@b.c"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return root;
}

/**
 * Une commande portant un jeton en argument déclenche une alerte, donc s'écrit
 * dans l'historique de session. Sans expurgation, ce jeton resterait en clair
 * sur le disque bien après la fin de la session qui l'a produit.
 */
test("a secret carried by a command never reaches the session history", async (context) => {
  const root = await repository(context);
  await handleClaudeHook(hook(root, "SessionStart", { source: "startup" }));
  await handleClaudeHook(hook(root, "UserPromptSubmit", { prompt: "Mets à jour README.md", prompt_id: "t1" }));

  const output = await handleClaudeHook(hook(root, "PreToolUse", {
    tool_name: "Bash",
    tool_input: { command: 'terraform destroy -auto-approve -var="token=sk-live-9f2ab77c41de88b0"' },
  }));

  const session = await new SessionStore(root).load("claude-confidentialite");
  const raw = JSON.stringify(session);
  assert.ok(!raw.includes("9f2ab77c41de88b0"), "aucun secret ne doit subsister dans l'état écrit");
  assert.match(raw, /REDACTED/);

  // Le même texte repart vers l'agent : l'expurger d'un seul côté ne suffirait pas.
  const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.ok(!reason.includes("9f2ab77c41de88b0"));
});

test("redaction covers the shapes a token usually takes", () => {
  const redacted = redactSensitiveText(
    "AKIAIOSFODNN7EXAMPLE sk-abcdefghijklmnopqrst Authorization: Bearer eyJhbGciOi password=hunter2",
  );
  for (const secret of ["AKIAIOSFODNN7EXAMPLE", "sk-abcdefghijklmnopqrst", "eyJhbGciOi", "hunter2"]) {
    assert.ok(!redacted.includes(secret), `${secret} ne doit pas survivre`);
  }
});

/**
 * L'état contient les demandes de l'utilisateur. Sur une machine partagée, les
 * droits par défaut d'un dossier POSIX le rendraient lisible par les autres
 * comptes locaux.
 */
test("the state directory is created for its owner only", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-home-mode-"));
  context.after(async () => await fs.rm(home, { recursive: true, force: true }));
  const previous = process.env.DRIFTLIGHT_HOME;
  process.env.DRIFTLIGHT_HOME = path.join(home, "etat");
  context.after(() => {
    if (previous === undefined) delete process.env.DRIFTLIGHT_HOME;
    else process.env.DRIFTLIGHT_HOME = previous;
  });

  const created = ensurePrivateHome();
  assert.equal(created, path.join(home, "etat"));
  if (process.platform !== "win32") {
    assert.equal(statSync(created).mode & 0o777, STATE_DIRECTORY_MODE);
  }
});

// --- Désinstallation ----------------------------------------------------------

const handler = {
  type: "command" as const,
  command: "driftlight",
  args: ["hook"],
  timeout: 10,
  statusMessage: "DriftLight observe localement…",
};

/**
 * Un outil qu'on ne sait pas désinstaller ne se partage pas : un testeur doit
 * pouvoir revenir en arrière sans éditer un JSON à la main.
 */
test("uninstalling removes every DriftLight hook and nothing else", () => {
  const settings = mergeClaudeHookSettings({}, { ...handler });
  const preToolUse = (settings.hooks as Record<string, unknown[]>).PreToolUse;
  assert.ok(Array.isArray(preToolUse));
  preToolUse.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: "autre-outil", args: ["--surveille"] }],
  });

  const { settings: cleaned, removed } = removeClaudeHookSettings(settings);
  assert.ok(removed > 0, "les hooks DriftLight doivent être retirés");
  const remaining = JSON.stringify(cleaned);
  assert.ok(!remaining.includes("\"hook\""), "aucun hook DriftLight ne subsiste");
  assert.match(remaining, /autre-outil/, "les hooks d'un autre outil sont laissés intacts");
});

test("uninstalling twice is not an error, and reports honestly", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-uninstall-"));
  context.after(async () => await fs.rm(cwd, { recursive: true, force: true }));

  const empty = await uninstallClaudeHooks({ cwd });
  assert.equal(empty.removed, 0, "sans configuration, il n'y a rien à retirer");

  await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
  await fs.writeFile(
    claudeSettingsPath({ cwd }),
    JSON.stringify(mergeClaudeHookSettings({}, { ...handler })),
  );

  const first = await uninstallClaudeHooks({ cwd });
  assert.ok(first.removed > 0);
  const second = await uninstallClaudeHooks({ cwd });
  assert.equal(second.removed, 0);
});

test("a settings file untouched by DriftLight is left byte-for-byte alone", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-foreign-"));
  context.after(async () => await fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
  const original = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "eslint" }] }] } });
  await fs.writeFile(claudeSettingsPath({ cwd }), original);

  const outcome = await uninstallClaudeHooks({ cwd });
  assert.equal(outcome.removed, 0);
  assert.equal(await fs.readFile(claudeSettingsPath({ cwd }), "utf8"), original);
});
