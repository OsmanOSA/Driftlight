import path from "node:path";
import type {
  ClassificationInput,
  GitBaseline,
  ObservedChange,
  RuleFinding,
  Severity,
} from "../domain/types.js";
import { addedDependencies } from "../observer/snapshot.js";
import { toPosixPath } from "../shared/paths.js";

type Category =
  | "dependency"
  | "config"
  | "ci"
  | "migration"
  | "environment"
  | "auth"
  | "infrastructure"
  | "deletion";

const CATEGORY_TERMS: Record<Category, string[]> = {
  dependency: ["dependency", "dependencies", "package", "npm", "pnpm", "yarn", "install", "sdk", "bibliothèque", "dependance", "dépendance"],
  config: ["config", "configuration", "configure", "paramètre", "setting"],
  ci: ["ci", "cd", "pipeline", "workflow", "github action", "buildkite", "circleci"],
  migration: ["migration", "database", "db", "schema", "sql", "base de données"],
  environment: [".env", "environment variable", "secret", "api key", "variable d'environnement"],
  auth: ["auth", "authentication", "authorization", "login", "permission", "role", "oauth", "connexion"],
  infrastructure: ["infra", "terraform", "pulumi", "kubernetes", "docker", "deploy", "aws", "cloud"],
  deletion: ["delete", "remove", "supprimer", "retirer", "effacer"],
};

const SEVERITY_ORDER: Record<Severity, number> = { GREEN: 0, ORANGE: 1, RED: 2 };

function taskText(input: ClassificationInput): string {
  return [input.task, ...input.scopeAdditions].join(" ").toLowerCase();
}

function categoryExpected(input: ClassificationInput, category: Category, details: string[] = []): boolean {
  const task = taskText(input);
  return [...CATEGORY_TERMS[category], ...details].some((term) => task.includes(term.toLowerCase()));
}

function finding(severity: Severity, code: string, reason: string): RuleFinding {
  return { severity, code, reason };
}

function protectedChangeFindings(input: ClassificationInput): RuleFinding[] {
  const state = input.baseline.files.find((file) => file.path === input.change.path);
  if (!state) return [];

  const current = input.currentSnapshot.files[input.change.path];
  if ((state.kind === "untracked" || state.kind === "added") && !current) {
    return [finding("RED", "preexisting-file-deleted", `Le fichier préexistant ${input.change.path} a été supprimé.`)];
  }

  if (state.kind === "deleted" && current) {
    return [finding("RED", "preexisting-deletion-restored", `La suppression préexistante de ${input.change.path} a été restaurée.`)];
  }

  if (state.kind === "modified") {
    if (!current) {
      return [finding("RED", "preexisting-file-deleted", `Le fichier déjà modifié ${input.change.path} a été supprimé.`)];
    }
    if (state.headHash && current.hash === state.headHash) {
      return [finding("RED", "preexisting-change-restored", `Les modifications préexistantes de ${input.change.path} semblent avoir été restaurées vers HEAD.`)];
    }
    return [finding("ORANGE", "preexisting-file-touched", `Ce fichier contenait déjà des modifications avant DriftLight.`)];
  }

  return [finding("ORANGE", "preexisting-file-touched", `Ce chemin faisait déjà partie du worktree modifié.`)];
}

function isEnvironmentOrSecret(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  const envFile = /^\.env(?:\.[^.]+)?$/.test(base) && !/\.(example|sample|template)$/.test(base);
  return envFile || /(^|[._-])(secret|secrets|credential|credentials|id_rsa|private[_-]?key)([._-]|$)/i.test(base) || /\.(pem|key|p12|pfx)$/i.test(base);
}

function isCi(filePath: string): boolean {
  return /(^|\/)(\.github\/workflows|\.circleci)(\/|$)/i.test(filePath)
    || /(^|\/)(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|jenkinsfile)$/i.test(filePath);
}

function isMigration(filePath: string): boolean {
  return /(^|\/)(migrations?|migrate)(\/|$)/i.test(filePath)
    || /(^|\/)(db|database)\/.*\.(sql|prisma)$/i.test(filePath);
}

function isAuthOrPermissions(filePath: string): boolean {
  return /(^|[\/._-])(auth|authentication|authorization|permissions?|access[_-]?control|iam|roles?)([\/._-]|$)/i.test(filePath);
}

function isInfrastructure(filePath: string): boolean {
  return /(^|\/)(infra|infrastructure|terraform|pulumi|k8s|kubernetes|helm)(\/|$)/i.test(filePath)
    || /(^|\/)(dockerfile|docker-compose[^/]*\.ya?ml)$/i.test(filePath)
    || /\.(tf|tfvars)$/i.test(filePath);
}

function isProductionConfig(filePath: string): boolean {
  return /(^|[\/._-])(prod|production)([\/._-]|$)/i.test(filePath)
    && /(config|settings?|deploy|values)/i.test(filePath);
}

function isConfig(filePath: string): boolean {
  const base = path.posix.basename(filePath);
  return /(^|\/)(config|configs|settings)(\/|$)/i.test(filePath)
    || /(^|[._-])(config|settings?)([._-]|$)/i.test(base)
    || /^(tsconfig|jsconfig|eslint|prettier|vite|vitest|webpack|rollup|babel|jest|biome)/i.test(base);
}

function isPackageFile(filePath: string): boolean {
  return /(^|\/)package\.json$/i.test(filePath);
}

function isLockFile(filePath: string): boolean {
  return /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i.test(filePath);
}

export function evaluateRules(input: ClassificationInput): RuleFinding[] {
  const filePath = toPosixPath(input.change.path);
  const findings = protectedChangeFindings(input);

  if (isEnvironmentOrSecret(filePath)) {
    findings.push(finding("RED", "environment-or-secret", `Le changement touche un fichier d'environnement ou un secret sensible.`));
  }

  if (isCi(filePath)) {
    const severity: Severity = categoryExpected(input, "ci") ? "ORANGE" : "RED";
    findings.push(finding(severity, "ci-cd", `Le changement touche la configuration CI/CD.`));
  }

  if (isMigration(filePath)) {
    const severity: Severity = categoryExpected(input, "migration") ? "ORANGE" : "RED";
    findings.push(finding(severity, "migration", `Une migration ou un schéma de base de données est à fort impact.`));
  }

  if (isAuthOrPermissions(filePath)) {
    const severity: Severity = categoryExpected(input, "auth") ? "ORANGE" : "RED";
    findings.push(finding(severity, "auth-or-permissions", `Le changement touche l'authentification ou les permissions.`));
  }

  if (isInfrastructure(filePath) || isProductionConfig(filePath)) {
    const severity: Severity = categoryExpected(input, "infrastructure") ? "ORANGE" : "RED";
    findings.push(finding(severity, "infrastructure", `Le changement touche l'infrastructure ou la production.`));
  }

  if (isPackageFile(filePath)) {
    const additions = addedDependencies(filePath, input.initialSnapshot, input.currentSnapshot);
    const task = taskText(input);
    const explicitlyAddsNamedPackage = /\b(add|install|integrate|use|ajouter|installer|intégrer|utiliser)\b/i.test(task)
      && additions.some((name) => task.includes(name.toLowerCase()));
    const expected = categoryExpected(input, "dependency") || explicitlyAddsNamedPackage;
    if (additions.length > 0) {
      findings.push(finding(expected ? "GREEN" : "ORANGE", "new-dependency", `Nouvelle${additions.length > 1 ? "s" : ""} dépendance${additions.length > 1 ? "s" : ""} : ${additions.join(", ")}.`));
    } else {
      findings.push(finding(expected ? "GREEN" : "ORANGE", "package-manifest", `Le manifeste package.json a été modifié.`));
    }
  } else if (isLockFile(filePath)) {
    findings.push(finding(categoryExpected(input, "dependency") ? "GREEN" : "ORANGE", "lockfile", `Un fichier de verrouillage de dépendances a été modifié.`));
  }

  if (isConfig(filePath) && !isCi(filePath) && !isInfrastructure(filePath)) {
    findings.push(finding(categoryExpected(input, "config") ? "GREEN" : "ORANGE", "configuration", `Le changement touche un fichier de configuration.`));
  }

  if (input.change.kind === "deleted") {
    findings.push(finding(categoryExpected(input, "deletion") ? "GREEN" : "ORANGE", "file-deleted", `Un fichier a été supprimé.`));
  }

  if (input.deletedFileCount >= 5) {
    findings.push(finding("RED", "mass-deletion", `${input.deletedFileCount} fichiers ont été supprimés dans cette session.`));
  }

  if (input.changedFileCount >= 20) {
    findings.push(finding("RED", "very-high-amplitude", `${input.changedFileCount} fichiers ont changé dans cette session.`));
  } else if (input.changedFileCount >= 8) {
    findings.push(finding("ORANGE", "high-amplitude", `${input.changedFileCount} fichiers ont changé dans cette session.`));
  }

  return findings;
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
      `Commande Git potentiellement destructive${protectedCount > 0 ? ` pour ${protectedCount} changement(s) préexistant(s)` : ""}. DriftLight observe sans bloquer.`,
    ));
  }
  if (destructiveFs) {
    findings.push(finding("RED", "destructive-file-command", `Commande de suppression détectée. DriftLight observe sans bloquer.`));
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall)\b/.test(normalized)) {
    findings.push(finding("ORANGE", "dependency-command", `Commande de gestion des dépendances détectée.`));
  }
  if (/\b(terraform|pulumi|kubectl|helm)\b/.test(normalized)) {
    findings.push(finding("RED", "infrastructure-command", `Commande d'infrastructure détectée.`));
  }

  return findings;
}

export function changeFromAbsolutePath(root: string, filePath: string, kind: ObservedChange["kind"]): ObservedChange | null {
  const relative = toPosixPath(path.relative(root, filePath));
  if (relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return { path: relative, kind };
}
