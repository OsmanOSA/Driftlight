import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../shared/atomic-write.js";
import { CLAUDE_READ_TOOLS } from "../intent/agent-context.js";

interface HookHandler {
  type: "command";
  command: string;
  args: string[];
  timeout: number;
  statusMessage: string;
}

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

/**
 * Dérivé de la liste des outils de lecture du Core. Un outil que le Core sait
 * interpréter mais que Claude Code ne livre jamais produit un faux
 * `write-without-read` : les deux listes doivent rester solidaires.
 */
export const READ_TOOL_MATCHER = CLAUDE_READ_TOOLS.join("|");

const HOOK_DEFINITIONS: Array<{ event: string; matcher?: string; timeout?: number }> = [
  { event: "SessionStart", matcher: "startup|resume|clear" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "Bash|PowerShell|Edit|Write|NotebookEdit" },
  { event: "PostToolUse", matcher: "Bash|PowerShell|Edit|Write|NotebookEdit" },
  { event: "PostToolUse", matcher: READ_TOOL_MATCHER },
  { event: "FileChanged", matcher: ".env|package.json|package-lock.json|pnpm-lock.yaml|yarn.lock" },
  { event: "Stop" },
  { event: "SessionEnd", timeout: 5 },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookGroup(value: unknown): value is HookGroup {
  return isObject(value) && Array.isArray(value.hooks);
}

function sameHandler(value: unknown, handler: HookHandler): boolean {
  if (!isObject(value)) return false;
  return value.type === handler.type
    && value.command === handler.command
    && JSON.stringify(value.args) === JSON.stringify(handler.args);
}

export function mergeClaudeHookSettings(settings: Settings, handler: HookHandler): Settings {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new Error("La clé hooks existante doit être un objet ; aucun fichier n'a été modifié.");
  }
  const hooks = settings.hooks ?? {};

  for (const definition of HOOK_DEFINITIONS) {
    const configuredEvent = hooks[definition.event];
    if (configuredEvent !== undefined && !Array.isArray(configuredEvent)) {
      throw new Error(`La configuration existante de ${definition.event} n'est pas un tableau ; aucun fichier n'a été modifié.`);
    }
    const existing = configuredEvent ?? [];
    const matchingGroup = existing.find(
      (item): item is HookGroup => isHookGroup(item) && item.matcher === definition.matcher,
    );
    const eventHandler = { ...handler, timeout: definition.timeout ?? handler.timeout };

    if (matchingGroup) {
      if (!matchingGroup.hooks.some((item) => sameHandler(item, eventHandler))) {
        matchingGroup.hooks.push(eventHandler);
      }
    } else {
      existing.push({
        ...(definition.matcher ? { matcher: definition.matcher } : {}),
        hooks: [eventHandler],
      });
    }
    hooks[definition.event] = existing;
  }

  settings.hooks = hooks;
  return settings;
}

export interface InstallClaudeHooksOptions {
  cwd: string;
  nodeExecutable?: string;
  cliEntry?: string;
  /**
   * Installe les hooks au niveau de l'utilisateur plutôt que du dépôt. Claude
   * Code les applique alors à tout projet ouvert sur la machine : ouvrir un
   * nouveau dépôt suffit à être observé, sans installation par projet.
   */
  global?: boolean;
}

/**
 * Un paquet installé expose la commande `driftlight` : les réglages la
 * désignent par son nom, et survivent aux mises à jour comme aux déplacements.
 *
 * Depuis une copie de développement il n'existe pas de nom stable, et les
 * réglages doivent figer un chemin absolu vers `dist/`. Ce chemin est fragile
 * de deux façons : déplacer la copie casse les hooks, et surtout reconstruire
 * change le comportement de *toutes* les sessions ouvertes sur la machine,
 * puisqu'elles pointent toutes vers le même `dist/`.
 */
export function isInstalledPackage(cliEntry: string): boolean {
  return path.resolve(cliEntry).split(/[\\/]/).includes("node_modules");
}

export function resolveInvocation(
  cliEntry: string,
  nodeExecutable?: string,
): { command: string; args: string[] } {
  return isInstalledPackage(cliEntry)
    ? { command: "driftlight", args: ["hook"] }
    : { command: nodeExecutable ?? process.execPath, args: [path.resolve(cliEntry), "hook"] };
}

/** Réglages utilisateur de Claude Code, appliqués à tous les projets. */
export function claudeSettingsPath(options: { cwd: string; global?: boolean; homeDir?: string }): string {
  return options.global
    ? path.join(options.homeDir ?? os.homedir(), ".claude", "settings.json")
    : path.join(path.resolve(options.cwd), ".claude", "settings.local.json");
}

export async function installClaudeHooks(options: InstallClaudeHooksOptions): Promise<string> {
  const settingsPath = claudeSettingsPath(options);
  let settings: Settings = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (!isObject(parsed)) throw new Error("La configuration Claude Code doit être un objet JSON.");
    settings = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const cliEntry = path.resolve(options.cliEntry ?? process.argv[1] ?? "dist/src/cli.js");
  const invocation = resolveInvocation(cliEntry, options.nodeExecutable);
  const handler: HookHandler = {
    ...invocation,
    type: "command",
    timeout: 10,
    statusMessage: "DriftLight observe localement…",
  };

  mergeClaudeHookSettings(settings, handler);
  await writeJsonAtomic(settingsPath, settings);
  return settingsPath;
}
