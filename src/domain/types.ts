export type Severity = "GREEN" | "ORANGE" | "RED";

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

export interface Classification {
  level: Severity;
  reasons: string[];
  codes: string[];
}

export interface ClassificationInput {
  task: string;
  scopeAdditions: string[];
  change: ObservedChange;
  baseline: GitBaseline;
  initialSnapshot: RepositorySnapshot;
  currentSnapshot: RepositorySnapshot;
  changedFileCount: number;
  deletedFileCount: number;
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

export interface SessionEvent {
  id: string;
  timestamp: string;
  type: "change" | "proposed-action" | "lifecycle";
  path?: string;
  changeKind?: ChangeKind;
  level: Severity;
  reasons: string[];
  codes: string[];
  expected: boolean;
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
  baseline: GitBaseline;
  initialSnapshot: RepositorySnapshot;
  lastSnapshot: RepositorySnapshot;
  events: SessionEvent[];
  expectedEventIds: string[];
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
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
}
