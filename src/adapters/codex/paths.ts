import os from "node:os";
import path from "node:path";

export interface CodexPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveCodexHome(options: CodexPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const configured = options.env?.CODEX_HOME ?? process.env.CODEX_HOME;
  if (configured) return api.resolve(configured);
  return api.join(options.homeDir ?? os.homedir(), ".codex");
}

export function codexHooksPath(options: CodexPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  return pathApi(platform).join(resolveCodexHome(options), "hooks.json");
}

export function codexAdapterStatePath(options: CodexPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  return pathApi(platform).join(resolveCodexHome(options), "driftlight-codex.json");
}
