import { existsSync } from "node:fs";
import path from "node:path";
import { claudeSettingsPath, isInstalledPackage } from "../claude/installer.js";
import { loadScoringConfigSync } from "../config/scoring-config.js";
import { resolveObservableRoot } from "../git/baseline.js";
import { identityStatus } from "../notify/identity.js";
import { readJsonState } from "../shared/read-state.js";
import { driftlightHome } from "../shared/state-paths.js";
import { listProjects, projectsDirectory } from "./projects.js";

export type CheckStatus = "ok" | "warn" | "info";

export interface Check {
  status: CheckStatus;
  label: string;
  detail: string;
  /** Ce qu'il faut faire, quand quelque chose mérite d'être fait. */
  remedy?: string;
}

async function hooksInstalled(settingsPath: string): Promise<boolean> {
  const settings = await readJsonState<{ hooks?: Record<string, unknown> }>(settingsPath);
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => {
    const hooks = (group as { hooks?: unknown[] })?.hooks;
    return Array.isArray(hooks) && hooks.some((hook) =>
      JSON.stringify((hook as { args?: unknown })?.args ?? "").includes("hook"));
  });
}

export async function diagnose(cwd: string): Promise<Check[]> {
  const checks: Check[] = [];
  const home = driftlightHome();

  const root = await resolveObservableRoot(cwd);
  checks.push(root
    ? { status: "ok", label: "Dépôt observé", detail: root }
    : {
        status: "info",
        label: "Dépôt observé",
        detail: `${cwd} n'est pas un dépôt Git`,
        remedy: "DriftLight reste volontairement silencieux hors dépôt Git.",
      });

  const globalSettings = claudeSettingsPath({ cwd, global: true });
  const localSettings = claudeSettingsPath({ cwd, global: false });
  const [globalOk, localOk] = await Promise.all([
    hooksInstalled(globalSettings),
    hooksInstalled(localSettings),
  ]);
  checks.push(globalOk || localOk
    ? {
        status: "ok",
        label: "Hooks Claude Code",
        detail: globalOk ? `machine entière (${globalSettings})` : `ce dépôt seulement (${localSettings})`,
      }
    : {
        status: "warn",
        label: "Hooks Claude Code",
        detail: "aucun hook DriftLight détecté",
        remedy: "driftlight claude install --global",
      });

  const entry = process.argv[1] ?? "";
  checks.push(isInstalledPackage(entry)
    ? { status: "ok", label: "Binaire", detail: "paquet installé, désigné par son nom" }
    : {
        status: "warn",
        label: "Binaire",
        detail: `copie de développement : ${path.resolve(entry)}`,
        remedy: "npm install -g . — sinon reconstruire modifie le comportement de toutes les sessions ouvertes",
      });

  try {
    const scoring = loadScoringConfigSync(root ?? cwd);
    checks.push({ status: "ok", label: "Configuration de score", detail: `version ${scoring.version}` });
  } catch (error) {
    checks.push({
      status: "warn",
      label: "Configuration de score",
      detail: error instanceof Error ? error.message : String(error),
      remedy: "Restaurez driftlight.scoring.json depuis le paquet.",
    });
  }

  const projects = await listProjects();
  const vanished = projects.filter((project) => !project.present);
  const bytes = projects.reduce((total, project) => total + project.bytes, 0);
  checks.push({
    status: "ok",
    label: "État local",
    detail: `${projects.length} projet(s), ${(bytes / 1024 / 1024).toFixed(1)} Mo sous ${projectsDirectory()}`,
  });
  if (vanished.length > 0) {
    checks.push({
      status: "warn",
      label: "Projets disparus",
      detail: `${vanished.length} dossier(s) d'état sans dépôt correspondant`,
      remedy: "driftlight projects --purge",
    });
  }

  const degraded = projects.filter((project) => project.degraded !== null);
  checks.push(degraded.length === 0
    ? { status: "ok", label: "Santé des hooks", detail: "aucune dégradation enregistrée" }
    : {
        status: "warn",
        label: "Santé des hooks",
        // Le fail-open est silencieux par construction : sans cette ligne, une
        // panne répétée resterait invisible indéfiniment.
        detail: degraded.map((project) => `${path.basename(project.directory)} : ${project.degraded}`).join(", "),
        remedy: "DRIFTLIGHT_DEBUG=1 pour voir la cause au prochain déclenchement.",
      });

  const identity = identityStatus();
  if (identity.supported) {
    checks.push(identity.installed
      ? { status: "ok", label: "Identité de notification", detail: identity.appId }
      : {
          status: "info",
          label: "Identité de notification",
          detail: "empruntée à la bibliothèque d'envoi ; l'en-tête n'affiche pas DriftLight",
          remedy: "driftlight notify install — écrit un raccourci retirable dans le menu Démarrer.",
        });
  } else if (process.platform === "darwin") {
    // La persistance d'une notification macOS est un réglage par application,
    // que rien dans la charge utile ne peut imposer. Le dire vaut mieux que de
    // laisser croire que l'outil peut la garantir.
    checks.push({
      status: "info",
      label: "Notifications macOS",
      detail: "la durée d'affichage dépend du style choisi dans les réglages du système",
      remedy: "Réglages › Notifications › (application d'envoi) › style « Alertes » pour qu'elles persistent.",
    });
  }

  checks.push({
    status: existsSync(path.join(home, "config.json")) ? "ok" : "info",
    label: "Préférences machine",
    detail: existsSync(path.join(home, "config.json"))
      ? path.join(home, "config.json")
      : "aucune ; les défauts du produit s'appliquent",
  });

  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const mark: Record<CheckStatus, string> = { ok: "✓", warn: "!", info: "·" };
  const lines = checks.map((check) => {
    const head = `  ${mark[check.status]} ${check.label.padEnd(24)} ${check.detail}`;
    return check.remedy ? `${head}\n      → ${check.remedy}` : head;
  });
  return `DriftLight · diagnostic\n${lines.join("\n")}`;
}
