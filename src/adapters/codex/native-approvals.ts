import { promises as fs } from "node:fs";
import path from "node:path";

export const CODEX_NATIVE_APPROVAL_POLICY = "untrusted";
export const CODEX_NATIVE_APPROVALS_REVIEWER = "user";

interface ManagedTomlSetting {
  managed: boolean;
  originallyPresent: boolean;
  originalLine?: string;
}

export interface CodexNativeApprovalInstallState {
  configPath: string;
  configFileOriginallyPresent: boolean;
  approvalPolicy: ManagedTomlSetting;
  approvalsReviewer: ManagedTomlSetting;
}

interface RootSetting {
  index: number;
  line: string;
  value: string;
}

interface ConfigureResult {
  source: string;
  state: CodexNativeApprovalInstallState;
  changed: boolean;
}

function newlineOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function linesOf(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function rootLimit(lines: string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index < 0 ? lines.length : index;
}

function findRootSetting(lines: string[], key: string): RootSetting | null {
  const expression = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  const limit = rootLimit(lines);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const match = expression.exec(line);
    if (match?.[1]) return { index, line, value: match[1] };
  }
  return null;
}

function simpleString(value: string): string | null {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const match = /^(?:"([^"\r\n]*)"|'([^'\r\n]*)')$/.exec(withoutComment);
  return match ? (match[1] ?? match[2] ?? "") : null;
}

function managedSetting(
  lines: string[],
  key: string,
  target: string,
  previous: ManagedTomlSetting | undefined,
): { state: ManagedTomlSetting; changed: boolean } {
  const current = findRootSetting(lines, key);
  const currentValue = current ? simpleString(current.value) : null;

  if (previous) {
    // Une modification postérieure appartient à l'utilisateur. Un second clic
    // sur Connect Codex ne doit pas reprendre la main sur son choix.
    if (previous.managed && currentValue === target) return { state: previous, changed: false };
    return { state: previous, changed: false };
  }

  if (current && currentValue === null) {
    throw new Error(`DriftLight ne peut pas modifier prudemment la valeur TOML complexe ${key}.`);
  }
  if (currentValue === target) {
    return {
      state: { managed: false, originallyPresent: true, originalLine: current?.line },
      changed: false,
    };
  }

  const replacement = `${key} = "${target}"`;
  if (current) {
    lines[current.index] = replacement;
    return {
      state: { managed: true, originallyPresent: true, originalLine: current.line },
      changed: true,
    };
  }

  lines.splice(rootLimit(lines), 0, replacement);
  return {
    state: { managed: true, originallyPresent: false },
    changed: true,
  };
}

function serialize(lines: string[], newline: string): string {
  return lines.length === 0 ? "" : `${lines.join(newline)}${newline}`;
}

export function configureCodexNativeApprovals(
  source: string,
  configPath: string,
  configFileOriginallyPresent: boolean,
  previous?: CodexNativeApprovalInstallState,
): ConfigureResult {
  const newline = newlineOf(source);
  const lines = linesOf(source);
  const approvalPolicy = managedSetting(
    lines,
    "approval_policy",
    CODEX_NATIVE_APPROVAL_POLICY,
    previous?.approvalPolicy,
  );
  const approvalsReviewer = managedSetting(
    lines,
    "approvals_reviewer",
    CODEX_NATIVE_APPROVALS_REVIEWER,
    previous?.approvalsReviewer,
  );
  return {
    source: serialize(lines, newline),
    state: previous ?? {
      configPath,
      configFileOriginallyPresent,
      approvalPolicy: approvalPolicy.state,
      approvalsReviewer: approvalsReviewer.state,
    },
    changed: approvalPolicy.changed || approvalsReviewer.changed,
  };
}

function restoreSetting(
  lines: string[],
  key: string,
  target: string,
  state: ManagedTomlSetting,
): boolean {
  if (!state.managed) return false;
  const current = findRootSetting(lines, key);
  // Ne jamais écraser une valeur que l'utilisateur a changée après Connect.
  if (!current || simpleString(current.value) !== target) return false;
  if (state.originallyPresent && state.originalLine !== undefined) {
    lines[current.index] = state.originalLine;
  } else {
    lines.splice(current.index, 1);
  }
  return true;
}

export function restoreCodexNativeApprovals(
  source: string,
  state: CodexNativeApprovalInstallState,
): { source: string; changed: boolean } {
  const newline = newlineOf(source);
  const lines = linesOf(source);
  const policyChanged = restoreSetting(
    lines,
    "approval_policy",
    CODEX_NATIVE_APPROVAL_POLICY,
    state.approvalPolicy,
  );
  const reviewerChanged = restoreSetting(
    lines,
    "approvals_reviewer",
    CODEX_NATIVE_APPROVALS_REVIEWER,
    state.approvalsReviewer,
  );
  return { source: serialize(lines, newline), changed: policyChanged || reviewerChanged };
}

export function hasCodexNativeApprovals(source: string): boolean {
  const lines = linesOf(source);
  return simpleString(findRootSetting(lines, "approval_policy")?.value ?? "") === CODEX_NATIVE_APPROVAL_POLICY
    && simpleString(findRootSetting(lines, "approvals_reviewer")?.value ?? "") === CODEX_NATIVE_APPROVALS_REVIEWER;
}

export async function readTextFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTextAtomic(target: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, source, "utf8");
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
