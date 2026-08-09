import path from "node:path";
import { DeterministicClassifier } from "../classification/deterministic-classifier.js";
import { changeFromAbsolutePath, classifyCommand } from "../classification/rules.js";
import type { ClaudeHookInput, SessionEvent, SessionRecord } from "../domain/types.js";
import { captureGitBaseline } from "../git/baseline.js";
import { diffSnapshots, scanRepository } from "../observer/snapshot.js";
import { isInsideRoot, safeIdentifier } from "../shared/paths.js";
import {
  addIntent,
  createSession,
  eventFromFindings,
  processChanges,
} from "../session/service.js";
import { SessionStore } from "../session/store.js";
import { formatHookSignal } from "../ui/terminal.js";

export interface ClaudeHookOutput {
  systemMessage?: string;
  suppressOutput?: boolean;
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
): SessionEvent | null {
  if (!isInsideRoot(session.cwd, filePath)) return null;
  const change = changeFromAbsolutePath(session.cwd, filePath, kind);
  if (!change) return null;
  const classifier = new DeterministicClassifier();
  const classification = classifier.classify({
    task: session.intents[0]?.text ?? "",
    scopeAdditions: session.intents.slice(1).map((intent) => intent.text),
    change,
    baseline: session.baseline,
    initialSnapshot: session.initialSnapshot,
    currentSnapshot: session.lastSnapshot,
    changedFileCount: new Set([
      ...session.events.filter((event) => event.path).map((event) => event.path as string),
      change.path,
    ]).size,
    deletedFileCount: session.events.filter((event) => event.changeKind === "deleted").length,
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
    expected: false,
  };
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
    return {
      systemMessage: `🟢 DriftLight · observation locale active · ${session.baseline.files.length} changement(s) préexistant(s) protégé(s)`,
      suppressOutput: true,
    };
  }

  const { store, session } = await ensureSession(input);

  if (input.hook_event_name === "UserPromptSubmit") {
    if (input.prompt) addIntent(session, input.prompt, "user-follow-up");
    await store.save(session);
    return undefined;
  }

  if (input.hook_event_name === "PreToolUse") {
    const events: SessionEvent[] = [];
    const command = input.tool_input?.command;
    if ((input.tool_name === "Bash" || input.tool_name === "PowerShell") && typeof command === "string") {
      const findings = classifyCommand(command, session.baseline);
      if (findings.length > 0) {
        events.push(eventFromFindings("proposed-action", findings, command.slice(0, 160)));
      }
    }

    const rawPath = input.tool_input?.file_path;
    if (typeof rawPath === "string" && ["Edit", "Write", "NotebookEdit"].includes(input.tool_name ?? "")) {
      const absolutePath = path.resolve(rawPath);
      const kind = session.lastSnapshot.files[changeFromAbsolutePath(session.cwd, absolutePath, "modified")?.path ?? ""]
        ? "modified"
        : "created";
      const event = classificationEvent(session, absolutePath, kind);
      if (event) events.push(event);
    }

    session.events.push(...events);
    await store.save(session);
    const message = formatHookSignal(events);
    return message ? { systemMessage: message, suppressOutput: true } : undefined;
  }

  if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "FileChanged") {
    const current = await scanRepository(session.cwd);
    const changes = diffSnapshots(session.lastSnapshot, current);
    const events = processChanges(session, changes, current);
    await store.save(session);
    const message = formatHookSignal(events);
    return message ? { systemMessage: message, suppressOutput: true } : undefined;
  }

  if (input.hook_event_name === "SessionEnd") {
    session.endedAt = new Date().toISOString();
    const lifecycle = eventFromFindings("lifecycle", [], `Session Claude Code terminée : ${input.reason ?? "other"}`);
    lifecycle.reasons = ["Session terminée, historique local enregistré."];
    session.events.push(lifecycle);
    await store.save(session);
    return undefined;
  }

  return undefined;
}

export function validateObservationOnlyOutput(output: ClaudeHookOutput | undefined): boolean {
  if (!output) return true;
  const keys = Object.keys(output);
  return keys.every((key) => key === "systemMessage" || key === "suppressOutput");
}
