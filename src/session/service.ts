import { randomUUID } from "node:crypto";
import path from "node:path";
import { DeterministicClassifier } from "../classification/deterministic-classifier.js";
import { highestSeverity } from "../classification/rules.js";
import type {
  Classification,
  Classifier,
  IntentVersion,
  ObservedChange,
  RepositorySnapshot,
  RuleFinding,
  SessionEvent,
  SessionRecord,
  Severity,
} from "../domain/types.js";
import { captureGitBaseline } from "../git/baseline.js";
import { scanRepository } from "../observer/snapshot.js";
import { SessionStore } from "./store.js";

export interface CreateSessionOptions {
  cwd: string;
  task?: string;
  source: SessionRecord["source"];
  id?: string;
  externalId?: string;
}

export async function createSession(options: CreateSessionOptions): Promise<SessionRecord> {
  const baseline = await captureGitBaseline(options.cwd);
  const root = baseline.root;
  const initialSnapshot = await scanRepository(root);
  const now = new Date().toISOString();
  const intents: IntentVersion[] = options.task
    ? [{ version: 1, text: options.task, source: "initial", addedAt: now }]
    : [];

  return {
    schemaVersion: 1,
    id: options.id ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`,
    ...(options.externalId ? { externalId: options.externalId } : {}),
    source: options.source,
    cwd: root,
    startedAt: now,
    intents,
    baseline,
    initialSnapshot,
    lastSnapshot: initialSnapshot,
    events: [],
    expectedEventIds: [],
  };
}

function activeTask(session: SessionRecord): string {
  return session.intents[0]?.text ?? "";
}

function scopeAdditions(session: SessionRecord): string[] {
  return session.intents.slice(1).map((intent) => intent.text);
}

function changedPathCount(session: SessionRecord, pending: ObservedChange[]): number {
  const paths = new Set(
    session.events
      .filter((event) => event.type === "change" && event.path)
      .map((event) => event.path as string),
  );
  for (const change of pending) paths.add(change.path);
  return paths.size;
}

function deletedPathCount(session: SessionRecord, pending: ObservedChange[]): number {
  const paths = new Set(
    session.events
      .filter((event) => event.type === "change" && event.changeKind === "deleted" && event.path)
      .map((event) => event.path as string),
  );
  for (const change of pending) {
    if (change.kind === "deleted") paths.add(change.path);
  }
  return paths.size;
}

export function eventFromFindings(
  type: SessionEvent["type"],
  findings: RuleFinding[],
  detail?: string,
): SessionEvent {
  const level = findings.length > 0 ? highestSeverity(findings) : "GREEN";
  const relevant = findings.filter((item) => item.severity === level);
  return {
    id: `event-${Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    level,
    reasons: relevant.map((item) => item.reason),
    codes: relevant.map((item) => item.code),
    expected: false,
    ...(detail ? { detail } : {}),
  };
}

export function addIntent(
  session: SessionRecord,
  text: string,
  source: IntentVersion["source"],
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  session.intents.push({
    version: session.intents.length + 1,
    text: trimmed,
    source: session.intents.length === 0 ? "initial" : source,
    addedAt: new Date().toISOString(),
  });
}

export function processChanges(
  session: SessionRecord,
  changes: ObservedChange[],
  currentSnapshot: RepositorySnapshot,
  classifier: Classifier = new DeterministicClassifier(),
): SessionEvent[] {
  const count = changedPathCount(session, changes);
  const deletionCount = deletedPathCount(session, changes);
  const events = changes.map((change) => {
    const classification: Classification = classifier.classify({
      task: activeTask(session),
      scopeAdditions: scopeAdditions(session),
      change,
      baseline: session.baseline,
      initialSnapshot: session.initialSnapshot,
      currentSnapshot,
      changedFileCount: count,
      deletedFileCount: deletionCount,
    });
    return {
      id: `event-${Date.now()}-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "change" as const,
      path: change.path,
      changeKind: change.kind,
      level: classification.level,
      reasons: classification.reasons,
      codes: classification.codes,
      expected: false,
    };
  });

  session.events.push(...events);
  session.lastSnapshot = currentSnapshot;
  return events;
}

export async function loadRequestedSession(store: SessionStore, id: string | undefined): Promise<SessionRecord | null> {
  return !id || id === "latest" ? await store.latest() : await store.load(id);
}

export async function resolveSessionStore(cwd: string): Promise<SessionStore> {
  const baseline = await captureGitBaseline(path.resolve(cwd));
  return new SessionStore(baseline.root);
}

export function highestEventLevel(events: SessionEvent[]): Severity {
  return events.reduce<Severity>((highest, event) => {
    const order: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };
    return order[event.level] > order[highest] ? event.level : highest;
  }, "GREEN");
}
