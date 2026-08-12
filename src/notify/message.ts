import path from "node:path";
import type { ChangeKind, CurrentIntentState, SessionEvent } from "../domain/types.js";
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
/** Le bloc en chasse fixe du panneau dispose de trois lignes, pas d'une. */
const EVIDENCE_BUDGET = 150;

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
 * Le refus ferme (`deny`) se distingue de la demande de confirmation, qu'un
 * mode de permission permissif écarte sans rien dire, et de l'alerte simplement
 * enregistrée, qui n'interrompt rien : leur attribuer le même verdict
 * transformerait le voyant en fausse sécurité.
 *
 * Mais le refus lui-même ne se raconte qu'au passé et à la première personne.
 * DriftLight sait ce qu'il a répondu ; il ne sait pas ce que son interlocuteur
 * en fera, et n'a aucun moyen de le vérifier. « Action bloquée » affirmait un
 * résultat constatable — or il suffit que le hook soit appelé par autre chose
 * qu'un agent obéissant pour que la phrase devienne fausse sous les yeux de qui
 * la lit. « Action refusée » n'affirme que le geste de DriftLight, qui est vrai
 * dans tous les cas.
 */
export type HookOutcome = "denied" | "asked" | "recorded";

export function notificationTitle(root: string, event: SessionEvent, outcome: HookOutcome): string {
  const verdict = outcome === "denied"
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

// --- Description structurée ---------------------------------------------------

/**
 * La même alerte, en champs séparés plutôt qu'en un bloc de texte.
 *
 * Un toast Windows ne sait afficher que des lignes ; le panneau, lui, dessine
 * une hiérarchie — verbe, énoncé, pièce à conviction en chasse fixe, suite
 * donnée. Découper ici plutôt que dans le rendu garde une seule source aux
 * mots : le panneau choisit la forme, jamais le vocabulaire.
 *
 * Tout champ vide se traduit par une rangée absente du panneau, pas par un
 * trou : rien n'est obligatoire hors `headline` et `status`.
 */
export interface NotificationDetail {
  /** Nature de l'action proposée, en un mot. */
  verb: string;
  /** Ce que DriftLight a vu, en clair. */
  headline: string;
  /** Le fichier ou la commande en cause, destiné à un rendu en chasse fixe. */
  evidence: string;
  /** Ce qui a pesé dans le verdict, en une ligne discrète. */
  meta: string;
  /** La demande d'origine, telle que l'utilisateur l'a écrite. */
  intent: string;
  /** La conduite à tenir, quand la règle a mieux à dire que l'évidence. */
  action: string;
  /** Ce que le hook a réellement obtenu de l'agent — jamais davantage. */
  status: string;
}

const CHANGE_VERBS: Record<ChangeKind, string> = {
  created: "Création",
  modified: "Modification",
  deleted: "Suppression",
};

function actionVerb(event: SessionEvent): string {
  if (event.path === undefined) return "Commande";
  return event.changeKind ? CHANGE_VERBS[event.changeKind] : "Écriture";
}

/**
 * Le sujet au format du bloc en chasse fixe : plus large que dans le texte
 * plat, où il doit cohabiter avec l'énoncé sur une seule ligne.
 */
export function evidenceText(event: SessionEvent, root: string): string {
  if (event.path !== undefined) {
    const relative = path.isAbsolute(event.path) ? path.relative(root, event.path) : event.path;
    return clipPath(relative.replaceAll("\\", "/"), 90);
  }
  // Comme dans humanSubject : une commande peut porter un jeton en argument.
  return event.detail === undefined ? "" : clip(redactSensitiveText(event.detail), EVIDENCE_BUDGET);
}

/**
 * Ce sur quoi le verdict s'appuie, compté et non nommé.
 *
 * Le nombre de familles concordantes est ce qui distingue un signal isolé d'un
 * faisceau, et c'est décidable d'un coup d'œil. Les identifiants qui les
 * composent appartiennent à `driftlight explain`.
 */
export function evidenceMeta(event: SessionEvent): string {
  const level = event.level === "RED" ? "Alerte rouge" : "À vérifier";
  const families = event.scoreBreakdown.activeSignalFamilies?.length ?? 0;
  if (families <= 1) return level;
  return `${level} · ${families} signaux concordants`;
}

/**
 * Ce que le hook a répondu, et où la décision se prend.
 *
 * Même prudence que `notificationTitle`, poussée d'un cran : la phrase ne doit
 * décrire ni un résultat ni un comportement futur, mais la réponse rendue.
 * « L'agent ne l'exécutera pas » prédisait la conduite d'un tiers ; il a suffi
 * d'un appel du hook hors d'une vraie session d'agent pour que la notification
 * annonce un arrêt pendant que le travail se poursuivait à l'écran.
 * « N'est pas autorisé à l'exécuter » énonce la permission refusée — aussi
 * ferme, et vrai que l'interlocuteur obéisse ou non.
 */
const OUTCOME_STATUS: Record<HookOutcome, string> = {
  denied: "Action refusée — l'agent n'est pas autorisé à l'exécuter",
  asked: "Confirmation demandée dans l'agent",
  recorded: "Alerte enregistrée — rien n'a été retenu",
};

export function notificationDetail(
  root: string,
  event: SessionEvent,
  intent: CurrentIntentState | null,
  outcome: HookOutcome,
): NotificationDetail {
  const wording = wordingFor(event);
  const requested = intent?.text?.trim();
  return {
    verb: actionVerb(event),
    headline: wording.headline,
    evidence: evidenceText(event, root),
    meta: evidenceMeta(event),
    intent: requested ? `« ${clip(requested, INTENT_BUDGET)} »` : "",
    action: wording.action ?? "",
    status: OUTCOME_STATUS[outcome],
  };
}
