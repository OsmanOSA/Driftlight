import path from "node:path";
import type {
  ClassificationInput,
  GitBaseline,
  ObservedChange,
  RuleFinding,
  Severity,
} from "../domain/types.js";
import { toPosixPath } from "../shared/paths.js";

export type ProtectionEvaluationInput = ClassificationInput & {
  task: string;
  scopeAdditions: string[];
  readPathsThisTurn: string[];
  readPathsInSession: string[];
  largeLineDeletionThreshold: number;
};

const SEVERITY_ORDER: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };

function intentText(task: string, scopeAdditions: string[]): string {
  return [task, ...scopeAdditions].join(" ").toLowerCase().replaceAll("\\", "/");
}

export function pathExplicitlyExpected(
  task: string,
  scopeAdditions: string[],
  filePath: string,
): boolean {
  const intent = intentText(task, scopeAdditions);
  const normalizedPath = toPosixPath(filePath).toLowerCase();
  const basename = path.posix.basename(normalizedPath);
  return intent.includes(normalizedPath) || (basename.length >= 4 && intent.includes(basename));
}

function finding(severity: Severity, code: string, reason: string): RuleFinding {
  return { severity, code, reason };
}

export function evaluatePreexistingProtection(input: ProtectionEvaluationInput): RuleFinding[] {
  const state = input.baseline.files.find((file) => file.path === input.change.path);
  if (!state || state.kind === "deleted") return [];

  const normalizedPath = toPosixPath(input.change.path).toLowerCase();
  const readThisTurn = input.readPathsThisTurn.some((filePath) => toPosixPath(filePath).toLowerCase() === normalizedPath);
  if (pathExplicitlyExpected(input.task, input.scopeAdditions, input.change.path) || readThisTurn) return [];

  const current = input.currentSnapshot.files[input.change.path];
  const previous = input.change.before ?? input.initialSnapshot.files[input.change.path];
  const deleted = input.change.kind === "deleted" || !current;
  const fullRewrite = input.operation?.kind === "write" && Boolean(previous);
  const readInSession = input.readPathsInSession.some((filePath) => toPosixPath(filePath).toLowerCase() === normalizedPath);
  const editWithoutRead = input.change.kind === "modified" && !readInSession;
  const measuredLineDeletion = Math.max(
    0,
    input.operation?.deletedLineCount
      ?? ((previous?.lineCount ?? 0) - (current?.lineCount ?? previous?.lineCount ?? 0)),
  );
  const largeLineDeletion = measuredLineDeletion >= input.largeLineDeletionThreshold;
  const restoredToHead = Boolean(state.headHash && current?.hash === state.headHash);
  if (!deleted && !fullRewrite && !editWithoutRead && !largeLineDeletion && !restoredToHead) return [];

  const recovery = `Des modifications non sauvegardées présentes avant la session risquent d'être perdues dans ${input.change.path}. Refusez l'action si elle est encore en attente ; sinon, utilisez Annuler ou l'historique local de l'éditeur pour les récupérer.`;
  if (deleted) return [finding("RED", "preexisting-file-deleted", recovery)];
  return [finding("ORANGE", "preexisting-destructive-edit", recovery)];
}

export function highestSeverity(findings: RuleFinding[]): Severity {
  return findings.reduce<Severity>(
    (highest, current) => SEVERITY_ORDER[current.severity] > SEVERITY_ORDER[highest] ? current.severity : highest,
    "GREEN",
  );
}

export function classifyCommand(command: string, baseline: GitBaseline): RuleFinding[] {
  const normalized = command.toLowerCase();
  const findings: RuleFinding[] = [];
  const destructiveGit = /\bgit\s+(?:-[^\s]+\s+)*(restore|reset|clean|checkout)\b/i.test(command);
  const destructiveFs = /(^|[;&|]\s*)(rm\s+(-[^\s]+\s+)*|del\s+|remove-item\s+)/i.test(command);

  if (destructiveGit) {
    const protectedCount = baseline.files.length;
    findings.push(finding(
      "RED",
      "destructive-git-command",
      `Commande Git potentiellement destructive${protectedCount > 0 ? ` pour ${protectedCount} changement(s) préexistant(s)` : ""}.`,
    ));
  }
  if (destructiveFs) findings.push(finding("RED", "destructive-file-command", "Commande de suppression détectée."));
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall)\b/.test(normalized)) {
    findings.push(finding("ORANGE", "dependency-command", "Commande de gestion des dépendances détectée."));
  }
  if (/\b(terraform|pulumi|kubectl|helm)\b/.test(normalized)) {
    findings.push(finding("RED", "infrastructure-command", "Commande d'infrastructure détectée."));
  }
  return findings;
}

export function changeFromAbsolutePath(root: string, filePath: string, kind: ObservedChange["kind"]): ObservedChange | null {
  const relative = toPosixPath(path.relative(root, filePath));
  if (relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return { path: relative, kind };
}
