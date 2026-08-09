export type ScopeLightEventType =
  | "SESSION_STARTED"
  | "SESSION_ENDED"
  | "USER_PROMPT"
  | "TOOL_PROPOSED"
  | "TOOL_COMPLETED"
  | "FILE_EDITED"
  | "COMMAND_PROPOSED"
  | "PLAN_DECLARED"
  | "SUBAGENT_STARTED"
  | "SUBAGENT_STOPPED"
  | "AGENT_STOPPED";

export interface ScopeLightEvent {
  protocol_version: 1;
  agent: "codex";
  session_id: string;
  workspace: string;
  timestamp: string;
  event: ScopeLightEventType;
  payload: Record<string, unknown>;
}

export type AdapterHealthState =
  | "NOT_INSTALLED"
  | "INSTALLED_NEEDS_APPROVAL"
  /** Approuvé, mais l'utilisateur ou Codex a désactivé au moins un hook. */
  | "HOOKS_DISABLED"
  /** La configuration a changé après approbation : les empreintes ne valent plus. */
  | "TRUST_STALE"
  | "CONNECTED"
  | "DEGRADED";

/** Détail par hook, tel que Codex l'enregistre de son côté. */
export interface AdapterHookTrust {
  event: string;
  registered: boolean;
  enabled: boolean;
}

export interface AdapterStatus {
  state: AdapterHealthState;
  adapterVersion: string;
  codexDetected: boolean;
  lastEventAt?: string;
  configPath?: string;
  message?: string;
  /** Chemin de la configuration où l'agent tient son état de confiance. */
  trustPath?: string;
  hooks?: AdapterHookTrust[];
  /** Hooks nommément en cause, pour éviter un message générique. */
  blockingEvents?: string[];
}

export interface ScopeLightAdapter {
  detect(): Promise<boolean>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  healthCheck(): Promise<AdapterStatus>;
  normalize(nativeEvent: unknown): ScopeLightEvent[];
}
