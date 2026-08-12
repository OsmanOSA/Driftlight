import path from "node:path";
import type { ScopeLightEvent, ScopeLightEventType } from "../types.js";
import {
  extractDeclaredPlanPaths,
  extractRepoPaths,
  isPlanTool,
  isReadLikeTool,
} from "../../intent/agent-context.js";
import { redactSensitiveText } from "../../shared/redact.js";

interface NativeHookEvent extends Record<string, unknown> {
  session_id: string;
  cwd: string;
  hook_event_name: string;
}

interface PatchFile {
  path: string;
  changeKind: "created" | "modified" | "deleted" | "renamed";
  /**
   * Lignes retirées et ajoutées par le patch. Codex n'annonce pas de « type
   * d'opération » comme le fait un outil d'édition typé : l'ampleur réelle du
   * changement n'existe que dans le corps du patch. Sans ces compteurs, une
   * réécriture intégrale est indiscernable d'une correction d'une ligne, et
   * toute la protection contre la destruction devient inopérante sous Codex.
   */
  removedLineCount: number;
  addedLineCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Minimise les secrets évidents avant la remise locale au Core. */
export { redactSensitiveText };

function nativeMetadata(input: NativeHookEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    hookEventName: input.hook_event_name,
    model: string(input.model),
    permissionMode: string(input.permission_mode),
    turnId: string(input.turn_id),
    toolName: string(input.tool_name),
    toolUseId: string(input.tool_use_id),
    source: string(input.source),
    reason: string(input.reason),
    agentId: string(input.agent_id),
    agentType: string(input.agent_type),
  }).filter((entry) => entry[1] !== undefined));
}

function normalizePatchPath(workspace: string, value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (!path.isAbsolute(trimmed)) return trimmed.replaceAll("\\", "/");
  const relative = path.relative(workspace, trimmed);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replaceAll("\\", "/");
  }
  return trimmed.replaceAll("\\", "/");
}

/** Extrait uniquement les en-têtes structurels documentés d'apply_patch. */
export function extractApplyPatchFiles(workspace: string, command: string): PatchFile[] {
  const files: PatchFile[] = [];
  const seen = new Set<string>();
  let lastUpdatedPath: string | undefined;

  let current: PatchFile | undefined;

  for (const line of command.split(/\r?\n/)) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (match) {
      const operation = match[1];
      const rawPath = match[2];
      if (!operation || !rawPath) continue;
      const filePath = normalizePatchPath(workspace, rawPath);
      const changeKind = operation === "Add" ? "created" : operation === "Delete" ? "deleted" : "modified";
      const key = `${changeKind}:${filePath}`;
      const existing = files.find((file) => file.path === filePath && file.changeKind === changeKind);
      if (!seen.has(key)) {
        current = { path: filePath, changeKind, removedLineCount: 0, addedLineCount: 0 };
        files.push(current);
        seen.add(key);
      } else {
        current = existing;
      }
      lastUpdatedPath = operation === "Update" ? filePath : undefined;
      continue;
    }

    if (current && !line.startsWith("***") && !line.startsWith("@@")) {
      // Les marqueurs `---` et `+++` d'un en-tête unifié ne sont pas du contenu.
      if (line.startsWith("-") && !line.startsWith("---")) current.removedLineCount += 1;
      else if (line.startsWith("+") && !line.startsWith("+++")) current.addedLineCount += 1;
    }

    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move?.[1] && lastUpdatedPath) {
      const destination = normalizePatchPath(workspace, move[1]);
      const existing = files.find((file) => file.path === lastUpdatedPath && file.changeKind === "modified");
      if (existing) existing.changeKind = "renamed";
      const key = `renamed:${destination}`;
      if (!seen.has(key)) {
        files.push({ path: destination, changeKind: "renamed", removedLineCount: 0, addedLineCount: 0 });
        seen.add(key);
      }
    }
  }
  return files;
}

function validNativeEvent(value: unknown): NativeHookEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.session_id !== "string" || typeof value.cwd !== "string" || typeof value.hook_event_name !== "string") {
    return null;
  }
  return value as NativeHookEvent;
}

function responseSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { kind: Array.isArray(value) ? "array" : typeof value };
  return {
    kind: "object",
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
  };
}

function normalizedToolFilePath(workspace: string, toolInput: Record<string, unknown>): string | undefined {
  const filePath = string(toolInput.file_path) ?? string(toolInput.path);
  return filePath === undefined ? undefined : normalizePatchPath(workspace, filePath);
}

export function normalizeCodexEvent(nativeEvent: unknown, now = (): Date => new Date()): ScopeLightEvent[] {
  const input = validNativeEvent(nativeEvent);
  if (!input) return [];
  const metadata = nativeMetadata(input);
  const base = (event: ScopeLightEventType, payload: Record<string, unknown>): ScopeLightEvent => ({
    protocol_version: 1,
    agent: "codex",
    session_id: input.session_id,
    workspace: input.cwd,
    timestamp: now().toISOString(),
    event,
    payload,
  });

  switch (input.hook_event_name) {
    case "SessionStart":
      return [base("SESSION_STARTED", { source: string(input.source) ?? "unknown", native: metadata })];
    case "SessionEnd":
      return [base("SESSION_ENDED", { reason: string(input.reason) ?? "other", native: metadata })];
    case "UserPromptSubmit": {
      const prompt = string(input.prompt);
      return prompt === undefined ? [] : [base("USER_PROMPT", { prompt: redactSensitiveText(prompt), native: metadata })];
    }
    case "PermissionRequest":
    case "PreToolUse": {
      const toolName = string(input.tool_name);
      if (!toolName) return [];
      const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
      const toolUseId = string(input.tool_use_id);
      const filePath = normalizedToolFilePath(input.cwd, toolInput);
      const events = [base("TOOL_PROPOSED", {
        toolName,
        ...(toolUseId ? { toolUseId } : {}),
        ...(filePath ? { filePath } : {}),
        inputKeys: Object.keys(toolInput).sort(),
        native: metadata,
      })];
      const command = string(toolInput.command);
      if (["Bash", "PowerShell", "shell_command"].includes(toolName) && command !== undefined) {
        events.push(base("COMMAND_PROPOSED", {
          command: redactSensitiveText(command),
          ...(toolUseId ? { toolUseId } : {}),
          native: metadata,
        }));
      }
      if (toolName === "apply_patch" && command !== undefined) {
        for (const file of extractApplyPatchFiles(input.cwd, command)) {
          events.push(base("FILE_EDITED", {
            ...file,
            phase: "proposed",
            ...(toolUseId ? { toolUseId } : {}),
            native: metadata,
          }));
        }
      }
      if (isPlanTool(toolName)) {
        events.push(base("PLAN_DECLARED", {
          paths: extractDeclaredPlanPaths(input.cwd, toolInput),
          ...(toolUseId ? { toolUseId } : {}),
          native: metadata,
        }));
      }
      return events;
    }
    case "PostToolUse": {
      const toolName = string(input.tool_name);
      if (!toolName) return [];
      const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
      const toolUseId = string(input.tool_use_id);
      const filePath = normalizedToolFilePath(input.cwd, toolInput);
      const events = [base("TOOL_COMPLETED", {
        toolName,
        ...(toolUseId ? { toolUseId } : {}),
        ...(filePath ? { filePath } : {}),
        response: responseSummary(input.tool_response),
        ...(isReadLikeTool(toolName)
          ? { readFiles: [...new Set([
              ...extractRepoPaths(input.cwd, toolInput),
              ...extractRepoPaths(input.cwd, input.tool_response),
            ])] }
          : {}),
        native: metadata,
      })];
      const command = string(toolInput.command);
      if (toolName === "apply_patch" && command !== undefined) {
        for (const file of extractApplyPatchFiles(input.cwd, command)) {
          events.push(base("FILE_EDITED", {
            ...file,
            phase: "completed",
            ...(toolUseId ? { toolUseId } : {}),
            native: metadata,
          }));
        }
      }
      return events;
    }
    case "SubagentStart":
      return [base("SUBAGENT_STARTED", {
        agentId: string(input.agent_id) ?? "unknown",
        agentType: string(input.agent_type) ?? "unknown",
        native: metadata,
      })];
    case "SubagentStop":
      return [base("SUBAGENT_STOPPED", {
        agentId: string(input.agent_id) ?? "unknown",
        agentType: string(input.agent_type) ?? "unknown",
        stopHookActive: boolean(input.stop_hook_active) ?? false,
        hadAssistantMessage: typeof input.last_assistant_message === "string",
        native: metadata,
      })];
    case "Stop":
      return [base("AGENT_STOPPED", {
        stopHookActive: boolean(input.stop_hook_active) ?? false,
        hadAssistantMessage: typeof input.last_assistant_message === "string",
        native: metadata,
      })];
    default:
      return [];
  }
}
