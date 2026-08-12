import path from "node:path";
import type { ScopeLightEvent } from "../adapters/types.js";
import { DeterministicClassifier } from "../classification/deterministic-classifier.js";
import { classifyCommand } from "../classification/rules.js";
import { loadConfigSync } from "../config/config.js";
import type { ChangeKind, Classifier, SessionEvent, SessionRecord } from "../domain/types.js";
import { resolveGitRoot, resolveObservableRoot } from "../git/baseline.js";
import { readCurrentIntentSync, writeCurrentIntent } from "../intent/current-intent.js";
import { isReadLikeTool } from "../intent/agent-context.js";
import { dismissPendingNotifications, dispatchNotifications } from "../notify/dispatcher.js";
import { diffSnapshots, scanRepository } from "../observer/snapshot.js";
import { updateImportGraph } from "../profile/import-graph.js";
import { isInsideRoot, safeIdentifier } from "../shared/paths.js";
import {
  appendSessionEvents,
  classifyProposedFileChange,
  createSession,
  eventFromFindings,
  processChanges,
  recordAgentRead,
  recordDeclaredPlanPaths,
  recordTurnTouchedPaths,
  setCurrentIntent,
} from "../session/service.js";
import { SessionStore } from "../session/store.js";
import { recordCurrentStatus } from "../status/current-status.js";

type NotificationDispatcher = typeof dispatchNotifications;

export interface NormalizedEventProcessorOptions {
  classifier?: Classifier;
  notify?: NotificationDispatcher;
}

interface SessionContext {
  root: string;
  id: string;
  store: SessionStore;
  session: SessionRecord;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nativeTurnId(event: ScopeLightEvent): string | undefined {
  return string(record(event.payload.native)?.turnId);
}

function proposedKind(value: unknown, existed: boolean): ChangeKind {
  if (value === "deleted") return "deleted";
  if (value === "created") return "created";
  return existed ? "modified" : "created";
}

/**
 * Point d'entrée du Core pour tous les adapters. Il ne connaît aucun payload
 * natif Codex : il consomme uniquement le protocole ScopeLight normalisé.
 */
export class NormalizedEventProcessor {
  private readonly classifier: Classifier;
  private readonly notify: NotificationDispatcher;
  private readonly rootCache = new Map<string, Promise<string>>();
  public constructor(options: NormalizedEventProcessorOptions = {}) {
    this.classifier = options.classifier ?? new DeterministicClassifier();
    this.notify = options.notify ?? dispatchNotifications;
  }

  private async rootFor(workspace: string): Promise<string> {
    let pending = this.rootCache.get(workspace);
    if (!pending) {
      pending = resolveGitRoot(workspace);
      this.rootCache.set(workspace, pending);
    }
    return await pending;
  }

  private async context(event: ScopeLightEvent): Promise<SessionContext> {
    const root = await this.rootFor(event.workspace);
    const id = `${event.agent}-${safeIdentifier(event.session_id)}`;
    const store = new SessionStore(root);
    let session = await store.load(id);
    if (!session) {
      session = await createSession({
        cwd: root,
        source: "codex",
        id,
        externalId: event.session_id,
      });
      await store.save(session);
    }
    return { root, id, store, session };
  }

  private async signal(
    session: SessionRecord,
    events: SessionEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const config = loadConfigSync(session.cwd);
    try {
      await this.notify(session.cwd, events, config, session.id);
    } catch {
      // Une notification native ne doit jamais rendre le Core indisponible.
    }
  }

  private async sessionStarted(event: ScopeLightEvent): Promise<void> {
    const root = await this.rootFor(event.workspace);
    const id = `${event.agent}-${safeIdentifier(event.session_id)}`;
    const store = new SessionStore(root);
    const source = string(event.payload.source) ?? "unknown";
    let session = await store.load(id);
    if (!session || source === "startup" || source === "clear") {
      session = await createSession({
        cwd: root,
        source: "codex",
        id,
        externalId: event.session_id,
      });
      await store.save(session);
    }
    if (source === "startup" || source === "clear") {
      await writeCurrentIntent(root, "", {
        turnId: nativeTurnId(event) ?? `session-${safeIdentifier(event.session_id)}`,
        resetScope: true,
        sessionId: id,
      });
    }
  }

  private async userPrompt(event: ScopeLightEvent): Promise<void> {
    const prompt = string(event.payload.prompt);
    if (prompt === undefined) return;
    const { store, session } = await this.context(event);
    // Un nouveau tour commence : les alertes du précédent n'attendent plus rien.
    await dismissPendingNotifications(session.cwd, session.id).catch(() => []);
    setCurrentIntent(session, prompt, "user-follow-up");
    await writeCurrentIntent(session.cwd, prompt, { turnId: nativeTurnId(event), sessionId: session.id });
    await store.save(session);
  }

  private async commandProposed(event: ScopeLightEvent): Promise<void> {
    const command = string(event.payload.command);
    if (command === undefined) return;
    const { store, session } = await this.context(event);
    const intent = readCurrentIntentSync(session.cwd, session.id);
    // Même règle que côté Claude Code : ce qui vient d'être demandé n'alerte pas.
    const findings = classifyCommand(
      command,
      session.baseline,
      undefined,
      intent ? { text: intent.text, scopeAdditions: intent.scopeAdditions } : undefined,
    );
    if (findings.length === 0) return;
    const candidate = eventFromFindings("proposed-action", findings, session.cwd, command.slice(0, 160));
    if (intent) {
      candidate.intentVersion = intent.version;
      candidate.turnId = intent.turnId;
    }
    const accepted = appendSessionEvents(session, [candidate]);
    recordCurrentStatus(session.cwd, accepted);
    await store.save(session);
    await this.signal(session, accepted);
  }

  private async fileProposed(event: ScopeLightEvent): Promise<void> {
    if (event.payload.phase !== "proposed") return;
    const filePath = string(event.payload.path);
    if (!filePath) return;
    const { root, store, session } = await this.context(event);
    const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
    if (!isInsideRoot(root, absolutePath)) return;
    const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
    const kind = proposedKind(event.payload.changeKind, Boolean(session.lastSnapshot.files[relativePath]));
    const removedLineCount = number(event.payload.removedLineCount);

    // Un patch qui retire tout le contenu existant est une réécriture, quel que
    // soit le mot employé par l'agent pour la décrire. Sans cette lecture, une
    // destruction intégrale sous Codex se présentait comme une simple édition et
    // échappait à la protection du travail préexistant.
    //
    // Un fichier d'une seule ligne fait exception : y corriger cette ligne et
    // la réécrire produisent exactement le même patch. L'information n'existe
    // pas, et prétendre la lire ne ferait qu'inventer des alertes.
    const previousLineCount = session.lastSnapshot.files[relativePath]?.lineCount ?? 0;
    const rewritesWholeFile = previousLineCount > 1 && removedLineCount >= previousLineCount;
    const operation = event.payload.changeKind === "renamed"
      ? "rename"
      : rewritesWholeFile ? "write" : "edit";

    const candidate = classifyProposedFileChange(
      session,
      absolutePath,
      kind,
      operation,
      removedLineCount,
      undefined,
      undefined,
      this.classifier,
    );
    if (!candidate) return;
    const accepted = appendSessionEvents(session, [candidate]);
    recordTurnTouchedPaths(session, candidate.turnId, [candidate.path as string]);
    recordCurrentStatus(session.cwd, accepted);
    await store.save(session);
    await this.signal(session, accepted);
  }

  private async planDeclared(event: ScopeLightEvent): Promise<void> {
    const { store, session } = await this.context(event);
    const intent = readCurrentIntentSync(session.cwd, session.id);
    if (!intent) return;
    const paths = Array.isArray(event.payload.paths)
      ? event.payload.paths.filter((item): item is string => typeof item === "string")
      : [];
    recordDeclaredPlanPaths(session, intent.turnId, paths);
    await store.save(session);
  }

  private async toolCompleted(event: ScopeLightEvent): Promise<void> {
    const { store, session } = await this.context(event);
    // L'outil a tourné : la décision qu'attendait l'alerte est prise.
    await dismissPendingNotifications(session.cwd, session.id).catch(() => []);
    const toolName = string(event.payload.toolName) ?? "";
    if (isReadLikeTool(toolName)) {
      const candidates = Array.isArray(event.payload.readFiles)
        ? event.payload.readFiles.filter((item): item is string => typeof item === "string")
        : [];
      const known = new Set(Object.keys(session.lastSnapshot.files));
      const intent = readCurrentIntentSync(session.cwd, session.id);
      if (intent) {
        for (const filePath of candidates) {
          const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(session.cwd, filePath);
          if (!isInsideRoot(session.cwd, absolutePath)) continue;
          const relativePath = path.relative(session.cwd, absolutePath).replaceAll("\\", "/");
          if (known.has(relativePath)) recordAgentRead(session, relativePath, intent.turnId);
        }
      }
      await store.save(session);
      return;
    }

    const current = await scanRepository(session.cwd);
    const changes = diffSnapshots(session.lastSnapshot, current);
    await updateImportGraph(session.cwd, current, changes).catch(() => null);
    const events = processChanges(session, changes, current, this.classifier);
    await store.save(session);
    await this.signal(session, events);
  }

  private async lifecycle(event: ScopeLightEvent, detail: string, endSession = false): Promise<void> {
    const { store, session } = await this.context(event);
    if (endSession) session.endedAt = event.timestamp;
    const lifecycle = eventFromFindings("lifecycle", [], session.cwd, detail);
    lifecycle.reasons = [detail];
    lifecycle.turnId = nativeTurnId(event);
    session.events.push(lifecycle);
    await store.save(session);
  }

  public async process(event: ScopeLightEvent): Promise<void> {
    if (event.protocol_version !== 1) return;
    // Même garde-fou que côté Claude Code : sans dépôt Git, pas de périmètre.
    if (await resolveObservableRoot(event.workspace) === null) return;
    switch (event.event) {
      case "SESSION_STARTED":
        await this.sessionStarted(event);
        break;
      case "USER_PROMPT":
        await this.userPrompt(event);
        break;
      case "COMMAND_PROPOSED":
        await this.commandProposed(event);
        break;
      case "PLAN_DECLARED":
        await this.planDeclared(event);
        break;
      case "FILE_EDITED":
        await this.fileProposed(event);
        break;
      case "TOOL_COMPLETED":
        // Observation après coup : plus rien à retenir, l'outil a déjà tourné.
        await this.toolCompleted(event);
        break;
      case "SUBAGENT_STARTED":
        await this.lifecycle(event, "Sous-agent démarré.");
        break;
      case "SUBAGENT_STOPPED":
        await this.lifecycle(event, "Sous-agent terminé.");
        break;
      case "AGENT_STOPPED":
        await this.lifecycle(event, "Tour Codex terminé.");
        break;
      case "SESSION_ENDED":
        await this.lifecycle(event, `Session Codex terminée : ${string(event.payload.reason) ?? "other"}.`, true);
        break;
      case "TOOL_PROPOSED":
        break;
    }
  }
}
