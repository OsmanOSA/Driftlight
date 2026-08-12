#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { CodexAdapter } from "./adapters/codex/adapter.js";
import {
  describeSuppression,
  learnedSuppressions,
  LEARNING_MINIMUM_FILES,
  LEARNING_MINIMUM_SAMPLE,
  LEARNING_NOISE_RATIO,
} from "./classification/adaptation.js";
import { feedbackStatsPath, readFeedbackStats } from "./classification/feedback-stats.js";
import { loadNativeBackend, type NativeNotification } from "./notify/backend.js";
import { severityIconPath } from "./notify/icons.js";
import { identityStatus, installIdentity, removeIdentity } from "./notify/identity.js";
import { showWindowsPanel, WINDOWS_PANEL_STARTUP_MS } from "./notify/windows-panel.js";
import { dismissWindowsToasts } from "./notify/windows-toast.js";
import { loadScoringConfigSync } from "./config/scoring-config.js";
import { runHookSafely, type SafeHookOutcome } from "./claude/safe-hook.js";
import { installClaudeHooks, isInstalledPackage, uninstallClaudeHooks } from "./claude/installer.js";
import type { ClaudeHookInput, SessionRecord } from "./domain/types.js";
import { loadConfigSync } from "./config/config.js";
import { captureGitBaseline, resolveObservableRoot } from "./git/baseline.js";
import { addCurrentScope, writeCurrentIntent } from "./intent/current-intent.js";
import { dispatchNotifications } from "./notify/dispatcher.js";
import { PollingObserver } from "./observer/polling-observer.js";
import { updateImportGraph } from "./profile/import-graph.js";
import {
  addIntent,
  createSession,
  loadRequestedSession,
  markEventFeedback,
  processChanges,
  resolveSessionStore,
} from "./session/service.js";
import { SessionStore } from "./session/store.js";
import { driftlightHome, projectStatePath } from "./shared/state-paths.js";
import { writeJsonAtomic } from "./shared/atomic-write.js";
import { acknowledgeCurrentStatus } from "./status/current-status.js";
import { diagnose, formatChecks } from "./status/doctor.js";
import { listProjects, projectsDirectory, purgeVanishedProjects, sweepStaleTemporaries } from "./status/projects.js";
import { formatScoreExplanation, formatSessionSummary, formatSignal } from "./ui/terminal.js";
import { applyTerminalTitle, pushTerminalTitle, restoreTerminalTitle } from "./ui/terminal-title.js";

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
  driftlight explain <event-id> [--session latest] [--cwd .]
  driftlight mark <event-id> --noise|--useful [--session latest] [--cwd .]
  driftlight mark-expected <event-id> [--session latest] [--cwd .]
  driftlight add-scope "Nouvelle instruction ou chemin" [--session latest] [--cwd .]
  driftlight ack [--cwd .]
  driftlight claude install [--global] [--cwd .]
  driftlight claude uninstall [--global] [--cwd .]
  driftlight codex connect
  driftlight codex disconnect
  driftlight codex status
  driftlight projects [--purge]        # état de tous les projets de la machine
  driftlight doctor [--cwd .]          # diagnostic de l'installation
  driftlight learning [--reset] [--cwd .]  # ce que DriftLight a appris de vos retours
  driftlight notify [status|install|uninstall|test]  # identité et aperçu des notifications
    test [--orange] [--panel]           # --panel force le panneau plutôt que le toast
  driftlight hook                       # appelé par Claude Code via stdin JSON

Tout reste local, sur cette machine uniquement. L'état par projet est rangé sous
${path.join(driftlightHome(), "projects")} et n'écrit rien dans les dépôts observés ;
seul .driftlight/config.json, si vous en créez un, appartient au projet.
Les alertes rouges demandent confirmation ; aucun rollback n'est exécuté.`;
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
  await writeCurrentIntent(session.cwd, task, {
    turnId: `cli-${session.id}`,
    resetScope: true,
    sessionId: session.id,
  });
  await store.save(session);
  console.log(`DriftLight · surveillance locale active`);
  console.log(`   ${session.id} · ${session.baseline.branch ?? "hors Git"} · ${session.baseline.files.length} changement(s) préexistant(s) protégé(s)`);

  const config = loadConfigSync(session.cwd);
  pushTerminalTitle(config);
  applyTerminalTitle(session.cwd, config);

  const observer = new PollingObserver(session.cwd, session.initialSnapshot, interval);
  observer.start(async ({ changes, snapshot }) => {
    await updateImportGraph(session.cwd, snapshot, changes).catch(() => null);
    const events = processChanges(session, changes, snapshot);
    await store.save(session);
    for (const event of events) {
      const signal = formatSignal(event);
      if (signal) console.log(signal);
    }
    // Mode CLI : aucune action n'est bloquée, l'observateur constate après coup.
    await dispatchNotifications(session.cwd, events, config, session.id);
    applyTerminalTitle(session.cwd, config);
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
            await updateImportGraph(session.cwd, finalBatch.snapshot, finalBatch.changes).catch(() => null);
            const events = processChanges(session, finalBatch.changes, finalBatch.snapshot);
            for (const event of events) {
              const signal = formatSignal(event);
              if (signal) console.log(signal);
            }
            await dispatchNotifications(session.cwd, events, config, session.id);
          }
          session.endedAt = new Date().toISOString();
          await store.save(session);
          restoreTerminalTitle(session.cwd, config);
          console.log(`DriftLight · session enregistrée dans ${store.sessionPath(session.id)}`);
          resolve();
        } catch (error) {
          restoreTerminalTitle(session.cwd, config);
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

async function runExplain(args: string[]): Promise<void> {
  const eventId = positional(args, "explain")[0];
  if (!eventId) throw new Error("Indiquez l'identifiant de l'événement à expliquer.");
  const { session } = await requestedSession(args);
  const event = session.events.find((item) => item.id === eventId);
  if (!event) throw new Error(`Événement introuvable : ${eventId}`);
  console.log(formatScoreExplanation(event));
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

async function runMark(args: string[]): Promise<void> {
  const eventId = positional(args, "mark")[0];
  if (!eventId) throw new Error("Indiquez l'identifiant de l'alerte à qualifier.");
  const noise = args.includes("--noise");
  const useful = args.includes("--useful");
  if (noise === useful) throw new Error("Utilisez exactement une option : --noise ou --useful.");
  const { store, session } = await requestedSession(args);
  const event = markEventFeedback(session, eventId, noise ? "noise" : "useful");
  if (!event) throw new Error(`Alerte orange ou rouge introuvable : ${eventId}`);
  await store.save(session);
  console.log(`✓ ${eventId} qualifiée comme ${noise ? "bruit" : "utile"}.`);
}

async function runAddScope(args: string[]): Promise<void> {
  const text = option(args, "--text") ?? positional(args, "add-scope").join(" ");
  if (!text.trim()) throw new Error("Indiquez l'instruction ou le chemin à ajouter au scope.");
  const { store, session } = await requestedSession(args);
  addIntent(session, text, "manual-scope");
  await addCurrentScope(session.cwd, text, session.id);
  await store.save(session);
  console.log(`✓ Scope actif mis à jour (version ${session.intents.length}) : ${text}`);
}

async function runAck(args: string[]): Promise<void> {
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  const root = (await captureGitBaseline(cwd)).root;
  await acknowledgeCurrentStatus(root);
  // Le statut repasse au vert : le titre du terminal doit suivre immédiatement.
  applyTerminalTitle(root, loadConfigSync(root));
  console.log(`✓ Statut DriftLight acquitté.`);
}

async function runClaude(args: string[]): Promise<void> {
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  const global = args.includes("--global");

  if (args[1] === "uninstall") {
    const { settingsPath, removed } = await uninstallClaudeHooks({ cwd, global });
    console.log(removed > 0
      ? `✓ ${removed} hook(s) DriftLight retiré(s) de ${settingsPath}`
      : `Aucun hook DriftLight dans ${settingsPath}.`);
    console.log("  L'état déjà enregistré reste sous "
      + `${path.join(driftlightHome(), "projects")} ; \`driftlight projects --purge\` le supprime.`);
    return;
  }
  if (args[1] !== "install") {
    throw new Error("Commande attendue : driftlight claude install|uninstall [--global]");
  }
  const settingsPath = await installClaudeHooks({ cwd, global });
  const packaged = isInstalledPackage(process.argv[1] ?? "");
  console.log(`✓ Hooks Claude Code installés sans remplacer les hooks existants : ${settingsPath}`);
  if (global) {
    console.log("  Portée : tous les dépôts Git ouverts sur cette machine, y compris les prochains.");
    console.log(`  État par projet : ${path.join(driftlightHome(), "projects")}`);
    console.log("  Hors dépôt Git, DriftLight reste entièrement silencieux.");
    if (!packaged) {
      console.log("");
      console.log("⚠ Installé depuis une copie de développement, pas depuis un paquet.");
      console.log(`  Les réglages figent le chemin ${path.resolve(process.argv[1] ?? "dist/src/cli.js")}.`);
      console.log("  Déplacer cette copie casserait les hooks, et surtout : reconstruire");
      console.log("  change le comportement de toutes les sessions ouvertes sur la machine.");
      console.log("  Pour une installation stable : npm install -g . puis driftlight claude install --global");
    }
  } else {
    console.log("  Portée : ce dépôt seulement. Utilisez --global pour couvrir toute la machine.");
  }
  console.log(`  Les verdicts rouges demanderont confirmation avant l'action (configuration locale modifiable).`);
}

async function runCodex(args: string[]): Promise<void> {
  const action = args[1];
  const adapter = new CodexAdapter();
  if (action === "connect" || action === "install") {
    await adapter.install();
    const status = await adapter.healthCheck();
    console.log(`✓ Intégration Codex globale installée : ${status.configPath ?? adapter.hooksPath}`);
    console.log("  Approbations natives Codex : approval_policy=untrusted, approvals_reviewer=user.");
    console.log("  Open Codex → /hooks → review and trust the DriftLight hook once.");
    console.log("  État : Installed — approval required");
    return;
  }
  if (action === "disconnect" || action === "uninstall") {
    await adapter.uninstall();
    console.log("✓ Intégration Codex retirée ; hooks tiers conservés et réglages d'approbation restaurés s'ils n'avaient pas été modifiés depuis.");
    return;
  }
  if (action === "status") {
    const status = await adapter.healthCheck();
    console.log(`Codex · ${status.state}`);
    console.log(`Détecté : ${status.codexDetected ? "oui" : "non"}`);
    console.log(`Adapter : ${status.adapterVersion}`);
    console.log(`Dernier événement : ${status.lastEventAt ?? "aucun"}`);
    if (status.configPath) console.log(`Configuration : ${status.configPath}`);
    if (status.trustPath) console.log(`Confiance Codex : ${status.trustPath}`);
    if (status.hooks?.length) {
      console.log("Hooks :");
      const blocking = new Set(status.blockingEvents ?? []);
      for (const hook of status.hooks) {
        const mark = !hook.registered ? "?" : hook.enabled ? "✓" : "✗";
        // « enregistré » et non « actif » : Codex peut connaître un hook sans
        // l'exécuter, notamment quand son empreinte de confiance est périmée.
        const detail = !hook.registered
          ? "inconnu de Codex"
          : hook.enabled ? "enregistré" : "désactivé";
        console.log(`  ${mark} ${hook.event.padEnd(18)} ${detail}${blocking.has(hook.event) ? "  ← bloque" : ""}`);
      }
    }
    if (status.message) console.log(status.message);
    return;
  }
  throw new Error("Commande attendue : driftlight codex connect|disconnect|status");
}

/** stdout doit être vidé avant la sortie, sinon l'hôte lit une réponse tronquée. */
function writeStdout(payload: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(payload, () => resolve()));
}

/**
 * Une dégradation reste silencieuse pour l'agent mais laisse une trace locale :
 * une panne invisible est le prix du fail-open, un diagnostic impossible ne
 * l'est pas. L'enregistrement est au mieux — il ne peut pas faire échouer le
 * hook qu'il documente.
 */
async function recordDegradation(raw: string, outcome: SafeHookOutcome): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(raw);
    const cwd = (parsed as { cwd?: unknown })?.cwd;
    if (typeof cwd !== "string") return;
    const root = await resolveObservableRoot(cwd);
    if (!root) return;
    await writeJsonAtomic(projectStatePath(root, "hook-health.json"), {
      schemaVersion: 1,
      degraded: outcome.degraded,
      detail: outcome.detail ?? null,
      event: (parsed as { hook_event_name?: unknown })?.hook_event_name ?? null,
      at: new Date().toISOString(),
    });
  } catch {
    // Le diagnostic est un confort, jamais une condition de fonctionnement.
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} Mo`
    : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

async function runProjects(args: string[]): Promise<void> {
  if (args.includes("--purge")) {
    const removed = await purgeVanishedProjects();
    const swept = await sweepStaleTemporaries();
    if (removed.length === 0) console.log("Aucun projet disparu : rien à purger.");
    for (const project of removed) {
      console.log(`✓ Purgé ${project.root ?? path.basename(project.directory)} (${formatBytes(project.bytes)})`);
    }
    if (swept.length > 0) console.log(`✓ ${swept.length} temporaire(s) résiduel(s) supprimé(s).`);
    return;
  }

  const projects = await listProjects();
  if (projects.length === 0) {
    console.log(`Aucun projet observé pour l'instant. L'état vivra sous ${projectsDirectory()}.`);
    return;
  }
  console.log(`DriftLight · ${projects.length} projet(s) sous ${projectsDirectory()}`);
  for (const project of projects) {
    const marker = project.present ? " " : "✗";
    const activity = project.lastActivity?.slice(0, 16).replace("T", " ") ?? "jamais";
    console.log(
      `  ${marker} ${(project.root ?? path.basename(project.directory)).padEnd(48)}`
      + ` ${String(project.sessions).padStart(3)} session(s)  ${formatBytes(project.bytes).padStart(8)}  ${activity}`
      + (project.degraded ? `  dégradé:${project.degraded}` : ""),
    );
  }
  if (projects.some((project) => !project.present)) {
    console.log("\n  ✗ dépôt introuvable — `driftlight projects --purge` libère leur état.");
  }
}

async function runDoctor(args: string[]): Promise<void> {
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  console.log(formatChecks(await diagnose(cwd)));
}

async function runLearning(args: string[]): Promise<void> {
  const cwd = path.resolve(option(args, "--cwd") ?? process.cwd());
  const root = await resolveObservableRoot(cwd);
  if (root === null) throw new Error("Aucun dépôt Git observable ici.");
  if (args.includes("--reset")) {
    await rm(feedbackStatsPath(root), { force: true });
    console.log("✓ Apprentissage réinitialisé : DriftLight repart de sa calibration d'origine.");
    return;
  }

  const stats = readFeedbackStats(root);
  const learned = learnedSuppressions(stats, loadScoringConfigSync(root));
  console.log(
    `DriftLight · apprentissage local — ${stats.totals.noise} bruit / ${stats.totals.useful} utile qualifiés.`,
  );
  if (learned.length === 0) {
    console.log(
      `Aucun signal neutralisé pour l'instant : il faut ${LEARNING_MINIMUM_SAMPLE} qualifications`
      + ` sur ${LEARNING_MINIMUM_FILES} fichiers d'un même répertoire, dont`
      + ` ${Math.round(LEARNING_NOISE_RATIO * 100)} % de bruit.`,
    );
  }
  for (const item of learned) console.log(`  · ${describeSuppression(item)}`);
  console.log("\nLes signaux rouges ne sont jamais neutralisables. `--reset` annule tout.");
}

async function runNotify(args: string[]): Promise<void> {
  const action = args[1] ?? "status";
  if (action === "install") {
    const outcome = await installIdentity();
    console.log(`${outcome.ok ? "✓" : "✗"} ${outcome.detail}`);
    return;
  }
  if (action === "uninstall") {
    const outcome = await removeIdentity();
    console.log(`${outcome.ok ? "✓" : "✗"} ${outcome.detail}`);
    return;
  }
  if (action === "test") {
    const level = args.includes("--orange") ? "ORANGE" : "RED";
    const icon = severityIconPath(level);
    const notification: NativeNotification = {
      title: `DriftLight · ${path.basename(process.cwd())} — ${level === "RED" ? "action bloquée" : "à vérifier"}`,
      message: "Réécriture d'un fichier contenant du travail non sauvegardé : src/exemple.ts\n"
        + "Vous aviez demandé : « Corrige la faute de frappe dans src/app.ts »\n"
        + "Refusez maintenant : ce contenu n'existe nulle part ailleurs.",
      detail: {
        verb: "Réécriture",
        headline: "Fichier contenant du travail non sauvegardé",
        evidence: "src/exemple.ts",
        meta: level === "RED" ? "Alerte rouge · 2 signaux concordants" : "À vérifier",
        intent: "« Corrige la faute de frappe dans src/app.ts »",
        action: "Refusez maintenant : ce contenu n'existe nulle part ailleurs.",
        status: level === "RED" ? "Action refusée — l'agent ne l'exécutera pas" : "Confirmation demandée dans l'agent",
      },
      level,
      sound: true,
      persistent: true,
      attribution: "DriftLight — voyant local de dérive",
      tag: "driftlight-notification-preview",
      ...(icon ? { icon } : {}),
    };
    // Le toast Windows passe avant le panneau en fonctionnement normal. `--panel`
    // court-circuite ce choix pour voir le panneau tel qu'il s'affichera lorsque
    // le toast échoue — sinon il ne serait observable que sur une panne.
    if (args.includes("--panel")) {
      if (process.platform !== "win32") {
        console.log("Le panneau est propre à Windows ; sans objet ici.");
        return;
      }
      const shown = await showWindowsPanel(notification);
      console.log(shown ? "✓ Panneau d'essai lancé." : "✗ Le panneau n'a pas pu démarrer.");
      return;
    }
    await dispatchPreviewNotification(notification);
    console.log("✓ Notification d'essai remise à Windows.");
    return;
  }

  const status = identityStatus();
  if (!status.supported) {
    console.log("Identité d'application : propre à Windows ; sans objet ici.");
    return;
  }
  console.log(`DriftLight · identité de notification`);
  console.log(`  ${status.installed ? "✓" : "·"} ${status.installed ? status.appId : "identité par défaut de la bibliothèque d'envoi"}`);
  console.log(`  raccourci : ${status.shortcut}`);
  if (!status.installed) {
    console.log("\n`driftlight notify install` fait apparaître DriftLight, son icône et son nom");
    console.log("en en-tête des notifications. Écrit un raccourci dans votre menu Démarrer,");
    console.log("retirable par `driftlight notify uninstall`.");
  }
}

/** Envoi direct, sans passer par le journal anti-répétition ni par une session. */
async function dispatchPreviewNotification(notification: NativeNotification): Promise<void> {
  const backend = await loadNativeBackend();
  if (!backend) throw new Error("Aucune bibliothèque de notification disponible.");
  if (process.platform === "win32") {
    const readyFile = path.join(os.tmpdir(), `driftlight-panel-ready-${process.pid}-${randomUUID()}`);
    if (notification.tag) await dismissWindowsToasts([notification.tag]);
    try {
      await backend.send({ ...notification, readyFile });
      const deadline = Date.now() + WINDOWS_PANEL_STARTUP_MS + 1_000;
      while (Date.now() < deadline) {
        try {
          await access(readyFile);
          return;
        } catch {
          await delay(50);
        }
      }
      throw new Error("La notification Windows n'a pas confirmé son démarrage.");
    } finally {
      await unlink(readyFile).catch(() => undefined);
    }
  }
  await backend.send(notification);
}

async function runHook(): Promise<void> {
  const raw = await readStdin();
  const outcome = await runHookSafely(raw);
  if (outcome.stdout) await writeStdout(outcome.stdout);
  if (!outcome.degraded) return;
  if (process.env.DRIFTLIGHT_DEBUG) {
    console.error(`DriftLight (dégradé, ${outcome.degraded}) : ${outcome.detail ?? "sans détail"}`);
  }
  await recordDegradation(raw, outcome);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  switch (command) {
    case "start": await runStart(args); break;
    case "status": await runStatus(args); break;
    case "explain": await runExplain(args); break;
    case "mark": await runMark(args); break;
    case "mark-expected": await runMarkExpected(args); break;
    case "add-scope": await runAddScope(args); break;
    case "ack": await runAck(args); break;
    case "claude": await runClaude(args); break;
    case "codex": await runCodex(args); break;
    case "projects": await runProjects(args); break;
    case "doctor": await runDoctor(args); break;
    case "learning": await runLearning(args); break;
    case "notify": await runNotify(args); break;
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
