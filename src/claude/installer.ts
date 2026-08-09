import { promises as fs } from "node:fs";
import path from "node:path";

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

const HOOK_DEFINITIONS: Array<{ event: string; matcher?: string; timeout?: number }> = [
  { event: "SessionStart", matcher: "startup|resume|clear" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "Bash|PowerShell|Edit|Write|NotebookEdit" },
  { event: "PostToolUse", matcher: "Bash|PowerShell|Edit|Write|NotebookEdit" },
  { event: "PostToolUse", matcher: "Read" },
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
}

export async function installClaudeHooks(options: InstallClaudeHooksOptions): Promise<string> {
  const settingsPath = path.join(path.resolve(options.cwd), ".claude", "settings.local.json");
  let settings: Settings = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (!isObject(parsed)) throw new Error("La configuration Claude Code doit être un objet JSON.");
    settings = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const cliEntry = path.resolve(options.cliEntry ?? process.argv[1] ?? "dist/src/cli.js");
  const handler: HookHandler = {
    type: "command",
    command: options.nodeExecutable ?? process.execPath,
    args: [cliEntry, "hook"],
    timeout: 10,
    statusMessage: "DriftLight observe localement…",
  };

  mergeClaudeHookSettings(settings, handler);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await fs.rename(temporary, settingsPath);
  return settingsPath;
}
