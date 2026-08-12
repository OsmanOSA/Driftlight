import path from "node:path";
import type { CurrentIntentState, SessionEvent } from "../domain/types.js";
import { redactSensitiveText } from "../shared/redact.js";

/**
 * Rédaction du texte affiché par le système.
 *
 * Une notification se lit en une seconde, de biais, pendant qu'on fait autre
 * chose. Elle doit répondre à trois questions dans cet ordre — quel projet,
 * quoi, et quoi faire — sans jamais exiger d'ouvrir un terminal pour être
 * comprise. Les identifiants de règles et les expressions régulières
 * appartiennent à `driftlight explain`, pas ici.
 */

/** Un titre de toast tient sur une ligne ; au-delà le système coupe. */
const PROJECT_BUDGET = 28;
const HEADLINE_BUDGET = 90;
const INTENT_BUDGET = 80;

interface RuleWording {
  /** Ce qui se passe, en français, sans identifiant technique. */
  headline: string;
  /** Ce que l'utilisateur peut faire, seulement quand il y a mieux à dire. */
  action?: string;
}

/**
 * Les règles dont le libellé mérite d'être écrit à la main. Les autres
 * retombent sur leur propre motif, qui reste lisible faute d'être parfait.
 */
const WORDING: Record<string, RuleWording> = {
  "sensitive-file": {
    headline: "Écriture dans un fichier de secrets",
    action: "Refusez si vous ne l'avez pas demandé.",
  },
  "preexisting-file-deleted": {
    headline: "Suppression d'un fichier contenant du travail non sauvegardé",
    action: "Refusez maintenant : ce contenu n'existe nulle part ailleurs.",
  },
  "preexisting-file-rewritten": {
    headline: "Réécriture d'un fichier contenant du travail non sauvegardé",
    action: "Refusez maintenant : ce contenu n'existe nulle part ailleurs.",
  },
  "destructive-git-command": {
    headline: "Commande Git destructrice",
    action: "Elle effacerait des modifications non commitées.",
  },
  "destructive-file-command": { headline: "Suppression récursive dans le dépôt" },
  "infrastructure-command": {
    headline: "Commande d'infrastructure",
    action: "Elle agit hors du dépôt, sur du réel.",
  },
  "dependency-command": { headline: "Installation d'une dépendance" },
  "dependency-added": { headline: "Ajout d'une dépendance au manifeste" },
  "destructive-edit": { headline: "Réécriture complète d'un fichier" },
  "write-without-read": { headline: "Écriture sur un fichier jamais lu" },
  "full-file-reformat": { headline: "Reformatage intégral d'un fichier" },
};

/** Coupe sur un mot plutôt qu'au milieu, et signale toujours la coupe. */
export function clip(value: string, budget: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= budget) return flat;
  const cut = flat.slice(0, budget - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Garde la fin d'un chemin, jamais son début : `.../src/api/handler.ts` situe,
 * `D:/work/clients/2026/…` ne dit rien.
 */
export function clipPath(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const segments = value.split("/");
  const kept: string[] = [];
  let length = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as string;
    if (kept.length > 0 && length + segment.length + 1 > budget - 2) break;
    kept.unshift(segment);
    length += segment.length + 1;
  }
  const tail = kept.join("/");
  return tail.length >= value.length ? clip(value, budget) : `…/${tail}`;
}

export function projectLabel(root: string): string {
  return clip(path.basename(root) || root, PROJECT_BUDGET);
}

/** Sujet lisible : chemin relatif au dépôt, ou commande expurgée. */
export function humanSubject(event: SessionEvent, root: string): string {
  if (event.path !== undefined) {
    const relative = path.isAbsolute(event.path) ? path.relative(root, event.path) : event.path;
    return clipPath(relative.replaceAll("\\", "/"), 60);
  }
  // Une commande peut porter un jeton en argument, et le centre de
  // notifications du système la conserve bien après la fin de la session.
  return event.detail === undefined ? "action" : clip(redactSensitiveText(event.detail), 70);
}

function wordingFor(event: SessionEvent): RuleWording {
  for (const code of [event.ruleId, ...event.codes]) {
    const known = WORDING[code];
    if (known) return known;
  }
  return { headline: clip(event.reasons[0] ?? "Action hors du périmètre annoncé", HEADLINE_BUDGET) };
}

export interface NotificationCopy {
  title: string;
  message: string;
}

/**
 * Le titre décrit ce que DriftLight a fait, et rien de plus.
 *
 * Il a longtemps annoncé « action bloquée ». C'était faux deux fois : DriftLight
 * renvoie une demande de confirmation, il n'interrompt rien lui-même, et il n'a
 * aucun moyen de savoir si l'agent hôte a honoré cette demande — un mode de
 * permission permissif peut la contourner sans le prévenir. Promettre un blocage
 * qu'on ne contrôle pas est la pire chose qu'un voyant puisse faire : elle
 * transforme une alerte en fausse sécurité.
 */
export type HookOutcome = "denied" | "asked" | "recorded";

export function notificationTitle(root: string, event: SessionEvent, outcome: HookOutcome): string {
  const verdict = outcome === "denied"
    // Seul cas où une promesse d'arrêt est tenable : `deny` ne se contourne pas.
    ? "action refusée"
    : outcome === "asked"
      ? "confirmation demandée"
      : event.level === "RED" ? "alerte rouge" : "à vérifier";
  return `DriftLight · ${projectLabel(root)} — ${verdict}`;
}

/**
 * Trois lignes au plus : le fait, la demande d'origine, la conduite à tenir.
 * La demande est ce qui permet de trancher d'un coup d'œil — sans elle,
 * l'utilisateur doit se souvenir de ce qu'il a écrit dix minutes plus tôt.
 */
export function notificationMessage(
  root: string,
  event: SessionEvent,
  intent: CurrentIntentState | null,
): string {
  const wording = wordingFor(event);
  const lines = [`${wording.headline} : ${humanSubject(event, root)}`];
  const requested = intent?.text?.trim();
  if (requested) lines.push(`Vous aviez demandé : « ${clip(requested, INTENT_BUDGET)} »`);
  if (wording.action) lines.push(wording.action);
  return lines.join("\n");
}
