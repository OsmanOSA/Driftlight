import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodexNativeApprovalInstallState } from "./native-approvals.js";

export const CODEX_ADAPTER_ID = "driftlight-codex-v1";
export const CODEX_ADAPTER_VERSION = "1.0.0";
export const CODEX_STATUS_MESSAGE = "DriftLight observes locally";

export const CODEX_HOOK_DEFINITIONS: ReadonlyArray<{ event: string; matcher?: string; timeout: number }> = [
  { event: "SessionStart", matcher: "*", timeout: 3 },
  { event: "SessionEnd", matcher: "other", timeout: 3 },
  { event: "UserPromptSubmit", timeout: 3 },
  { event: "PreToolUse", matcher: "*", timeout: 3 },
  { event: "PostToolUse", matcher: "*", timeout: 3 },
  { event: "SubagentStart", matcher: "*", timeout: 3 },
  { event: "SubagentStop", matcher: "*", timeout: 3 },
  { event: "Stop", timeout: 3 },
];

export interface CodexHookCommands {
  command: string;
  commandWindows: string;
}

interface CommandHandler extends Record<string, unknown> {
  type: "command";
  command: string;
  commandWindows: string;
  timeout: number;
  statusMessage: string;
}

interface HookGroup extends Record<string, unknown> {
  matcher?: string;
  hooks: unknown[];
}

export type CodexHooksDocument = Record<string, unknown> & { hooks?: Record<string, unknown> };

export interface CodexInstallState {
  schemaVersion: 1;
  adapterId: typeof CODEX_ADAPTER_ID;
  adapterVersion: string;
  hooksPath: string;
  installedAt: string;
  lastEventAt?: string;
  hooksFileOriginallyPresent: boolean;
  hooksObjectOriginallyPresent: boolean;
  eventsOriginallyPresent: Record<string, boolean>;
  nativeApprovals?: CodexNativeApprovalInstallState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookGroup(value: unknown): value is HookGroup {
  return isRecord(value) && Array.isArray(value.hooks);
}

export function isDriftLightCodexHandler(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.statusMessage === CODEX_STATUS_MESSAGE
    || (typeof value.command === "string" && value.command.includes(CODEX_ADAPTER_ID))
    || (typeof value.commandWindows === "string" && value.commandWindows.includes(CODEX_ADAPTER_ID));
}

function cloneDocument(document: CodexHooksDocument): CodexHooksDocument {
  return structuredClone(document);
}

function validatedHooks(document: CodexHooksDocument): Record<string, unknown> {
  if (document.hooks === undefined) return {};
  if (!isRecord(document.hooks)) {
    throw new Error("La clé hooks de ~/.codex/hooks.json doit être un objet JSON.");
  }
  return document.hooks;
}

export function removeDriftLightCodexHooks(document: CodexHooksDocument): CodexHooksDocument {
  const result = cloneDocument(document);
  const hooks = validatedHooks(result);

  for (const [event, configured] of Object.entries(hooks)) {
    if (!Array.isArray(configured)) continue;
    const groups: unknown[] = [];
    for (const item of configured) {
      if (!hookGroup(item)) {
        groups.push(item);
        continue;
      }
      const remaining = item.hooks.filter((handler) => !isDriftLightCodexHandler(handler));
      if (remaining.length === 0 && item.hooks.some(isDriftLightCodexHandler)) continue;
      groups.push({ ...item, hooks: remaining });
    }
    hooks[event] = groups;
  }

  if (result.hooks !== undefined) result.hooks = hooks;
  return result;
}

export function mergeDriftLightCodexHooks(
  document: CodexHooksDocument,
  commands: CodexHookCommands,
): CodexHooksDocument {
  const result = removeDriftLightCodexHooks(document);
  const hooks = validatedHooks(result);

  for (const definition of CODEX_HOOK_DEFINITIONS) {
    const existing = hooks[definition.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`La configuration Codex ${definition.event} doit être un tableau.`);
    }
    const handler: CommandHandler = {
      type: "command",
      command: commands.command,
      commandWindows: commands.commandWindows,
      timeout: definition.timeout,
      statusMessage: CODEX_STATUS_MESSAGE,
    };
    const group: HookGroup = {
      ...(definition.matcher ? { matcher: definition.matcher } : {}),
      hooks: [handler],
    };
    hooks[definition.event] = [...(existing ?? []), group];
  }

  result.hooks = hooks;
  return result;
}

export function countDriftLightCodexHandlers(document: CodexHooksDocument): number {
  const hooks = validatedHooks(document);
  let count = 0;
  for (const configured of Object.values(hooks)) {
    if (!Array.isArray(configured)) continue;
    for (const group of configured) {
      if (!hookGroup(group)) continue;
      count += group.hooks.filter(isDriftLightCodexHandler).length;
    }
  }
  return count;
}

export async function readJsonObject(target: string): Promise<CodexHooksDocument | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(target, "utf8"));
    if (!isRecord(parsed)) throw new Error(`${target} doit contenir un objet JSON.`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}


export function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Citation compatible CommandLineToArgvW pour les chemins Windows, espaces inclus. */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    quoted += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodedWindowsHookCommand(nodeExecutable: string, hookEntry: string): string {
  // Codex transmet la commande Ã  `cmd.exe /d /s /c`. Des guillemets dans cet
  // argument sont rÃ©Ã©chappÃ©s par le lanceur Windows, puis interprÃ©tÃ©s comme des
  // caractÃ¨res littÃ©raux par cmd.exe. Un EncodedCommand ne contient aucun
  // guillemet et conserve exactement les chemins, mÃªme avec des espaces.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `& ${quotePowerShellLiteral(nodeExecutable)} ${quotePowerShellLiteral(hookEntry)} '--adapter-id' ${quotePowerShellLiteral(CODEX_ADAPTER_ID)}`,
    // Le wrapper est lui aussi fail-open : une panne DriftLight ne casse pas Codex.
    "exit 0",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * Construit la commande du hook pour la plateforme d'installation.
 *
 * `command` doit être exécutable *sur la machine où le fichier est écrit* :
 * Codex 0.147 sous Windows exécute ce champ et ignore `commandWindows`. Écrire
 * de la syntaxe POSIX dans `command` en comptant sur `commandWindows` faisait
 * échouer le hook avant même le démarrage de Node — sans message, sans trace,
 * sans entrée de journal côté Codex.
 *
 * `commandWindows` reste renseigné : inoffensif là où il est ignoré, correct
 * là où il serait honoré.
 */
export function buildCodexHookCommands(
  nodeExecutable: string,
  hookEntry: string,
  platform: NodeJS.Platform = process.platform,
): CodexHookCommands {
  const marker = `--adapter-id ${CODEX_ADAPTER_ID}`;
  const windows = encodedWindowsHookCommand(nodeExecutable, hookEntry);
  const posix = `${quotePosixArgument(nodeExecutable)} ${quotePosixArgument(hookEntry)} ${marker}`;
  return {
    command: platform === "win32" ? windows : posix,
    commandWindows: windows,
  };
}

export { writeJsonAtomic } from "../../shared/atomic-write.js";
