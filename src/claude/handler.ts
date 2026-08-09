import path from "node:path";
import { DeterministicClassifier } from "../classification/deterministic-classifier.js";
import { changeFromAbsolutePath, classifyCommand } from "../classification/rules.js";
import type { ClaudeHookInput, SessionEvent, SessionRecord } from "../domain/types.js";
import { loadConfigSync } from "../config/config.js";
import { captureGitBaseline } from "../git/baseline.js";
import { readCurrentIntentSync, writeCurrentIntent } from "../intent/current-intent.js";
import { diffSnapshots, scanRepository } from "../observer/snapshot.js";
import { dispatchNotifications } from "../notify/dispatcher.js";
import { suppressedByCap } from "../notify/notified-log.js";
import { isInsideRoot, safeIdentifier } from "../shared/paths.js";
import {
  appendSessionEvents,
  createSession,
  eventFromFindings,
  processChanges,
  recordAgentRead,
  setCurrentIntent,
  turnTouchedPathCount,
} from "../session/service.js";
import { SessionStore } from "../session/store.js";
import { recordCurrentStatus } from "../status/current-status.js";
import { formatStopSummary } from "../ui/terminal.js";
import { restoreTitleSequence, terminalTitleSequence } from "../ui/terminal-title.js";

export interface ClaudeHookOutput {
  systemMessage?: string;
  suppressOutput?: boolean;
  /**
   * Séquence d'échappement que Claude Code émet lui-même vers le terminal.
   * Restreinte par Claude Code aux OSC 0/1/2/9/99/777 et BEL : toute séquence
   * hors allowlist fait ignorer le champ entier.
   */
  terminalSequence?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "ask";
    permissionDecisionReason: string;
    additionalContext: string;
  };
}

async function sessionContext(input: ClaudeHookInput): Promise<{
  store: SessionStore;
  session: SessionRecord | null;
  id: string;
  root: string;
}> {
  const baseline = await captureGitBaseline(input.cwd);
  const root = baseline.root;
  const id = `claude-${safeIdentifier(input.session_id)}`;
  const store = new SessionStore(root);
  return { store, session: await store.load(id), id, root };
}

function classificationEvent(
  session: SessionRecord,
  filePath: string,
  kind: "created" | "modified",
  operation: "edit" | "write",
  deletedLineCount = 0,
): SessionEvent | null {
  if (!isInsideRoot(session.cwd, filePath)) return null;
  const change = changeFromAbsolutePath(session.cwd, filePath, kind);
  if (!change) return null;
  change.before = session.lastSnapshot.files[change.path];
  const classifier = new DeterministicClassifier();
  const currentIntent = readCurrentIntentSync(session.cwd);
  const classification = classifier.classify({
    root: session.cwd,
    change,
    baseline: session.baseline,
    initialSnapshot: session.initialSnapshot,
    currentSnapshot: session.lastSnapshot,
    changedFileCount: turnTouchedPathCount(session, currentIntent?.turnId, [change]),
    deletedFileCount: session.events.filter((event) => event.changeKind === "deleted").length,
    agentReads: session.agentReads ?? [],
    emittedRuleIds: session.events.flatMap((event) => event.codes),
    operation: { kind: operation, deletedLineCount },
  });
  return {
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    type: "proposed-action",
    path: change.path,
    changeKind: change.kind,
    level: classification.level,
    reasons: classification.reasons,
    codes: classification.codes,
    ruleId: classification.ruleId,
    scoreBreakdown: classification.scoreBreakdown,
    expected: false,
    ...(classification.intentVersion ? { intentVersion: classification.intentVersion } : {}),
    ...(classification.turnId ? { turnId: classification.turnId } : {}),
  };
}

function absoluteToolPath(root: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
}

/**
 * Notifie les événements retenus. Purement additif — un échec ici ne doit jamais
 * empêcher le hook de rendre son verdict.
 *
 * `blockedEventIds` porte l'issue réelle du hook : seuls ces événements ont
 * effectivement suspendu l'action, et eux seuls seront annoncés comme bloqués.
 */
async function signalEvents(
  session: SessionRecord,
  events: SessionEvent[],
  blockedEventIds: readonly string[] = [],
): Promise<void> {
  try {
    await dispatchNotifications(session.cwd, events, loadConfigSync(session.cwd), session.id, {
      blockedEventIds,
    });
  } catch {
    // Couche de signalement optionnelle : on n'interrompt pas le hook.
  }
}

/**
 * Titre du terminal délégué à Claude Code, qui possède seul le chemin d'écriture
 * vers le terminal réel. Un hook n'a pas de terminal de contrôle.
 */
function titleOutput(root: string): ClaudeHookOutput | undefined {
  const sequence = terminalTitleSequence(root, loadConfigSync(root));
  return sequence ? { terminalSequence: sequence } : undefined;
}

function textLineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split(/\r?\n/).length - (value.endsWith("\n") ? 1 : 0);
}

async function ensureSession(input: ClaudeHookInput): Promise<{ store: SessionStore; session: SessionRecord }> {
  const context = await sessionContext(input);
  if (context.session) return { store: context.store, session: context.session };
  const session = await createSession({
    cwd: context.root,
    source: "claude-code",
    id: context.id,
    externalId: input.session_id,
  });
  await context.store.save(session);
  return { store: context.store, session };
}

export async function handleClaudeHook(input: ClaudeHookInput): Promise<ClaudeHookOutput | undefined> {
  if (!input.session_id || !input.cwd || !input.hook_event_name) return undefined;

  if (input.hook_event_name === "SessionStart") {
    const context = await sessionContext(input);
    let session = context.session;
    if (!session || input.source === "startup" || input.source === "clear") {
      session = await createSession({
        cwd: context.root,
        source: "claude-code",
        id: context.id,
        externalId: input.session_id,
      });
      await context.store.save(session);
    }
    if (input.source === "startup" || input.source === "clear") {
      await writeCurrentIntent(context.root, "", { turnId: `session-${input.session_id}`, resetScope: true });
    }
    return titleOutput(context.root);
  }

  const { store, session } = await ensureSession(input);

  if (input.hook_event_name === "UserPromptSubmit") {
    if (input.prompt) {
      setCurrentIntent(session, input.prompt, "user-follow-up");
      await writeCurrentIntent(session.cwd, input.prompt, { turnId: input.prompt_id });
    }
    await store.save(session);
    return undefined;
  }

  if (input.hook_event_name === "PreToolUse") {
    const events: SessionEvent[] = [];
    const command = input.tool_input?.command;
    if ((input.tool_name === "Bash" || input.tool_name === "PowerShell") && typeof command === "string") {
      const findings = classifyCommand(command, session.baseline);
      if (findings.length > 0) {
        const event = eventFromFindings("proposed-action", findings, session.cwd, command.slice(0, 160));
        const intent = readCurrentIntentSync(session.cwd);
        if (intent) {
          event.intentVersion = intent.version;
          event.turnId = intent.turnId;
        }
        events.push(event);
      }
    }

    const rawPath = input.tool_input?.file_path;
    if (typeof rawPath === "string" && ["Edit", "Write", "NotebookEdit"].includes(input.tool_name ?? "")) {
      const absolutePath = absoluteToolPath(session.cwd, rawPath);
      const kind = session.lastSnapshot.files[changeFromAbsolutePath(session.cwd, absolutePath, "modified")?.path ?? ""]
        ? "modified"
        : "created";
      const oldText = input.tool_input?.old_string;
      const newText = input.tool_input?.new_string;
      const writtenText = input.tool_input?.content;
      const relativePath = changeFromAbsolutePath(session.cwd, absolutePath, kind)?.path;
      const deletedLineCount = input.tool_name === "Write" && typeof writtenText === "string"
        ? Math.max(0, (relativePath ? session.lastSnapshot.files[relativePath]?.lineCount ?? 0 : 0) - textLineCount(writtenText))
        : typeof oldText === "string" && typeof newText === "string"
          ? Math.max(0, textLineCount(oldText) - textLineCount(newText))
          : 0;
      const operation = input.tool_name === "Write" ? "write" : "edit";
      const event = classificationEvent(session, absolutePath, kind, operation, deletedLineCount);
      if (event) events.push(event);
    }

    const acceptedEvents = appendSessionEvents(session, events);
    recordCurrentStatus(session.cwd, acceptedEvents);
    await store.save(session);

    // Le refus est décidé avant toute notification : le libellé annoncé à
    // l'utilisateur doit refléter l'issue réelle du hook, pas la sévérité seule.
    const config = loadConfigSync(session.cwd);
    const blockingEvent = acceptedEvents.find((event) => event.level === "RED" && config.blockOnRed)
      ?? acceptedEvents.find((event) => event.level === "ORANGE" && config.blockOnOrange);

    await signalEvents(session, acceptedEvents, blockingEvent ? [blockingEvent.id] : []);
    const title = titleOutput(session.cwd);

    if (!blockingEvent) return title;
    const subject = blockingEvent.path ?? blockingEvent.detail ?? "action";
    const reason = blockingEvent.reasons[0] ?? blockingEvent.ruleId;
    const message = `DriftLight ${blockingEvent.level} — ${subject} — ${blockingEvent.ruleId}: ${reason} [${blockingEvent.id}]`;
    return {
      ...title,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: message,
        additionalContext: `${message}. Attends la confirmation explicite de l'utilisateur avant de poursuivre cette action.`,
      },
    };
  }

  if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "FileChanged") {
    const readPath = input.tool_input?.file_path;
    if (input.hook_event_name === "PostToolUse" && input.tool_name === "Read" && typeof readPath === "string") {
      const absolutePath = absoluteToolPath(session.cwd, readPath);
      const relative = changeFromAbsolutePath(session.cwd, absolutePath, "modified")?.path;
      const intent = readCurrentIntentSync(session.cwd);
      if (relative && intent) recordAgentRead(session, relative, intent.turnId);
      await store.save(session);
      return undefined;
    }
    const current = await scanRepository(session.cwd);
    const changes = diffSnapshots(session.lastSnapshot, current);
    const events = processChanges(session, changes, current);
    await store.save(session);
    // PostToolUse observe le disque après coup : rien n'a été bloqué ici.
    await signalEvents(session, events);
    return titleOutput(session.cwd);
  }

  if (input.hook_event_name === "Stop") {
    const intent = readCurrentIntentSync(session.cwd);
    if (!intent) return undefined;
    const summary = formatStopSummary(
      session.events,
      intent.turnId,
      suppressedByCap(session.cwd, session.id),
    );
    return summary ? { systemMessage: summary, suppressOutput: true } : undefined;
  }

  if (input.hook_event_name === "SessionEnd") {
    session.endedAt = new Date().toISOString();
    const lifecycle = eventFromFindings("lifecycle", [], session.cwd, `Session Claude Code terminée : ${input.reason ?? "other"}`);
    lifecycle.reasons = ["Session terminée, historique local enregistré."];
    session.events.push(lifecycle);
    await store.save(session);
    const restored = restoreTitleSequence(session.cwd, loadConfigSync(session.cwd));
    return restored ? { terminalSequence: restored } : undefined;
  }

  return undefined;
}
