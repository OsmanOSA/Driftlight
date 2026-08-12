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
  /** Présent pour les signaux à règles de l'étage 2. */
  triggered?: boolean;
  severity?: Severity;
  /** Famille indépendante utilisée par la table de décision comportementale. */
  family?: string;
}

export interface ScoreBreakdown {
  mode: "scored" | "absolute" | "rules";
  configVersion: string;
  score: number | null;
  unclampedScore: number | null;
  thresholds: { orange: number; red: number };
  normalizationFactor: number;
  signals: ScoreSignalBreakdown[];
  unavailableSignals: string[];
  verdict: Severity;
  absoluteRuleId?: string;
  /** Règle de la table comportementale ayant rendu le verdict. */
  decisionRuleId?: string;
  /** Familles actives après déduplication des signaux corrélés. */
  activeSignalFamilies?: string[];
  /**
   * Signaux neutralisés par le feedback accumulé sur ce répertoire. Présent dès
   * qu'un apprentissage a joué : une alerte tue en silence serait impossible à
   * distinguer d'une absence de signal.
   */
  learnedSuppressions?: string[];
}

/** Étage ayant rendu le verdict. Le premier qui décide arrête l'évaluation. */
export type ClassificationStage = "absolute" | "exempt" | "behavior" | "shadow";

export interface Classification {
  level: Severity;
  reasons: string[];
  codes: string[];
  ruleId: string;
  scoreBreakdown: ScoreBreakdown;
  stage: ClassificationStage;
  /** Exemption ayant joué à l'étage 1, si le verdict vient de là. */
  exemptedBy?: string;
  /**
   * Signaux structurels de l'étage 3, calculés et journalisés mais sans effet
   * sur le verdict tant que `shadowSignalsCanAlert` vaut false.
   */
  shadowScore?: ScoreBreakdown;
  intentVersion?: number;
  turnId?: string;
}

export interface ClassificationInput {
  root: string;
  /**
   * Session à l'origine du changement. L'intention courante lui appartient :
   * sans cette identité, deux sessions ouvertes sur le même dépôt seraient
   * classées avec la demande de la dernière à avoir parlé.
   */
  sessionId?: string;
  change: ObservedChange;
  baseline: GitBaseline;
  initialSnapshot: RepositorySnapshot;
  currentSnapshot: RepositorySnapshot;
  changedFileCount: number;
  deletedFileCount: number;
  agentReads: AgentReadRecord[];
  /** Chemins annoncés dans le plan du tour courant, comme indice et non autorisation. */
  declaredPlanPaths?: string[];
  /** Chemins effectivement créés pendant le tour courant, pas toute la session. */
  createdPathsThisTurn?: string[];
  emittedRuleIds: string[];
  operation?: {
    kind: "edit" | "write" | "rename" | "observed";
    deletedLineCount?: number;
    /** Contenu complet proposé, lorsqu'un hook le fournit sans l'inventer. */
    proposedContent?: string;
    /** Fait observable fourni par l'adapter, si un reformatage complet est détecté. */
    fullFileReformat?: boolean;
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
    /** Champs v1 tolérés pour les configurations existantes, jamais utilisés par le shadowScore v2. */
    deletedLines?: number;
    turnFileCount?: number;
    sensitiveFile?: number;
    explicitIntent?: number;
  };
  signalParameters: {
    minimumGraphFiles: number;
    minimumModificationCommits: number;
    minimumCooccurrenceCommits: number;
    graphDistanceRisk: {
      distance0: number;
      distance1: number;
      distance2: number;
      distance3: number;
      perAdditionalHop: number;
      disconnected: number;
    };
    deletedLinesSaturation?: number;
    turnFileCountSaturation?: number;
  };
  /** Étage 2 : sévérités, familles et table de décision, jamais en dur. */
  behavior: {
    severities: Record<string, Severity>;
    signalFamilies: Record<string, string>;
    /**
     * Familles qui corroborent sans jamais décider seules. Une preuve de
     * procédé — « l'agent n'a pas lu ce fichier » — décrit la manière de faire,
     * pas un dommage observable : elle renforce un autre signal mais ne peut pas
     * allumer le voyant à elle seule.
     */
    corroboratingFamilies?: string[];
    decisionTable: Array<{
      id: string;
      verdict: Severity;
      when: {
        minimumSignalSeverity: "ORANGE" | "RED";
        minimumDistinctFamilies: number;
        requiredFamilies?: string[];
      };
    }>;
    /** Valeur explicative uniquement ; le verdict suit la table de règles. */
    severityWeights: Record<Severity, number>;
  };
  secretPathPatterns: string[];
}

export interface RepoProfile {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  /** Clés du cache disque : un profil d'un autre HEAD n'est jamais consommé. */
  sourceCommit?: string | null;
  configVersion?: string;
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

/**
 * Force du blocage sur un verdict rouge.
 *
 * `blockOnRed` fait renvoyer une demande de confirmation, que l'agent hôte peut
 * court-circuiter selon son mode de permission : l'utilisateur voit alors une
 * alerte rouge pendant que l'action se déroule quand même. `enforceRed` décide
 * si DriftLight passe au refus ferme, que rien ne contourne.
 *
 * - `never` : toujours demander, jamais refuser.
 * - `irreversible` : refuser ce que rien ne pourra restaurer — la destruction de
 *   travail non commité — et demander pour le reste. C'est le seul cas où une
 *   erreur de DriftLight coûte moins cher qu'une perte définitive.
 * - `always` : refuser tout rouge. Le plus sûr, le plus friand de faux positifs.
 */
export type RedEnforcement = "never" | "irreversible" | "always";

export interface DriftLightConfig {
  blockOnRed: boolean;
  blockOnOrange: boolean;
  enforceRed: RedEnforcement;
  largeLineDeletionThreshold: number;
  notifyOnRed: boolean;
  notifyOnOrange: boolean;
  notificationSound: boolean;
  terminalTitle: boolean;
  /**
   * Autorise les signaux structurels de l'étage 3 à peser sur le verdict.
   * Faux par défaut : ils restent en observation le temps de mesurer, sur usage
   * réel, s'ils auraient bien classé.
   */
  shadowSignalsCanAlert: boolean;
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
  stage?: ClassificationStage;
  exemptedBy?: string;
  shadowScore?: ScoreBreakdown;
  intentVersion?: number;
  turnId?: string;
  detail?: string;
}

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  externalId?: string;
  source: "cli" | "claude-code" | "codex";
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
  declaredPlanPathsByTurn?: Record<string, string[]>;
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
