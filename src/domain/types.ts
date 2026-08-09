export type Severity = "GREEN" | "ORANGE" | "RED";

export type AlertFeedback = "noise" | "useful";

export type ChangeKind = "created" | "modified" | "deleted";

export type GitChangeKind =
  | "modified"
  | "untracked"
  | "deleted"
  | "added"
  | "renamed";

export interface GitFileState {
  path: string;
  status: string;
  kind: GitChangeKind;
  workingHash?: string;
  headHash?: string;
}

export interface GitBaseline {
  isGit: boolean;
  root: string;
  branch: string | null;
  commit: string | null;
  capturedAt: string;
  files: GitFileState[];
}

export interface FileSnapshotEntry {
  hash: string;
  size: number;
  lineCount?: number;
}

export interface PackageManifestSnapshot {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface RepositorySnapshot {
  capturedAt: string;
  files: Record<string, FileSnapshotEntry>;
  manifests: Record<string, PackageManifestSnapshot>;
}

export interface ObservedChange {
  path: string;
  kind: ChangeKind;
  before?: FileSnapshotEntry;
  after?: FileSnapshotEntry;
}

export interface RuleFinding {
  severity: Severity;
  code: string;
  reason: string;
}

export type ScoreRawValue = number | string | boolean | null | Record<string, number | string | boolean | null>;

export interface ScoreSignalBreakdown {
  id: string;
  available: boolean;
  rawValue: ScoreRawValue;
  normalizedValue: number | null;
  weight: number;
  contribution: number;
  explanation: string;
}

export interface ScoreBreakdown {
  mode: "scored" | "absolute";
  configVersion: string;
  score: number | null;
  unclampedScore: number | null;
  thresholds: { orange: number; red: number };
  normalizationFactor: number;
  signals: ScoreSignalBreakdown[];
  unavailableSignals: string[];
  verdict: Severity;
  absoluteRuleId?: string;
}

export interface Classification {
  level: Severity;
  reasons: string[];
  codes: string[];
  ruleId: string;
  scoreBreakdown: ScoreBreakdown;
  intentVersion?: number;
  turnId?: string;
}

export interface ClassificationInput {
  root: string;
  change: ObservedChange;
  baseline: GitBaseline;
  initialSnapshot: RepositorySnapshot;
  currentSnapshot: RepositorySnapshot;
  changedFileCount: number;
  deletedFileCount: number;
  agentReads: AgentReadRecord[];
  emittedRuleIds: string[];
  operation?: {
    kind: "edit" | "write" | "observed";
    deletedLineCount?: number;
  };
}

export interface Classifier {
  readonly name: string;
  classify(input: ClassificationInput): Classification;
}

export interface IntentVersion {
  version: number;
  text: string;
  source: "initial" | "user-follow-up" | "manual-scope";
  addedAt: string;
}

export interface CurrentIntentState {
  schemaVersion: 1;
  version: number;
  turnId: string;
  text: string;
  scopeAdditions: string[];
  updatedAt: string;
}

export interface ScoringConfig {
  schemaVersion: 1;
  version: string;
  scoreScale: number;
  minimumScore: number;
  maximumScore: number;
  thresholds: { orange: number; red: number };
  weights: {
    importDistance: number;
    fileRarity: number;
    anchorCooccurrence: number;
    deletedLines: number;
    turnFileCount: number;
    sensitiveFile: number;
    explicitIntent: number;
  };
  signalParameters: {
    graphDistanceRisk: {
      distance0: number;
      distance1: number;
      distance2: number;
      distance3: number;
      perAdditionalHop: number;
      disconnected: number;
    };
    deletedLinesSaturation: number;
    turnFileCountSaturation: number;
  };
  secretPathPatterns: string[];
}

export interface RepoProfile {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  commitCount: number;
  modificationRates: {
    available: boolean;
    minimumCommits: number;
    rates: Record<string, number>;
    touchCounts: Record<string, number>;
    reason?: string;
  };
  cooccurrence: {
    available: boolean;
    minimumCommits: number;
    frequencies: Record<string, number>;
    reason?: string;
  };
  sensitivity: {
    gitignorePatterns: string[];
    secretPathPatterns: string[];
    files: Record<string, string[]>;
  };
}

export interface ImportGraph {
  schemaVersion: 1;
  generatedAt: string;
  nodes: string[];
  edges: Record<string, string[]>;
  unresolvedImports: Record<string, string[]>;
}

export interface DriftLightConfig {
  blockOnRed: boolean;
  blockOnOrange: boolean;
  largeLineDeletionThreshold: number;
  notifyOnRed: boolean;
  notifyOnOrange: boolean;
  notificationSound: boolean;
  terminalTitle: boolean;
}

export interface AgentReadRecord {
  path: string;
  turnId: string;
  timestamp: string;
}

export interface CurrentStatus {
  schemaVersion: 1;
  level: Severity;
  counts: Record<Severity, number>;
  lastEventAt: string | null;
  acknowledgedAt: string | null;
}

export interface SessionEvent {
  id: string;
  timestamp: string;
  type: "change" | "proposed-action" | "lifecycle";
  path?: string;
  changeKind?: ChangeKind;
  level: Severity;
  reasons: string[];
  codes: string[];
  ruleId: string;
  scoreBreakdown: ScoreBreakdown;
  expected: boolean;
  feedback?: AlertFeedback;
  intentVersion?: number;
  turnId?: string;
  detail?: string;
}

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  externalId?: string;
  source: "cli" | "claude-code";
  cwd: string;
  startedAt: string;
  endedAt?: string;
  intents: IntentVersion[];
  currentIntent?: IntentVersion;
  baseline: GitBaseline;
  initialSnapshot: RepositorySnapshot;
  lastSnapshot: RepositorySnapshot;
  events: SessionEvent[];
  expectedEventIds: string[];
  agentReads?: AgentReadRecord[];
  touchedPathsByTurn?: Record<string, string[]>;
}

export interface ClaudeHookInput {
  session_id: string;
  cwd: string;
  hook_event_name:
    | "SessionStart"
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "SessionEnd"
    | string;
  prompt?: string;
  prompt_id?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}
