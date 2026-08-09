import { promises as fs } from "node:fs";
import path from "node:path";
import { CODEX_HOOK_DEFINITIONS } from "./hook-config.js";
import { resolveCodexHome, type CodexPathOptions } from "./paths.js";

/**
 * Lecture de l'état de confiance que Codex tient dans son `config.toml`.
 *
 * Codex n'exécute un hook qu'après approbation explicite de l'utilisateur, et
 * garde le résultat sous `[hooks.state.'<fichier>:<event>:<i>:<j>']`, avec une
 * empreinte du contenu approuvé et, le cas échéant, `enabled = false`.
 *
 * DriftLight ne peut pas — et ne doit pas — écrire là-dedans : c'est le
 * consentement de l'utilisateur. Il peut en revanche le lire, pour dire ce qui
 * bloque réellement au lieu d'accuser l'approbation à chaque fois.
 */

export interface CodexHookTrust {
  /** Nom tel que DriftLight l'écrit dans hooks.json. */
  event: string;
  /** Nom tel que Codex l'indexe dans config.toml. */
  stateKey: string;
  /** Codex a vu ce hook et lui a créé une entrée d'état. */
  registered: boolean;
  /** Faux uniquement lorsque Codex a écrit `enabled = false`. */
  enabled: boolean;
  trustedHash?: string;
}

export interface CodexTrustReport {
  configPath: string;
  configPresent: boolean;
  hooks: CodexHookTrust[];
  /** Hooks connus de Codex mais explicitement désactivés. */
  disabledEvents: string[];
  /** Hooks jamais vus par Codex. */
  unregisteredEvents: string[];
  /**
   * `hooks.json` a été réécrit après l'enregistrement des empreintes.
   *
   * L'empreinte exacte de Codex n'est pas recalculable ici sans deviner sa forme
   * canonique ; l'ordre des dates de modification est le signal honnête
   * disponible, et il suffit à expliquer une approbation qui ne « tient » pas.
   */
  staleTrust: boolean;
  hooksModifiedAt?: string;
  trustRecordedAt?: string;
}

export function codexConfigPath(options: CodexPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(resolveCodexHome(options), "config.toml");
}

/** `PreToolUse` → `pre_tool_use`, la convention d'indexation de Codex. */
export function toCodexStateKey(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

interface TomlSection {
  header: string;
  values: Map<string, string>;
}

/**
 * Extraction ciblée des sections `[hooks.state...]`.
 *
 * Volontairement pas un analyseur TOML complet : on ne lit que des en-têtes de
 * section et des paires `clé = valeur` scalaires, ce qui suffit ici et évite
 * d'ajouter une dépendance pour parcourir la configuration globale de Codex.
 */
function parseSections(source: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      current = { header: line.slice(1, -1), values: new Map() };
      sections.push(current);
      continue;
    }

    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    current.values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  return sections;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "'" || first === '"') && last === first ? trimmed.slice(1, -1) : trimmed;
}

/** Un en-tête vaut pour nous s'il désigne l'état d'un hook de ce fichier. */
function stateKeyFromHeader(header: string, hooksPath: string): string | null {
  const prefix = "hooks.state.";
  if (!header.startsWith(prefix)) return null;
  const entry = unquote(header.slice(prefix.length));
  const separator = entry.lastIndexOf(`${hooksPath}:`);
  if (separator !== 0) return null;
  // Reste : `<event>:<index>:<index>`.
  return entry.slice(hooksPath.length + 1).split(":")[0] ?? null;
}

async function modifiedAt(target: string): Promise<Date | null> {
  try {
    return (await fs.stat(target)).mtime;
  } catch {
    return null;
  }
}

export async function readCodexTrust(
  hooksPath: string,
  options: CodexPathOptions = {},
): Promise<CodexTrustReport> {
  const configPath = codexConfigPath(options);
  let source: string | null = null;
  try {
    source = await fs.readFile(configPath, "utf8");
  } catch {
    source = null;
  }

  const byStateKey = new Map<string, { enabled: boolean; trustedHash?: string }>();
  if (source) {
    for (const section of parseSections(source)) {
      const stateKey = stateKeyFromHeader(section.header, hooksPath);
      if (!stateKey) continue;
      const enabledValue = section.values.get("enabled");
      const hash = section.values.get("trusted_hash");
      byStateKey.set(stateKey, {
        // Codex n'écrit `enabled` que pour désactiver : son absence vaut actif.
        enabled: enabledValue === undefined ? true : unquote(enabledValue) !== "false",
        ...(hash ? { trustedHash: unquote(hash) } : {}),
      });
    }
  }

  const hooks: CodexHookTrust[] = CODEX_HOOK_DEFINITIONS.map((definition) => {
    const stateKey = toCodexStateKey(definition.event);
    const entry = byStateKey.get(stateKey);
    return {
      event: definition.event,
      stateKey,
      registered: entry !== undefined,
      enabled: entry?.enabled ?? false,
      ...(entry?.trustedHash ? { trustedHash: entry.trustedHash } : {}),
    };
  });

  const [hooksModified, configModified] = await Promise.all([
    modifiedAt(hooksPath),
    modifiedAt(configPath),
  ]);
  const anyRegistered = hooks.some((hook) => hook.registered);

  return {
    configPath,
    configPresent: source !== null,
    hooks,
    disabledEvents: hooks.filter((hook) => hook.registered && !hook.enabled).map((hook) => hook.event),
    unregisteredEvents: hooks.filter((hook) => !hook.registered).map((hook) => hook.event),
    staleTrust: anyRegistered
      && hooksModified !== null
      && configModified !== null
      && hooksModified.getTime() > configModified.getTime(),
    ...(hooksModified ? { hooksModifiedAt: hooksModified.toISOString() } : {}),
    ...(configModified ? { trustRecordedAt: configModified.toISOString() } : {}),
  };
}
