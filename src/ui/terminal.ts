import type { SessionEvent, SessionRecord, Severity } from "../domain/types.js";

const SYMBOL: Record<Severity, string> = {
  GREEN: "🟢",
  ORANGE: "🟠",
  RED: "🔴",
};

const LABEL: Record<Severity, string> = {
  GREEN: "Dans le scope",
  ORANGE: "Dérive possible",
  RED: "Changement inattendu",
};

export function formatSignal(event: SessionEvent): string {
  const subject = event.path ?? event.detail ?? "DriftLight";
  const reason = event.reasons[0] ?? LABEL[event.level];
  return `${SYMBOL[event.level]} ${LABEL[event.level]} — ${subject}\n   ${reason}`;
}

export function formatHookSignal(events: SessionEvent[]): string | null {
  const alerts = events.filter((event) => event.level !== "GREEN");
  const event = alerts.find((item) => item.level === "RED") ?? alerts[0];
  if (!event) return null;
  const subject = event.path ?? event.detail ?? "action";
  return `${SYMBOL[event.level]} DriftLight · ${subject} · ${event.reasons[0] ?? LABEL[event.level]}`;
}

export function formatSessionSummary(session: SessionRecord): string {
  const baseline = session.baseline;
  const branch = baseline.isGit
    ? `${baseline.branch ?? "HEAD détachée"} @ ${baseline.commit?.slice(0, 8) ?? "sans commit"}`
    : "hors dépôt Git";
  const task = session.intents[0]?.text ?? "En attente de la demande utilisateur";
  const lines = [
    `DriftLight · ${session.id}`,
    `Tâche : ${task}`,
    `Baseline : ${branch} · ${baseline.files.length} changement(s) préexistant(s) protégé(s)`,
    `Événements : ${session.events.length}`,
  ];
  for (const event of session.events) {
    const marker = event.expected ? "✓" : SYMBOL[event.level];
    lines.push(`${marker} ${event.path ?? event.detail ?? event.type} — ${event.reasons[0] ?? LABEL[event.level]} [${event.id}]`);
  }
  return lines.join("\n");
}
