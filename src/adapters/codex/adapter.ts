import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdapterStatus, ScopeLightAdapter, ScopeLightEvent } from "../types.js";
import {
  buildCodexHookCommands,
  CODEX_ADAPTER_ID,
  CODEX_ADAPTER_VERSION,
  CODEX_HOOK_DEFINITIONS,
  countDriftLightCodexHandlers,
  type CodexHooksDocument,
  type CodexInstallState,
  mergeDriftLightCodexHooks,
  readJsonObject,
  removeDriftLightCodexHooks,
  writeJsonAtomic,
} from "./hook-config.js";
import { normalizeCodexEvent } from "./normalizer.js";
import {
  configureCodexNativeApprovals,
  hasCodexNativeApprovals,
  readTextFile,
  restoreCodexNativeApprovals,
  writeTextAtomic,
} from "./native-approvals.js";
import {
  codexAdapterStatePath,
  codexHooksPath,
  resolveCodexHome,
  type CodexPathOptions,
} from "./paths.js";
import { codexConfigPath, readCodexTrust } from "./trust-state.js";

export interface CodexAdapterOptions extends CodexPathOptions {
  nodeExecutable?: string;
  hookEntry?: string;
  now?: () => Date;
  detectCodex?: () => Promise<boolean>;
}

function commandAvailable(platform: NodeJS.Platform): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], {
      shell: platform === "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 1500);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function isInstallState(value: CodexHooksDocument | null): value is CodexInstallState & CodexHooksDocument {
  return value?.adapterId === CODEX_ADAPTER_ID && value.schemaVersion === 1;
}

function eventPresence(document: CodexHooksDocument): Record<string, boolean> {
  const hooks = document.hooks;
  const result: Record<string, boolean> = {};
  for (const definition of CODEX_HOOK_DEFINITIONS) {
    result[definition.event] = Boolean(hooks && Object.hasOwn(hooks, definition.event));
  }
  return result;
}

function hasOtherConfiguration(document: CodexHooksDocument): boolean {
  const copy = structuredClone(document);
  if (copy.hooks && Object.keys(copy.hooks).length === 0) delete copy.hooks;
  return Object.keys(copy).length > 0;
}

export class CodexAdapter implements ScopeLightAdapter {
  public readonly hooksPath: string;
  public readonly statePath: string;
  public readonly configPath: string;
  public readonly codexHome: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly detectOverride?: () => Promise<boolean>;
  private readonly nodeExecutable: string;
  private readonly hookEntry: string;
  private readonly pathOptions: CodexPathOptions;

  public constructor(options: CodexAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pathOptions = { platform: this.platform, homeDir: options.homeDir, env: options.env };
    this.codexHome = resolveCodexHome(this.pathOptions);
    this.hooksPath = codexHooksPath(this.pathOptions);
    this.statePath = codexAdapterStatePath(this.pathOptions);
    this.configPath = codexConfigPath(this.pathOptions);
    this.now = options.now ?? (() => new Date());
    this.detectOverride = options.detectCodex;
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.hookEntry = options.hookEntry ?? fileURLToPath(new URL("./hook-cli.js", import.meta.url));
  }

  public async detect(): Promise<boolean> {
    if (this.detectOverride) return await this.detectOverride();
    try {
      await fs.access(this.codexHome);
      return true;
    } catch {
      return await commandAvailable(this.platform);
    }
  }

  public normalize(nativeEvent: unknown): ScopeLightEvent[] {
    return normalizeCodexEvent(nativeEvent, this.now);
  }

  public async install(): Promise<void> {
    if (!await this.detect()) throw new Error("Codex n'a pas été détecté sur cette machine.");
    const explicitHome = this.pathOptions.env?.CODEX_HOME ?? process.env.CODEX_HOME;
    if (explicitHome) {
      try {
        await fs.access(this.codexHome);
      } catch {
        throw new Error("CODEX_HOME est défini mais le répertoire n'existe pas.");
      }
    } else {
      await fs.mkdir(this.codexHome, { recursive: true });
    }

    const existing = await readJsonObject(this.hooksPath);
    const previousStateValue = await readJsonObject(this.statePath);
    const previousState = isInstallState(previousStateValue) ? previousStateValue : null;
    const existingConfig = await readTextFile(this.configPath);
    const nativeApprovals = configureCodexNativeApprovals(
      existingConfig ?? "",
      this.configPath,
      existingConfig !== null,
      previousState?.nativeApprovals,
    );
    const withoutOurs = removeDriftLightCodexHooks(existing ?? {});
    const merged = mergeDriftLightCodexHooks(
      withoutOurs,
      buildCodexHookCommands(this.nodeExecutable, this.hookEntry, this.platform),
    );
    const installedAt = previousState?.installedAt ?? this.now().toISOString();
    const state: CodexInstallState = {
      schemaVersion: 1,
      adapterId: CODEX_ADAPTER_ID,
      adapterVersion: CODEX_ADAPTER_VERSION,
      hooksPath: this.hooksPath,
      installedAt,
      ...(previousState?.lastEventAt ? { lastEventAt: previousState.lastEventAt } : {}),
      hooksFileOriginallyPresent: previousState?.hooksFileOriginallyPresent ?? existing !== null,
      hooksObjectOriginallyPresent: previousState?.hooksObjectOriginallyPresent ?? existing?.hooks !== undefined,
      eventsOriginallyPresent: previousState?.eventsOriginallyPresent ?? eventPresence(withoutOurs),
      nativeApprovals: nativeApprovals.state,
    };
    if (nativeApprovals.changed) await writeTextAtomic(this.configPath, nativeApprovals.source);
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      await writeJsonAtomic(this.hooksPath, merged);
    }
    await writeJsonAtomic(this.statePath, state);
  }

  public async uninstall(): Promise<void> {
    const existing = await readJsonObject(this.hooksPath);
    const stateValue = await readJsonObject(this.statePath);
    const state = isInstallState(stateValue) ? stateValue : null;
    if (existing) {
      const cleaned = removeDriftLightCodexHooks(existing);
      if (cleaned.hooks) {
        for (const definition of CODEX_HOOK_DEFINITIONS) {
          const configured = cleaned.hooks[definition.event];
          const originallyPresent = state?.eventsOriginallyPresent[definition.event] ?? true;
          if (Array.isArray(configured) && configured.length === 0 && !originallyPresent) {
            delete cleaned.hooks[definition.event];
          }
        }
        if (Object.keys(cleaned.hooks).length === 0 && state && !state.hooksObjectOriginallyPresent) {
          delete cleaned.hooks;
        }
      }
      if (state && !state.hooksFileOriginallyPresent && !hasOtherConfiguration(cleaned)) {
        await fs.rm(this.hooksPath, { force: true });
      } else {
        await writeJsonAtomic(this.hooksPath, cleaned);
      }
    }
    if (state?.nativeApprovals) {
      const currentConfig = await readTextFile(this.configPath);
      if (currentConfig !== null) {
        const restored = restoreCodexNativeApprovals(currentConfig, state.nativeApprovals);
        if (restored.changed) {
          if (!state.nativeApprovals.configFileOriginallyPresent && restored.source.trim().length === 0) {
            await fs.rm(this.configPath, { force: true });
          } else {
            await writeTextAtomic(this.configPath, restored.source);
          }
        }
      }
    }
    await fs.rm(this.statePath, { force: true });
  }

  public async recordEventReceived(): Promise<void> {
    const stateValue = await readJsonObject(this.statePath);
    if (!isInstallState(stateValue)) return;
    await writeJsonAtomic(this.statePath, {
      ...stateValue,
      adapterVersion: CODEX_ADAPTER_VERSION,
      lastEventAt: this.now().toISOString(),
    });
  }

  public async healthCheck(): Promise<AdapterStatus> {
    const codexDetected = await this.detect();
    try {
      const document = await readJsonObject(this.hooksPath);
      const stateValue = await readJsonObject(this.statePath);
      const state = isInstallState(stateValue) ? stateValue : null;
      const count = document ? countDriftLightCodexHandlers(document) : 0;
      if (count === 0) {
        return {
          state: "NOT_INSTALLED",
          adapterVersion: CODEX_ADAPTER_VERSION,
          codexDetected,
          configPath: this.hooksPath,
        };
      }
      if (count !== CODEX_HOOK_DEFINITIONS.length || !state || !codexDetected) {
        return {
          state: "DEGRADED",
          adapterVersion: state?.adapterVersion ?? CODEX_ADAPTER_VERSION,
          codexDetected,
          ...(state?.lastEventAt ? { lastEventAt: state.lastEventAt } : {}),
          configPath: this.hooksPath,
          message: "La configuration DriftLight est partielle ou Codex n'est plus détecté.",
        };
      }
      const nativeConfig = await readTextFile(this.configPath);
      if (nativeConfig === null || !hasCodexNativeApprovals(nativeConfig)) {
        return {
          state: "DEGRADED",
          adapterVersion: state.adapterVersion,
          codexDetected,
          ...(state.lastEventAt ? { lastEventAt: state.lastEventAt } : {}),
          configPath: this.hooksPath,
          trustPath: this.configPath,
          message: "La politique d'approbation native Codex n'est pas active (approval_policy=untrusted, approvals_reviewer=user). Relancez codex connect ou conservez votre réglage personnalisé en sachant que Codex peut ne pas afficher Autoriser / Refuser.",
        };
      }
      // À partir d'ici la configuration DriftLight est complète : ce qui reste
      // se joue du côté de Codex, dans son état de confiance. On le lit plutôt
      // que d'imputer systématiquement le blocage à l'approbation.
      const trust = await readCodexTrust(this.hooksPath, this.pathOptions);
      const common = {
        adapterVersion: state.adapterVersion,
        codexDetected,
        configPath: this.hooksPath,
        trustPath: trust.configPath,
        hooks: trust.hooks.map(({ event, registered, enabled }) => ({ event, registered, enabled })),
        ...(state.lastEventAt ? { lastEventAt: state.lastEventAt } : {}),
      };

      // Configuration illisible : aucun jugement sur la confiance. Un événement
      // déjà reçu prouve directement que le hook s'exécute — cette preuve prime
      // sur une absence d'information.
      if (!trust.configPresent) {
        return state.lastEventAt
          ? { ...common, state: "CONNECTED", lastEventAt: state.lastEventAt }
          : {
            ...common,
            state: "INSTALLED_NEEDS_APPROVAL",
            blockingEvents: trust.unregisteredEvents,
            message: `Aucune configuration Codex lue à ${trust.configPath} : état de confiance inconnu. Ouvrez Codex → /hooks → approuvez DriftLight une fois.`,
          };
      }

      if (trust.unregisteredEvents.length === trust.hooks.length) {
        return {
          ...common,
          state: "INSTALLED_NEEDS_APPROVAL",
          blockingEvents: trust.unregisteredEvents,
          message: "Codex n'a encore enregistré aucun de ces hooks. Ouvrez Codex → /hooks → approuvez DriftLight une fois, puis démarrez une nouvelle session.",
        };
      }

      // La péremption prime sur un hook désactivé : elle invalide *toutes* les
      // empreintes, donc plus rien ne s'exécute. Signaler d'abord un blocage
      // partiel ferait corriger le symptôme mineur en laissant le majeur.
      if (trust.staleTrust) {
        const alsoDisabled = trust.disabledEvents.length > 0
          ? ` À réactiver dans la foulée, car également désactivé : ${trust.disabledEvents.join(", ")}.`
          : "";
        return {
          ...common,
          state: "TRUST_STALE",
          blockingEvents: trust.hooks.filter((hook) => hook.registered).map((hook) => hook.event),
          message: `hooks.json a été réécrit le ${trust.hooksModifiedAt}, après des empreintes de confiance datées du ${trust.trustRecordedAt} : Codex les tient pour périmées et n'exécute plus aucun hook. Réapprouvez une fois dans Codex → /hooks, sans relancer codex connect ensuite.${alsoDisabled}`,
        };
      }

      if (trust.disabledEvents.length > 0) {
        return {
          ...common,
          state: "HOOKS_DISABLED",
          blockingEvents: trust.disabledEvents,
          message: `Désactivé dans Codex : ${trust.disabledEvents.join(", ")}. Ouvrez Codex → /hooks et réactivez ${trust.disabledEvents.length > 1 ? "ces hooks" : "ce hook"}.`,
        };
      }

      if (trust.unregisteredEvents.length > 0) {
        return {
          ...common,
          state: "DEGRADED",
          blockingEvents: trust.unregisteredEvents,
          message: `Hooks inconnus de Codex : ${trust.unregisteredEvents.join(", ")}.`,
        };
      }

      if (!state.lastEventAt) {
        return {
          ...common,
          state: "INSTALLED_NEEDS_APPROVAL",
          message: "Hooks approuvés et actifs, mais aucun événement reçu. Démarrez une nouvelle session Codex : les hooks sont chargés à son ouverture.",
        };
      }

      return { ...common, state: "CONNECTED", lastEventAt: state.lastEventAt };
    } catch (error) {
      return {
        state: "DEGRADED",
        adapterVersion: CODEX_ADAPTER_VERSION,
        codexDetected,
        configPath: this.hooksPath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
