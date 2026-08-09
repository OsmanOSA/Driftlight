#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { handleClaudeHook } from "./claude/handler.js";
import { installClaudeHooks } from "./claude/installer.js";
import type { ClaudeHookInput, SessionRecord } from "./domain/types.js";
import { PollingObserver } from "./observer/polling-observer.js";
import {
  addIntent,
  createSession,
  loadRequestedSession,
  processChanges,
  resolveSessionStore,
} from "./session/service.js";
import { SessionStore } from "./session/store.js";
import { formatSessionSummary, formatSignal } from "./ui/terminal.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[], command: string): string[] {
  const result: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    result.push(value);
  }
  return command === args[0] ? result : args;
}

function help(): string {
  return `DriftLight — voyant local de dérive pour coding agents

Commandes :
  driftlight start --task "Demande utilisateur" [--cwd .] [--interval 400]
  driftlight status [--session latest] [--cwd .]
  driftlight mark-expected <event-id> [--session latest] [--cwd .]
  driftlight add-scope "Nouvelle instruction ou chemin" [--session latest] [--cwd .]
  driftlight claude install [--cwd .]
  driftlight hook                       # appelé par Claude Code via stdin JSON

Tout reste local dans .driftlight/. Aucune action n'est bloquée et aucun rollback n'est exécuté.`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runStart(args: string[]): Promise<void> {
  const task = option(args, "--task") ?? positional(args, "start").join(" ");
  if (!task.trim()) throw new Error("La commande start exige --task \"…\".");
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  const interval = Number(option(args, "--interval") ?? "400");
  if (!Number.isFinite(interval) || interval < 50) throw new Error("--interval doit être un nombre supérieur ou égal à 50 ms.");

  const session = await createSession({ cwd, task, source: "cli" });
  const store = new SessionStore(session.cwd);
  await store.save(session);
  console.log(`🟢 DriftLight · surveillance locale active`);
  console.log(`   ${session.id} · ${session.baseline.branch ?? "hors Git"} · ${session.baseline.files.length} changement(s) préexistant(s) protégé(s)`);

  const observer = new PollingObserver(session.cwd, session.initialSnapshot, interval);
  observer.start(async ({ changes, snapshot }) => {
    const events = processChanges(session, changes, snapshot);
    await store.save(session);
    for (const event of events) console.log(formatSignal(event));
  });

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const finish = (): void => {
      if (closing) return;
      closing = true;
      observer.stop();
      void (async () => {
        try {
          const finalBatch = await observer.scanOnce();
          if (finalBatch.changes.length > 0) {
            const events = processChanges(session, finalBatch.changes, finalBatch.snapshot);
            for (const event of events) console.log(formatSignal(event));
          }
          session.endedAt = new Date().toISOString();
          await store.save(session);
          console.log(`DriftLight · session enregistrée dans ${store.sessionPath(session.id)}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function requestedSession(args: string[]): Promise<{ store: SessionStore; session: SessionRecord }> {
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  const store = await resolveSessionStore(cwd);
  const session = await loadRequestedSession(store, option(args, "--session"));
  if (!session) throw new Error("Aucune session DriftLight trouvée.");
  return { store, session };
}

async function runStatus(args: string[]): Promise<void> {
  const { session } = await requestedSession(args);
  console.log(formatSessionSummary(session));
}

async function runMarkExpected(args: string[]): Promise<void> {
  const eventId = positional(args, "mark-expected")[0];
  if (!eventId) throw new Error("Indiquez l'identifiant de l'événement à acquitter.");
  const { store, session } = await requestedSession(args);
  const event = session.events.find((item) => item.id === eventId);
  if (!event) throw new Error(`Événement introuvable : ${eventId}`);
  event.expected = true;
  if (!session.expectedEventIds.includes(eventId)) session.expectedEventIds.push(eventId);
  await store.save(session);
  console.log(`✓ ${eventId} marqué comme attendu pour cette alerte.`);
}

async function runAddScope(args: string[]): Promise<void> {
  const text = option(args, "--text") ?? positional(args, "add-scope").join(" ");
  if (!text.trim()) throw new Error("Indiquez l'instruction ou le chemin à ajouter au scope.");
  const { store, session } = await requestedSession(args);
  addIntent(session, text, "manual-scope");
  await store.save(session);
  console.log(`✓ Scope actif mis à jour (version ${session.intents.length}) : ${text}`);
}

async function runClaude(args: string[]): Promise<void> {
  if (args[1] !== "install") throw new Error("Commande attendue : driftlight claude install");
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  const settingsPath = await installClaudeHooks({ cwd });
  console.log(`✓ Hooks Claude Code installés sans remplacer les hooks existants : ${settingsPath}`);
  console.log(`  Mode observation uniquement : aucune décision allow/deny n'est renvoyée.`);
}

async function runHook(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;
  const input = JSON.parse(raw) as ClaudeHookInput;
  const output = await handleClaudeHook(input);
  if (output) process.stdout.write(JSON.stringify(output));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  switch (command) {
    case "start": await runStart(args); break;
    case "status": await runStatus(args); break;
    case "mark-expected": await runMarkExpected(args); break;
    case "add-scope": await runAddScope(args); break;
    case "claude": await runClaude(args); break;
    case "hook": await runHook(); break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(help());
      break;
    default:
      throw new Error(`Commande inconnue : ${command}\n\n${help()}`);
  }
}

const invokedEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedEntry) {
  void main().catch((error: unknown) => {
    console.error(`DriftLight : ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
