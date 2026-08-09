import { randomUUID } from "node:crypto";
import path from "node:path";
import { DeterministicClassifier } from "../classification/deterministic-classifier.js";
import { absoluteScoreBreakdown } from "../classification/scoring-engine.js";
import { behaviorScoreBreakdown, evaluateBehaviorDecision } from "../classification/behavior-signals.js";
import { recordFeedbackStats } from "../classification/feedback-stats.js";
import { changeFromAbsolutePath, highestSeverity } from "../classification/rules.js";
import type {
  AlertFeedback,
  AgentReadRecord,
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
import { loadScoringConfigSync } from "../config/scoring-config.js";
import { scanRepository } from "../observer/snapshot.js";
import { readCurrentIntentSync } from "../intent/current-intent.js";
import { buildImportGraph } from "../profile/import-graph.js";
import { startRepoProfileBuild } from "../profile/repo-profile.js";
import { isInsideRoot } from "../shared/paths.js";
import { recordCurrentStatus } from "../status/current-status.js";
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
  await buildImportGraph(root, initialSnapshot);
  startRepoProfileBuild(root);
  const now = new Date().toISOString();
  const initialIntent: IntentVersion | undefined = options.task
    ? { version: 1, text: options.task, source: "initial", addedAt: now }
    : undefined;
  const intents: IntentVersion[] = initialIntent ? [initialIntent] : [];

  return {
    schemaVersion: 1,
    id: options.id ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`,
    ...(options.externalId ? { externalId: options.externalId } : {}),
    source: options.source,
    cwd: root,
    startedAt: now,
    intents,
    ...(initialIntent ? { currentIntent: initialIntent } : {}),
    baseline,
    initialSnapshot,
    lastSnapshot: initialSnapshot,
    events: [],
    expectedEventIds: [],
    agentReads: [],
    touchedPathsByTurn: {},
    declaredPlanPathsByTurn: {},
  };
}

const PREEXISTING_PROTECTION_RULES = new Set([
  "preexisting-file-deleted",
  "preexisting-file-rewritten",
]);

function isPreexistingProtectionEvent(event: SessionEvent): boolean {
  return event.codes.some((code) => PREEXISTING_PROTECTION_RULES.has(code));
}

export function appendSessionEvents(session: SessionRecord, candidates: SessionEvent[]): SessionEvent[] {
  const accepted: SessionEvent[] = [];
  for (const candidate of candidates) {
    if (isPreexistingProtectionEvent(candidate)) {
      const duplicate = session.events.some((event) =>
        isPreexistingProtectionEvent(event)
        && event.path === candidate.path
        && event.turnId === candidate.turnId,
      );
      if (duplicate) continue;
    }
    session.events.push(candidate);
    accepted.push(candidate);
  }
  return accepted;
}

export function recordAgentRead(
  session: SessionRecord,
  filePath: string,
  turnId: string,
): AgentReadRecord {
  const reads = session.agentReads ??= [];
  const existing = reads.find((read) => read.path === filePath && read.turnId === turnId);
  if (existing) return existing;
  const read = { path: filePath, turnId, timestamp: new Date().toISOString() };
  reads.push(read);
  return read;
}

export function turnTouchedPathCount(session: SessionRecord, turnId: string | undefined, pending: ObservedChange[]): number {
  const paths = new Set(turnId ? session.touchedPathsByTurn?.[turnId] ?? [] : []);
  for (const change of pending) paths.add(change.path);
  return paths.size;
}

export function recordTurnTouchedPaths(session: SessionRecord, turnId: string | undefined, paths: string[]): void {
  if (!turnId || paths.length === 0) return;
  const byTurn = session.touchedPathsByTurn ??= {};
  byTurn[turnId] = [...new Set([...(byTurn[turnId] ?? []), ...paths])];
}

export function recordDeclaredPlanPaths(session: SessionRecord, turnId: string, paths: string[]): void {
  if (paths.length === 0) return;
  const byTurn = session.declaredPlanPathsByTurn ??= {};
  byTurn[turnId] = [...new Set([...(byTurn[turnId] ?? []), ...paths])];
}

function createdPathsThisTurn(
  session: SessionRecord,
  turnId: string | undefined,
  pending: ObservedChange[] = [],
): string[] {
  if (!turnId) return pending.filter((change) => change.kind === "created").map((change) => change.path);
  return [...new Set([
    ...session.events
      .filter((event) => event.turnId === turnId && event.changeKind === "created" && event.path)
      .map((event) => event.path as string),
    ...pending.filter((change) => change.kind === "created").map((change) => change.path),
  ])];
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
  root: string,
  detail?: string,
): SessionEvent {
  const scoringConfig = loadScoringConfigSync(root);
  const proposedBehavior = type === "proposed-action" && findings.length > 0;
  const behaviorFindings = findings.map((item) => ({
    id: item.code,
    severity: item.severity,
    reason: item.reason,
    available: true,
    triggered: true,
    rawValue: true,
  }));
  const behaviorDecision = evaluateBehaviorDecision(behaviorFindings, scoringConfig);
  const level = proposedBehavior
    ? behaviorDecision.verdict
    : findings.length > 0 ? highestSeverity(findings) : "GREEN";
  const relevant = proposedBehavior ? findings : findings.filter((item) => item.severity === level);
  const ruleId = relevant[0]?.code ?? "session-lifecycle";
  return {
    id: `event-${Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    level,
    reasons: relevant.map((item) => item.reason),
    codes: relevant.map((item) => item.code),
    ruleId,
    scoreBreakdown: proposedBehavior
      ? behaviorScoreBreakdown(
          behaviorFindings,
          behaviorDecision,
          scoringConfig,
        )
      : absoluteScoreBreakdown(scoringConfig, level, ruleId),
    expected: false,
    ...(proposedBehavior ? { stage: "behavior" as const } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Classifie une modification de fichier avant son exécution. Cette fonction
 * appartient au Core : les adapters Claude/Codex ne font que traduire leurs
 * payloads natifs vers ces paramètres communs.
 */
export function classifyProposedFileChange(
  session: SessionRecord,
  absolutePath: string,
  kind: ObservedChange["kind"],
  operation: "edit" | "write" | "rename",
  deletedLineCount = 0,
  proposedContent?: string,
  fullFileReformat?: boolean,
  classifier: Classifier = new DeterministicClassifier(),
): SessionEvent | null {
  if (!isInsideRoot(session.cwd, absolutePath)) return null;
  const change = changeFromAbsolutePath(session.cwd, absolutePath, kind);
  if (!change) return null;
  change.before = session.lastSnapshot.files[change.path];
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
    declaredPlanPaths: currentIntent ? session.declaredPlanPathsByTurn?.[currentIntent.turnId] ?? [] : [],
    createdPathsThisTurn: createdPathsThisTurn(session, currentIntent?.turnId, [change]),
    emittedRuleIds: session.events.flatMap((event) => event.codes),
    operation: {
      kind: operation,
      deletedLineCount,
      ...(proposedContent !== undefined ? { proposedContent } : {}),
      ...(fullFileReformat !== undefined ? { fullFileReformat } : {}),
    },
  });
  return {
    id: `event-${Date.now()}-${randomUUID().slice(0, 8)}`,
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
    stage: classification.stage,
    ...(classification.exemptedBy ? { exemptedBy: classification.exemptedBy } : {}),
    ...(classification.shadowScore ? { shadowScore: classification.shadowScore } : {}),
  };
}

export function addIntent(
  session: SessionRecord,
  text: string,
  source: IntentVersion["source"],
): IntentVersion | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const intent: IntentVersion = {
    version: session.intents.length + 1,
    text: trimmed,
    source: session.intents.length === 0 ? "initial" : source,
    addedAt: new Date().toISOString(),
  };
  session.intents.push(intent);
  return intent;
}

export function setCurrentIntent(
  session: SessionRecord,
  text: string,
  source: IntentVersion["source"] = "user-follow-up",
): IntentVersion | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (session.currentIntent?.text.trim() === trimmed) return session.currentIntent;
  const intent = addIntent(session, text, source);
  if (intent) session.currentIntent = intent;
  return intent;
}

export function markEventFeedback(
  session: SessionRecord,
  eventId: string,
  feedback: AlertFeedback,
): SessionEvent | null {
  const event = session.events.find((item) => item.id === eventId && item.level !== "GREEN");
  if (!event) return null;
  const previous = event.feedback;
  event.feedback = feedback;
  if (previous !== feedback) recordFeedbackStats(session.cwd, event, previous, feedback);
  return event;
}

export function processChanges(
  session: SessionRecord,
  changes: ObservedChange[],
  currentSnapshot: RepositorySnapshot,
  classifier: Classifier = new DeterministicClassifier(),
): SessionEvent[] {
  const currentIntent = readCurrentIntentSync(session.cwd);
  const count = turnTouchedPathCount(session, currentIntent?.turnId, changes);
  const deletionCount = deletedPathCount(session, changes);
  const events: SessionEvent[] = [];
  for (const change of changes) {
    const classification: Classification = classifier.classify({
      root: session.cwd,
      change,
      baseline: session.baseline,
      initialSnapshot: session.initialSnapshot,
      currentSnapshot,
      changedFileCount: count,
      deletedFileCount: deletionCount,
      agentReads: session.agentReads ?? [],
      declaredPlanPaths: currentIntent ? session.declaredPlanPathsByTurn?.[currentIntent.turnId] ?? [] : [],
      createdPathsThisTurn: createdPathsThisTurn(session, currentIntent?.turnId, changes),
      emittedRuleIds: session.events.flatMap((event) => event.codes),
      operation: {
        kind: "observed",
        deletedLineCount: Math.max(
          0,
          (change.before?.lineCount ?? 0) - (change.after?.lineCount ?? change.before?.lineCount ?? 0),
        ),
      },
    });
    const event: SessionEvent = {
      id: `event-${Date.now()}-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "change" as const,
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
      stage: classification.stage,
      ...(classification.exemptedBy ? { exemptedBy: classification.exemptedBy } : {}),
      ...(classification.shadowScore ? { shadowScore: classification.shadowScore } : {}),
    };
    events.push(...appendSessionEvents(session, [event]));
  }

  session.lastSnapshot = currentSnapshot;
  recordTurnTouchedPaths(session, currentIntent?.turnId, changes.map((change) => change.path));
  recordCurrentStatus(session.cwd, events);
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
