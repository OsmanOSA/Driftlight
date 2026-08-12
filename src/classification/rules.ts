import path from "node:path";
import os from "node:os";
import { loadScoringConfigSync } from "../config/scoring-config.js";
import type {
  ClassificationInput,
  GitBaseline,
  ObservedChange,
  RuleFinding,
  ScoringConfig,
  Severity,
} from "../domain/types.js";
import { isInsideRoot, toPosixPath } from "../shared/paths.js";

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

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Résolution locale prudente : chemin complet, nom de fichier, ou répertoire
 * explicitement cité seul. Un répertoire inclus dans un autre chemin de la
 * demande n'élargit pas implicitement tout le scope.
 */
export function pathExplicitlyExpected(
  task: string,
  scopeAdditions: string[],
  filePath: string,
): boolean {
  const intent = intentText(task, scopeAdditions);
  const normalizedPath = toPosixPath(filePath).toLowerCase();
  const basename = path.posix.basename(normalizedPath);
  if (intent.includes(normalizedPath) || (basename.length >= 4 && intent.includes(basename))) return true;

  const withoutMentionedPaths = intent.replace(/[\w.@-]+(?:\/[\w.@-]+)+/g, " ");
  const directories = path.posix.dirname(normalizedPath).split("/").filter((part) => part.length >= 4);
  return directories.some((directory) =>
    new RegExp(`(^|[^a-z0-9_.-])${escaped(directory)}([^a-z0-9_.-]|$)`, "i").test(withoutMentionedPaths),
  );
}

function finding(severity: Severity, code: string, reason: string): RuleFinding {
  return { severity, code, reason };
}

/**
 * Étage 0, au sens strict : seule la perte d'un fichier déjà sale au démarrage
 * par suppression ou réécriture complète, hors demande courante, décide ici.
 */
export function evaluatePreexistingProtection(input: ProtectionEvaluationInput): RuleFinding[] {
  const state = input.baseline.files.find((file) => file.path === input.change.path);
  if (!state || state.kind === "deleted") return [];
  if (pathExplicitlyExpected(input.task, input.scopeAdditions, input.change.path)) return [];

  const previous = input.change.before ?? input.initialSnapshot.files[input.change.path];
  const deleted = input.change.kind === "deleted" || !input.currentSnapshot.files[input.change.path];
  const fullRewrite = input.operation?.kind === "write" && Boolean(previous);
  if (!deleted && !fullRewrite) return [];

  const recovery = `Des modifications non sauvegardées présentes avant la session risquent d'être perdues dans ${input.change.path}. Refusez l'action si elle est encore en attente ; sinon, utilisez Annuler ou l'historique local de l'éditeur pour les récupérer.`;
  return [finding(
    "RED",
    deleted ? "preexisting-file-deleted" : "preexisting-file-rewritten",
    recovery,
  )];
}

export function highestSeverity(findings: RuleFinding[]): Severity {
  return findings.reduce<Severity>(
    (highest, current) => SEVERITY_ORDER[current.severity] > SEVERITY_ORDER[highest] ? current.severity : highest,
    "GREEN",
  );
}

function stripNonExecutedBodies(command: string): string {
  const kept: string[] = [];
  let heredocEnd: string | null = null;
  let hereStringEnd: "'@" | "\"@" | null = null;
  for (const line of command.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (heredocEnd) {
      if (trimmed === heredocEnd) heredocEnd = null;
      continue;
    }
    if (hereStringEnd) {
      if (trimmed === hereStringEnd) hereStringEnd = null;
      continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (heredoc?.[1]) heredocEnd = heredoc[1];
    if (/(^|\s)@'\s*$/.test(line)) hereStringEnd = "'@";
    else if (/(^|\s)@"\s*$/.test(line)) hereStringEnd = "\"@";
  }
  return kept.join("\n");
}

function executableSegments(command: string): string[] {
  return stripNonExecutedBodies(command)
    .split(/\r?\n|&&|\|\||[;|]/)
    .map((segment) => segment.replace(/\s+#.*$/, "").trim())
    .filter(Boolean)
    .filter((segment) => !/^(?:echo|printf|write-output|write-host)\b/i.test(segment));
}

function tokens(value: string): string[] {
  return value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
}

function hasDryRun(args: string[]): boolean {
  return args.some((arg) => ["--dry-run", "--help", "-h", "-whatif"].includes(arg.toLowerCase()));
}

function destructiveGitSegment(segment: string): boolean {
  const match = /\bgit\s+(?:-[^\s]+\s+)*(clean|reset|restore|checkout)\b([^\r\n]*)/i.exec(segment);
  if (!match?.[1]) return false;
  const subcommand = match[1].toLowerCase();
  const args = tokens(match[2] ?? "");
  if (hasDryRun(args)) return false;
  if (subcommand === "clean") {
    if (args.some((arg) => arg === "-n" || /^-[^-]*n/i.test(arg))) return false;
    return args.some((arg) => /^-[^-]*f/i.test(arg) || arg === "--force");
  }
  if (subcommand === "reset") return args.some((arg) => ["--hard", "--merge", "--keep"].includes(arg));
  if (subcommand === "restore") {
    return !args.includes("--staged") || args.includes("--worktree");
  }
  // Changer de branche est normal. Restaurer des chemins ou forcer le checkout ne l'est pas.
  return args.includes("--") || args.includes("-f") || args.includes("--force");
}

function severityFor(config: ScoringConfig, id: string): Severity {
  return config.behavior.severities[id] ?? "GREEN";
}

/**
 * Une suppression ne concerne DriftLight que si elle peut atteindre le dépôt
 * observé. Effacer un dossier temporaire hors périmètre est du bruit pur.
 *
 * Prudence assumée : un argument non résolvable — variable shell, glob,
 * substitution — vaut « peut-être dans le dépôt » et laisse l'alerte en place.
 * Seules des cibles toutes explicitement extérieures désamorcent le signal.
 */
/**
 * Affectations littérales visibles dans la commande elle-même.
 *
 * Un agent écrit couramment `SB="/tmp/bac" ; rm -rf "$SB"`. Refuser de lire
 * l'affectation revient à alerter sur un chemin que la commande elle-même
 * désigne comme extérieur au dépôt — mesuré comme la première source de bruit
 * rouge en usage réel. Seules les valeurs littérales sont retenues : une valeur
 * qui dépend d'une autre variable, de l'environnement ou d'une substitution
 * reste inconnue, et l'inconnu continue de valoir prudence.
 */
function shellAssignments(command: string): Map<string, string> {
  const values = new Map<string, string>();
  // La valeur doit occuper à elle seule la fin du segment. Sans cette borne,
  // `$chemin = Join-Path $env:APPDATA "x"` était lu comme l'affectation
  // littérale « Join-Path » : une invocation de commande prise pour une valeur.
  // Le danger n'est pas le faux positif que cela produisait ici, mais le faux
  // négatif symétrique — un nom de commande ressemblant à un chemin absolu
  // aurait fait passer une suppression pour extérieure au dépôt.
  const pattern =
    /(?:^|\n|;|&&|\|\|)\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s*(?=$|\n|;|&&|\|\|)/g;
  for (const match of command.matchAll(pattern)) {
    const name = match[1];
    const raw = match[2];
    if (name === undefined || raw === undefined) continue;
    const value = raw.replace(/^["']|["']$/g, "");
    if (/[$`]/.test(value)) continue;
    values.set(name, value);
  }

  // Forme employée par DriftLight et de nombreux tests Windows : un nom
  // imprévisible, mais nécessairement réduit à un seul segment sous TEMP.
  // On n'accepte pas un enfant variable ou une autre invocation de commande :
  // ces formes restent volontairement inconnues et donc signalées.
  const temporaryGuidDirectory =
    /(?:^|\r?\n|;|&&|\|\|)\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Join-Path\s+\$env:(?:TEMP|TMP|TMPDIR)\s+\(\s*["']([^"'\\/\r\n]*)["']\s*\+\s*\[guid\]::NewGuid\(\)\.ToString\(\s*["']N["']\s*\)\s*\)\s*(?=$|\r?\n|;|&&|\|\|)/gi;
  for (const match of command.matchAll(temporaryGuidDirectory)) {
    const name = match[1];
    const prefix = match[2];
    if (name === undefined || prefix === undefined) continue;
    values.set(name, path.join(os.tmpdir(), `${prefix}00000000000000000000000000000000`));
  }

  // GetFullPath ne change pas la cible d'une valeur déjà résolue. Cette copie
  // est limitée à une variable connue ; elle ne transforme jamais une valeur
  // ambiguë en chemin réputé sûr.
  const normalizedAlias =
    /(?:^|\r?\n|;|&&|\|\|)\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[(?:IO|System\.IO)\.Path\]::GetFullPath\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*(?=$|\r?\n|;|&&|\|\|)/gi;
  for (const match of command.matchAll(normalizedAlias)) {
    const name = match[1];
    const source = match[2];
    if (name === undefined || source === undefined) continue;
    const value = values.get(source);
    if (value !== undefined) values.set(name, path.resolve(value));
  }
  return values;
}

/**
 * Remplace les variables connues. Rend `null` dès qu'une seule reste inconnue :
 * une résolution partielle serait pire que pas de résolution du tout, puisqu'on
 * conclurait sur un chemin dont il manque un morceau.
 */
function expandVariables(target: string, values: Map<string, string>): string | null {
  let unresolved = false;
  const expanded = target.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_whole, braced: string | undefined, plain: string | undefined) => {
      const value = values.get(braced ?? plain ?? "");
      if (value === undefined) unresolved = true;
      return value ?? "";
    },
  );
  return unresolved ? null : expanded;
}

function deletionTargets(segment: string, values: Map<string, string>): Array<string | null> {
  return tokens(segment)
    .slice(1)
    .filter((token) => !token.startsWith("-"))
    .map((token) => expandVariables(token, values));
}

function deletionStaysOutsideRoot(
  segment: string,
  root: string,
  values: Map<string, string>,
): boolean {
  const targets = deletionTargets(segment, values);
  if (targets.length === 0) return false;
  return targets.every((target) => {
    if (target === null || /[$`*?{}[\]~%]|\.\./.test(target)) return false;
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
    return !isInsideRoot(root, absolute);
  });
}

/**
 * Suppression que l'utilisateur vient de demander.
 *
 * Alerter sur ce qu'on vient de réclamer est la forme de bruit la plus sûre
 * pour faire désinstaller un outil. La racine du dépôt est exclue quoi qu'il
 * arrive : un point isolé se retrouve dans presque toutes les demandes, et
 * suffirait sinon à faire passer `rm -rf .` pour une instruction reçue.
 */
function deletionExplicitlyRequested(
  segment: string,
  root: string,
  values: Map<string, string>,
  intent: { text: string; scopeAdditions: string[] } | undefined,
): boolean {
  if (!intent) return false;
  const targets = deletionTargets(segment, values);
  if (targets.length === 0) return false;
  return targets.every((target) => {
    if (target === null) return false;
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
    if (!isInsideRoot(root, absolute)) return true;
    const relative = toPosixPath(path.relative(root, absolute));
    if (relative === "" || relative === ".") return false;
    return pathExplicitlyExpected(intent.text, intent.scopeAdditions, relative);
  });
}

/** Classification de commandes : corps non exécutés et dry-runs sont ignorés. */
export function classifyCommand(
  command: string,
  baseline: GitBaseline,
  config: ScoringConfig = loadScoringConfigSync(baseline.root),
  intent?: { text: string; scopeAdditions: string[] },
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const values = shellAssignments(command);
  for (const segment of executableSegments(command)) {
    const lower = segment.toLowerCase();
    if (destructiveGitSegment(segment)) {
      const protectedCount = baseline.files.length;
      findings.push(finding(
        severityFor(config, "destructive-git-command"),
        "destructive-git-command",
        `Commande Git destructive${protectedCount > 0 ? ` pour ${protectedCount} changement(s) préexistant(s)` : ""}.`,
      ));
    }
    const fsDelete = /^(?:sudo\s+)?(?:rm\b|del\b|remove-item\b)/i.test(segment);
    if (
      fsDelete
      && !hasDryRun(tokens(segment))
      && !deletionStaysOutsideRoot(segment, baseline.root, values)
      && !deletionExplicitlyRequested(segment, baseline.root, values, intent)
    ) {
      findings.push(finding(
        severityFor(config, "destructive-file-command"),
        "destructive-file-command",
        "Commande de suppression détectée.",
      ));
    }
    if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall)\b/.test(lower) && !hasDryRun(tokens(segment))) {
      findings.push(finding(
        severityFor(config, "dependency-command"),
        "dependency-command",
        "Commande de gestion des dépendances détectée.",
      ));
    }
    const mutatingInfrastructure = /\bterraform\s+(apply|destroy|import|taint)\b|\bpulumi\s+(up|destroy|import)\b|\bkubectl\s+(apply|create|delete|edit|patch|replace|scale)\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b/.test(lower);
    if (mutatingInfrastructure && !hasDryRun(tokens(segment))) {
      findings.push(finding(
        severityFor(config, "infrastructure-command"),
        "infrastructure-command",
        "Commande d'infrastructure mutatrice détectée.",
      ));
    }
  }
  return findings.filter((item, index, all) => all.findIndex((candidate) => candidate.code === item.code) === index);
}

export function changeFromAbsolutePath(root: string, filePath: string, kind: ObservedChange["kind"]): ObservedChange | null {
  const relative = toPosixPath(path.relative(root, filePath));
  if (relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return { path: relative, kind };
}
