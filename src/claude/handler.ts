import path from "node:path";
import { promises as fs } from "node:fs";
import { changeFromAbsolutePath, classifyCommand } from "../classification/rules.js";
import type { ClaudeHookInput, SessionEvent, SessionRecord } from "../domain/types.js";
import { loadConfigSync } from "../config/config.js";
import { captureGitBaseline, resolveObservableRoot } from "../git/baseline.js";
import { readCurrentIntentSync, writeCurrentIntent } from "../intent/current-intent.js";
import {
  extractDeclaredPlanPaths,
  extractReadPaths,
  isPlanTool,
  isReadLikeTool,
} from "../intent/agent-context.js";
import { diffSnapshots, scanRepository } from "../observer/snapshot.js";
import { updateImportGraph } from "../profile/import-graph.js";
import { dispatchNotifications } from "../notify/dispatcher.js";
import { suppressedByCap } from "../notify/notified-log.js";
import { safeIdentifier } from "../shared/paths.js";
import {
  appendSessionEvents,
  classifyProposedFileChange,
  createSession,
  eventFromFindings,
  processChanges,
  recordAgentRead,
  recordDeclaredPlanPaths,
  setCurrentIntent,
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

async function proposedOperationContext(
  toolName: string,
  absolutePath: string,
  toolInput: Record<string, unknown>,
): Promise<{ content?: string; fullFileReformat?: boolean }> {
  if (toolName === "Write" && typeof toolInput.content === "string") {
    try {
      const current = await fs.readFile(absolutePath, "utf8");
      const compact = (value: string): string => value.replace(/\s+/g, "");
      return {
        content: toolInput.content,
        fullFileReformat: current !== toolInput.content && compact(current) === compact(toolInput.content),
      };
    } catch {
      return { content: toolInput.content };
    }
  }
  if (toolName !== "Edit" || typeof toolInput.old_string !== "string" || typeof toolInput.new_string !== "string") {
    return {};
  }
  try {
    const current = await fs.readFile(absolutePath, "utf8");
    return current.includes(toolInput.old_string)
      ? { content: current.replace(toolInput.old_string, toolInput.new_string), fullFileReformat: false }
      : { fullFileReformat: false };
  } catch {
    return { fullFileReformat: false };
  }
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
  // Installé globalement, le hook se déclenche dans tous les projets ouverts.
  // Hors dépôt Git, DriftLight se tait entièrement plutôt que d'observer un
  // périmètre qu'il ne sait pas délimiter.
  if (await resolveObservableRoot(input.cwd) === null) return undefined;

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
    if (input.tool_name && isPlanTool(input.tool_name)) {
      const intent = readCurrentIntentSync(session.cwd);
      if (intent) {
        recordDeclaredPlanPaths(
          session,
          intent.turnId,
          extractDeclaredPlanPaths(session.cwd, input.tool_input),
        );
      }
    }
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
      const proposed = await proposedOperationContext(input.tool_name ?? "", absolutePath, input.tool_input ?? {});
      const event = classifyProposedFileChange(
        session,
        absolutePath,
        kind,
        operation,
        deletedLineCount,
        proposed.content,
        proposed.fullFileReformat,
      );
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
    if (input.hook_event_name === "PostToolUse" && input.tool_name && isReadLikeTool(input.tool_name)) {
      const intent = readCurrentIntentSync(session.cwd);
      const paths = extractReadPaths(
        session.cwd,
        input.tool_input,
        input.tool_response,
        Object.keys(session.lastSnapshot.files),
      );
      if (intent) {
        for (const filePath of paths) recordAgentRead(session, filePath, intent.turnId);
      }
      await store.save(session);
      return undefined;
    }
    const current = await scanRepository(session.cwd);
    const changes = diffSnapshots(session.lastSnapshot, current);
    await updateImportGraph(session.cwd, current, changes).catch(() => null);
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
