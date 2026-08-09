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

export function formatSignal(event: SessionEvent): string | null {
  if (event.level === "GREEN") return null;
  const subject = event.path ?? event.detail ?? "DriftLight";
  const reason = event.reasons[0] ?? LABEL[event.level];
  return `${SYMBOL[event.level]} ${LABEL[event.level]} — ${subject}\n   ${reason}`;
}

export function formatStopSummary(
  events: SessionEvent[],
  turnId: string,
  suppressedNotifications = 0,
): string | null {
  const alerts = events.filter(
    (event) => event.turnId === turnId && event.level !== "GREEN" && event.type !== "lifecycle",
  );
  if (alerts.length === 0) return null;
  const lines = ["DriftLight · alertes de ce tour"];
  for (const event of alerts) {
    const subject = event.path ?? event.detail ?? "action";
    const ruleId = event.ruleId ?? event.codes[0] ?? "unknown-rule";
    lines.push(`${SYMBOL[event.level]} ${event.level} · ${subject} · ${ruleId} · ${event.id}`);
  }
  if (suppressedNotifications > 0) {
    // Les alertes restent journalisées : seul l'envoi système a été plafonné.
    lines.push(
      `🔕 ${suppressedNotifications} notification(s) tue(s) par le plafond de session · toutes les alertes restent listées ci-dessus.`,
    );
  }
  return lines.join("\n");
}

export function formatSessionSummary(session: SessionRecord): string {
  const baseline = session.baseline;
  const branch = baseline.isGit
    ? `${baseline.branch ?? "HEAD détachée"} @ ${baseline.commit?.slice(0, 8) ?? "sans commit"}`
    : "hors dépôt Git";
  const task = session.intents[0]?.text ?? "En attente de la demande utilisateur";
  const currentIntent = session.currentIntent?.text
    ?? [...session.intents].reverse().find((intent) => intent.source !== "manual-scope")?.text;
  const alerts = session.events.filter((event) => event.level !== "GREEN" && event.type !== "lifecycle");
  const useful = alerts.filter((event) => event.feedback === "useful").length;
  const noise = alerts.filter((event) => event.feedback === "noise").length;
  const unreviewed = alerts.length - useful - noise;
  const lines = [
    `DriftLight · ${session.id}`,
    `Tâche : ${task}`,
    ...(currentIntent && currentIntent !== task ? [`Tour courant : ${currentIntent}`] : []),
    `Baseline : ${branch} · ${baseline.files.length} changement(s) préexistant(s) protégé(s)`,
    `Alertes : ${alerts.length} · utiles ${useful} · bruit ${noise} · à qualifier ${unreviewed}`,
  ];
  for (const event of alerts) {
    const marker = event.expected ? "✓" : SYMBOL[event.level];
    const feedback = event.feedback ? ` · ${event.feedback === "useful" ? "utile" : "bruit"}` : "";
    lines.push(`${marker} ${event.path ?? event.detail ?? event.type} — ${event.reasons[0] ?? LABEL[event.level]}${feedback} [${event.id}]`);
  }
  if (alerts.length === 0) lines.push("Aucune alerte orange ou rouge.");
  return lines.join("\n");
}

function rawValueText(value: SessionEvent["scoreBreakdown"]["signals"][number]["rawValue"]): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

const STAGE_LABEL: Record<string, string> = {
  absolute: "étage 0 · règle absolue",
  exempt: "étage 1 · exemption",
  behavior: "étage 2 · signaux de comportement",
  shadow: "étage 3 · shadowScore promu",
};

function formatShadowScore(breakdown: SessionEvent["shadowScore"], promoted = false): string[] {
  if (!breakdown) return [];
  const lines = [
    "",
    "── Étage 3 · observation seulement ─────────────────────────",
    promoted
      ? "Ces signaux ont été promus par shadowSignalsCanAlert."
      : "Ces signaux n'ont pas pesé sur le verdict ci-dessus.",
  ];
  if (breakdown.mode !== "scored") {
    lines.push("Score structurel non calculé pour cet événement.");
    return lines;
  }
  lines.push(breakdown.score === null
    ? "shadowScore indisponible : aucun signal restant à renormaliser."
    : `Aurait dit : ${breakdown.verdict} · score ${breakdown.score}/${breakdown.thresholds.red} pour le rouge`);
  for (const signal of breakdown.signals) {
    lines.push(signal.available
      ? `- ${signal.id} · brut ${rawValueText(signal.rawValue)} · poids ${signal.weight} · contribution ${signal.contribution}`
      : `- ${signal.id} · INDISPONIBLE · retiré du calcul · ${signal.explanation}`);
  }
  if (breakdown.unavailableSignals.length > 0) {
    lines.push(`Renormalisation ×${breakdown.normalizationFactor} sur les signaux restants.`);
  }
  return lines;
}

export function formatScoreExplanation(event: SessionEvent): string {
  const breakdown = event.scoreBreakdown;
  const subject = event.path ?? event.detail ?? "action";
  const lines = [
    `DriftLight explain · ${event.id}`,
    `${event.level} · ${subject} · ${event.ruleId}`,
    ...(event.stage ? [`Décidé par : ${STAGE_LABEL[event.stage] ?? event.stage}`] : []),
    ...(event.exemptedBy ? [`Exempté par : ${event.exemptedBy}`] : []),
  ];
  if (!breakdown) {
    lines.push("Décomposition indisponible pour cet ancien événement.");
    return [...lines, ...formatShadowScore(event.shadowScore, event.stage === "shadow")].join("\n");
  }
  if (breakdown.mode === "absolute") {
    lines.push(`Verdict hors score : ${breakdown.absoluteRuleId ?? event.ruleId}`);
    for (const reason of event.reasons) lines.push(reason);
    return [...lines, ...formatShadowScore(event.shadowScore, event.stage === "shadow")].join("\n");
  }
  if (breakdown.mode === "rules") {
    lines.push(
      `Verdict effectif par table de règles : ${breakdown.verdict}`
      + (breakdown.decisionRuleId ? ` · décision ${breakdown.decisionRuleId}` : ""),
    );
    if (breakdown.activeSignalFamilies && breakdown.activeSignalFamilies.length > 0) {
      lines.push(`Familles actives : ${breakdown.activeSignalFamilies.join(", ")}`);
    }
    for (const signal of breakdown.signals) {
      const family = signal.family ? ` · famille ${signal.family}` : "";
      lines.push(!signal.available
        ? `- ${signal.id}${family} · INDISPONIBLE · poids ${signal.weight} · contribution 0 · ${signal.explanation}`
        : `- ${signal.id}${family} · brut ${rawValueText(signal.rawValue)} · sévérité ${signal.severity ?? "GREEN"} · poids ${signal.weight} · contribution ${signal.contribution} · ${signal.triggered ? "DÉCLENCHÉ" : "non déclenché"}`);
    }
    return [...lines, ...formatShadowScore(event.shadowScore, event.stage === "shadow")].join("\n");
  }
  lines.push(
    `Score : ${breakdown.score} (avant bornage ${breakdown.unclampedScore}) · seuils orange ${breakdown.thresholds.orange}, rouge ${breakdown.thresholds.red}`,
    `Configuration : ${breakdown.configVersion} · renormalisation ×${breakdown.normalizationFactor}`,
  );
  for (const signal of breakdown.signals) {
    if (!signal.available) {
      lines.push(`- ${signal.id} · indisponible · poids ${signal.weight} · contribution 0 · ${signal.explanation}`);
      continue;
    }
    lines.push(`- ${signal.id} · brut ${rawValueText(signal.rawValue)} · poids ${signal.weight} · contribution ${signal.contribution} · ${signal.explanation}`);
  }
  if (breakdown.unavailableSignals.length > 0) {
    lines.push(`Indisponibles : ${breakdown.unavailableSignals.join(", ")}`);
  }
  return [...lines, ...formatShadowScore(event.shadowScore, event.stage === "shadow")].join("\n");
}
