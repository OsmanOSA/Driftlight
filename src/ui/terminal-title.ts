import type { CurrentStatus, DriftLightConfig, Severity } from "../domain/types.js";
import { readCurrentStatusSync } from "../status/current-status.js";

/**
 * Titre du terminal, visible dans la barre des tâches même quand le terminal est
 * en arrière-plan.
 *
 * Deux chemins, parce que les contraintes diffèrent :
 *
 *  - En mode hook, le processus n'a pas de terminal de contrôle. La
 *    documentation Claude Code est explicite : ne pas écrire dans `/dev/tty`,
 *    mais renvoyer la séquence dans le champ `terminalSequence`, que Claude Code
 *    émet lui-même. Ce champ n'accepte que les OSC 0/1/2/9/99/777 et BEL ; la
 *    moindre séquence hors allowlist fait ignorer le champ entier. La pile de
 *    titres XTerm (CSI 22/23 t) en est donc exclue.
 *
 *  - En mode CLI (`driftlight start`), le processus possède son terminal : on
 *    écrit directement sur stdout, et la pile de titres redevient utilisable
 *    pour restaurer le titre exact d'avant la session.
 */

/** OSC 0 : ESC ] 0 ; titre BEL — met à jour titre de fenêtre et d'onglet. */
const OSC_SET_TITLE_PREFIX = "\u001b]0;";
const BEL = "\u0007";
/** XTerm XTWINOPS : empile (22) puis dépile (23) le titre. Réservé au mode CLI. */
const PUSH_TITLE = "\u001b[22;0t";
const POP_TITLE = "\u001b[23;0t";

const SYMBOL: Record<Severity, string> = { GREEN: "🟢", ORANGE: "🟠", RED: "🔴" };

const MAX_TITLE_LENGTH = 120;

export interface TitleSink {
  write(data: string): void;
  close(): void;
}

/** Titre neutre rendu au vert et en fin de session. */
export function defaultTerminalTitle(root: string): string {
  const segments = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || "DriftLight";
}

function sanitize(title: string): string {
  // Un caractère de contrôle refermerait la séquence OSC par surprise.
  return title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

export function setTitleSequence(title: string): string {
  return `${OSC_SET_TITLE_PREFIX}${sanitize(title)}${BEL}`;
}

/**
 * Reproduit l'allowlist de Claude Code : uniquement OSC 0/1/2/9/99/777 terminés
 * par BEL ou ST, et rien d'autre. Garde-fou testable — une séquence refusée
 * serait silencieusement ignorée, donc invisible en production.
 */
export function isTerminalSequenceAllowed(sequence: string): boolean {
  const allowed = /\u001b\](?:0|1|2|9|99|777);[^\u001b\u0007]*(?:\u0007|\u001b\\)/g;
  return sequence.replace(allowed, "").length === 0;
}

/**
 * "🔴 DriftLight — 1 alerte" / "🟠 DriftLight — 3 alertes" / titre neutre au vert.
 * Le pictogramme reflète la sévérité la plus haute, le compte agrège orange et rouge.
 */
export function buildTerminalTitle(status: CurrentStatus, fallback: string): string {
  const alerts = status.counts.ORANGE + status.counts.RED;
  if (status.level === "GREEN" || alerts === 0) return fallback;
  return `${SYMBOL[status.level]} DriftLight — ${alerts} ${alerts === 1 ? "alerte" : "alertes"}`;
}

/** Séquence reflétant le statut courant, à renvoyer dans `terminalSequence`. */
export function terminalTitleSequence(root: string, config: DriftLightConfig): string | undefined {
  if (!config.terminalTitle) return undefined;
  try {
    return setTitleSequence(buildTerminalTitle(readCurrentStatusSync(root), defaultTerminalTitle(root)));
  } catch {
    return undefined;
  }
}

/**
 * Séquence de restauration en fin de session.
 *
 * Le mode hook ne peut pas dépiler le titre d'origine — CSI hors allowlist — il
 * rend donc explicitement le titre neutre du dépôt.
 */
export function restoreTitleSequence(root: string, config: DriftLightConfig): string | undefined {
  if (!config.terminalTitle) return undefined;
  return setTitleSequence(defaultTerminalTitle(root));
}

/** Sortie directe, réservée au mode CLI où le processus possède son terminal. */
export function openTitleSink(): TitleSink | null {
  if (process.env.TERM === "dumb") return null;
  if (!process.stdout.isTTY) return null;
  return { write: (data) => void process.stdout.write(data), close: () => {} };
}

function emit(config: DriftLightConfig, data: string | undefined, sink?: TitleSink | null): void {
  if (!config.terminalTitle || !data) return;
  const target = sink === undefined ? openTitleSink() : sink;
  if (!target) return;
  try {
    target.write(data);
  } finally {
    if (sink === undefined) target.close();
  }
}

/** Mode CLI : mémorise le titre courant pour le restaurer à l'arrêt. */
export function pushTerminalTitle(config: DriftLightConfig, sink?: TitleSink | null): void {
  emit(config, PUSH_TITLE, sink);
}

/** Mode CLI : reflète le statut DriftLight courant. */
export function applyTerminalTitle(root: string, config: DriftLightConfig, sink?: TitleSink | null): void {
  emit(config, terminalTitleSequence(root, config), sink);
}

/**
 * Mode CLI : restaure le titre d'origine.
 *
 * Les deux séquences sont émises dans cet ordre à dessein : les terminaux qui
 * ignorent la pile de titres s'arrêtent sur le titre neutre, ceux qui la gèrent
 * retrouvent le titre exact d'avant la session en dépilant en dernier.
 */
export function restoreTerminalTitle(root: string, config: DriftLightConfig, sink?: TitleSink | null): void {
  const neutral = restoreTitleSequence(root, config);
  if (!neutral) return;
  emit(config, `${neutral}${POP_TITLE}`, sink);
}
