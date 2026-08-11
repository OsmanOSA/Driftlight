import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleClaudeHook } from "../src/claude/handler.js";
import { claudeSettingsPath, installClaudeHooks } from "../src/claude/installer.js";
import { loadConfigSync } from "../src/config/config.js";
import type { ClaudeHookInput } from "../src/domain/types.js";
import { SessionStore } from "../src/session/store.js";
import { copyThenRemove, driftlightHome, projectStateDirectory } from "../src/shared/state-paths.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function temporaryDirectory(context: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repository(context: test.TestContext): Promise<string> {
  const root = await temporaryDirectory(context, "driftlight-global-");
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function hook(cwd: string, event: string, extra: Record<string, unknown> = {}): ClaudeHookInput {
  return { session_id: "global-mode", cwd, hook_event_name: event, ...extra } as ClaudeHookInput;
}

/**
 * Le mode global déclenche les hooks dans tout dossier ouvert, dépôt ou non.
 * Sans dépôt il n'existe ni baseline ni frontière : parcourir et hacher un
 * répertoire personnel entier à chaque appel d'outil serait inacceptable.
 */
test("outside a Git repository DriftLight stays completely silent", async (context) => {
  const plain = await temporaryDirectory(context, "driftlight-not-a-repo-");
  await fs.writeFile(path.join(plain, "notes.txt"), "contenu personnel\n");

  assert.equal(await handleClaudeHook(hook(plain, "SessionStart", { source: "startup" })), undefined);
  assert.equal(
    await handleClaudeHook(hook(plain, "UserPromptSubmit", { prompt: "Fais quelque chose", prompt_id: "t1" })),
    undefined,
  );
  const write = await handleClaudeHook(hook(plain, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(plain, ".env"), content: "SECRET=1\n" },
  }));
  assert.equal(write, undefined, "même un chemin sensible ne déclenche rien hors dépôt");

  assert.equal(existsSync(path.join(plain, ".driftlight")), false, "aucun dossier créé dans le répertoire");
});

test("an observed repository never receives DriftLight state", async (context) => {
  const root = await repository(context);
  await handleClaudeHook(hook(root, "SessionStart", { source: "startup" }));
  await handleClaudeHook(hook(root, "UserPromptSubmit", { prompt: "Corrige README.md", prompt_id: "t1" }));

  // Le dépôt observé doit rester exactement tel que l'utilisateur l'a laissé :
  // rien de nouveau dans `git status`, donc rien à commiter par accident.
  assert.equal(existsSync(path.join(root, ".driftlight")), false);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.equal(status.trim(), "", "le dépôt observé reste propre");

  const state = projectStateDirectory(root);
  assert.ok(state.startsWith(driftlightHome()), "l'état vit sous la racine DriftLight de la machine");
  assert.ok(existsSync(path.join(state, "current-intent.json")));
  assert.ok(await new SessionStore(root).load("claude-global-mode"));
});

test("two projects sharing a directory name keep separate state", async (context) => {
  const first = await repository(context);
  const second = await repository(context);
  assert.notEqual(projectStateDirectory(first), projectStateDirectory(second));
});

/**
 * Les installations antérieures rangeaient tout dans `<dépôt>/.driftlight/`.
 * L'historique doit survivre au passage en central, sans emporter la
 * configuration, qui est un choix de l'utilisateur attaché au projet.
 */
test("existing in-repository state is adopted, and its configuration stays behind", async (context) => {
  const root = await repository(context);
  const legacy = path.join(root, ".driftlight");
  await fs.mkdir(path.join(legacy, "sessions"), { recursive: true });
  await fs.writeFile(path.join(legacy, "sessions", "old.json"), '{"id":"old"}');
  await fs.writeFile(path.join(legacy, "current-status.json"), '{"level":"GREEN"}');
  await fs.writeFile(path.join(legacy, "config.json"), JSON.stringify({ blockOnOrange: true }));

  const state = projectStateDirectory(root);
  assert.ok(existsSync(path.join(state, "sessions", "old.json")), "l'historique est repris");
  assert.ok(existsSync(path.join(state, "current-status.json")));
  assert.equal(existsSync(path.join(state, "config.json")), false, "la configuration ne part pas");
  assert.ok(existsSync(path.join(legacy, "config.json")), "la configuration reste dans le dépôt");
  assert.equal(loadConfigSync(root).blockOnOrange, true, "et reste appliquée après reprise");

  const marker = JSON.parse(await fs.readFile(path.join(state, "project.json"), "utf8")) as { root: string };
  assert.equal(marker.root, path.resolve(root), "l'état sait de quel projet il provient");
});

/**
 * Régression : un dépôt sur `D:` et un profil sur `C:` ne peuvent pas être
 * reliés par un renommage. Le cas est courant sous Windows, et un repli
 * silencieux sur l'ancien emplacement annulerait le passage en central.
 */
test("state crosses a volume boundary without a rename", async (context) => {
  const source = await temporaryDirectory(context, "driftlight-legacy-");
  const destination = path.join(await temporaryDirectory(context, "driftlight-central-"), "adopted");
  await fs.mkdir(path.join(source, "sessions"), { recursive: true });
  await fs.writeFile(path.join(source, "sessions", "old.json"), '{"id":"cross-volume"}');
  await fs.writeFile(path.join(source, "current-status.json"), '{"level":"GREEN"}');

  copyThenRemove(source, destination);

  assert.equal(
    await fs.readFile(path.join(destination, "sessions", "old.json"), "utf8"),
    '{"id":"cross-volume"}',
    "l'arborescence complète traverse la frontière",
  );
  assert.ok(existsSync(path.join(destination, "current-status.json")));
  assert.equal(existsSync(source), false, "l'ancien emplacement ne subsiste pas en double");
});

test("a repository holding only a configuration is left untouched", async (context) => {
  const root = await repository(context);
  await fs.mkdir(path.join(root, ".driftlight"), { recursive: true });
  await fs.writeFile(path.join(root, ".driftlight", "config.json"), JSON.stringify({ blockOnRed: false }));

  projectStateDirectory(root);
  assert.ok(existsSync(path.join(root, ".driftlight", "config.json")), "rien à migrer, rien de déplacé");
  assert.equal(loadConfigSync(root).blockOnRed, false);
});

test("global installation targets the user settings, per-project stays local", async (context) => {
  const home = await temporaryDirectory(context, "driftlight-home-");
  const root = await repository(context);

  assert.equal(
    claudeSettingsPath({ cwd: root, global: true, homeDir: home }),
    path.join(home, ".claude", "settings.json"),
  );
  assert.equal(
    claudeSettingsPath({ cwd: root, global: false }),
    path.join(root, ".claude", "settings.local.json"),
  );

  const written = await installClaudeHooks({ cwd: root, global: false });
  assert.equal(written, path.join(root, ".claude", "settings.local.json"));
  const settings = JSON.parse(await fs.readFile(written, "utf8")) as { hooks?: Record<string, unknown> };
  assert.ok(settings.hooks?.PreToolUse, "les hooks sont bien écrits");
});

test("machine preferences apply everywhere and a repository can still diverge", async (context) => {
  const root = await repository(context);
  const globalFile = path.join(driftlightHome(), "config.json");
  await fs.mkdir(path.dirname(globalFile), { recursive: true });
  context.after(async () => await fs.rm(globalFile, { force: true }));

  await fs.writeFile(globalFile, JSON.stringify({ notifyOnOrange: true, blockOnRed: false }));
  const inherited = loadConfigSync(root);
  assert.equal(inherited.notifyOnOrange, true, "la préférence machine s'applique au projet");
  assert.equal(inherited.blockOnRed, false);

  await fs.mkdir(path.join(root, ".driftlight"), { recursive: true });
  await fs.writeFile(path.join(root, ".driftlight", "config.json"), JSON.stringify({ blockOnRed: true }));
  const overridden = loadConfigSync(root);
  assert.equal(overridden.blockOnRed, true, "le dépôt a le dernier mot");
  assert.equal(overridden.notifyOnOrange, true, "ce qu'il ne dit pas reste hérité de la machine");
});
