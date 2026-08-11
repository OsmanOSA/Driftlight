import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleClaudeHook } from "../src/claude/handler.js";
import type { ClaudeHookInput, SessionEvent } from "../src/domain/types.js";
import { writeCurrentIntent } from "../src/intent/current-intent.js";
import { SessionStore } from "../src/session/store.js";

/**
 * Deux fenêtres de l'agent ouvertes sur le même dépôt poursuivent deux demandes
 * différentes. Tant que l'intention était stockée par dépôt, la dernière à
 * parler écrasait celle des autres — cas rare en installation par projet,
 * ordinaire dès que DriftLight est installé sur toute la machine.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function repository(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-concurrent-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "alpha.ts"), "export const alpha = 1;\n".repeat(40));
  await fs.writeFile(path.join(root, "src", "beta.ts"), "export const beta = 1;\n".repeat(40));
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

const hook = (id: string, cwd: string, event: string, extra: Record<string, unknown> = {}): ClaudeHookInput =>
  ({ session_id: id, cwd, hook_event_name: event, ...extra }) as ClaudeHookInput;

async function open(root: string, id: string, prompt: string): Promise<void> {
  await handleClaudeHook(hook(id, root, "SessionStart", { source: "startup" }));
  await handleClaudeHook(hook(id, root, "UserPromptSubmit", { prompt, prompt_id: `turn-${id}` }));
}

async function write(root: string, id: string, relative: string): Promise<void> {
  await handleClaudeHook(hook(id, root, "PreToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ...relative.split("/")), content: "vide\n" },
  }));
}

async function eventsFor(root: string, id: string, relative: string): Promise<SessionEvent[]> {
  const session = await new SessionStore(root).load(`claude-${id}`);
  return (session?.events ?? []).filter((event) => event.path === relative);
}

test("each session is judged against its own request, not the last one heard", async (context) => {
  const root = await repository(context);
  await open(root, "alpha-session", "Réécris entièrement src/alpha.ts");
  await open(root, "beta-session", "Réécris entièrement src/beta.ts");

  await write(root, "alpha-session", "src/alpha.ts");
  await write(root, "beta-session", "src/beta.ts");

  for (const [id, file] of [["alpha-session", "src/alpha.ts"], ["beta-session", "src/beta.ts"]] as const) {
    const [event] = await eventsFor(root, id, file);
    assert.equal(event?.level, "GREEN", `${id} a nommé ${file} et ne doit pas être alertée`);
    assert.equal(event?.exemptedBy, "named-in-intent");
  }
});

/**
 * La direction dangereuse : une alerte manquée, pas seulement du bruit. Le
 * fichier nommé par une session ne doit jamais blanchir sa destruction par une
 * autre, qui elle est bien hors de son périmètre.
 */
test("one session's request never exempts another session's destruction", async (context) => {
  const root = await repository(context);
  await open(root, "alpha-session", "Corrige un détail dans src/alpha.ts");
  await open(root, "beta-session", "Réécris entièrement src/beta.ts");

  // La session alpha détruit beta.ts, que seule la session beta avait nommé.
  await write(root, "alpha-session", "src/beta.ts");

  const [event] = await eventsFor(root, "alpha-session", "src/beta.ts");
  assert.notEqual(event, undefined, "la destruction doit être enregistrée");
  assert.notEqual(event?.level, "GREEN", "détruire hors de sa propre demande doit alerter");
  assert.equal(event?.exemptedBy, undefined, "aucune exemption ne peut venir d'une autre session");
});

test("a session opened before the split falls back to the shared intent", async (context) => {
  const root = await repository(context);
  // État hérité : une intention partagée, sans fichier propre à la session.
  await writeCurrentIntent(root, "Réécris entièrement src/alpha.ts", { turnId: "legacy-turn" });
  await handleClaudeHook(hook("legacy-session", root, "PostToolUse", {
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "src", "alpha.ts") },
  }));

  await write(root, "legacy-session", "src/alpha.ts");

  const [event] = await eventsFor(root, "legacy-session", "src/alpha.ts");
  assert.equal(event?.level, "GREEN", "une session en cours ne doit pas régresser à la mise à jour");
  assert.equal(event?.exemptedBy, "named-in-intent");
});
