#!/usr/bin/env node
/**
 * Banc de calibration : rejoue la table de décision de l'étage 2 sur les
 * sessions déjà enregistrées.
 *
 * Les verdicts historiques ne sont pas recalculés depuis zéro — les entrées
 * complètes du classifieur ne sont pas persistées. En revanche chaque événement
 * conserve, dans `scoreBreakdown.signals`, les signaux réellement déclenchés
 * avec leur sévérité. C'est exactement ce que consomme `evaluateBehaviorDecision`,
 * donc l'effet d'un changement de `decisionTable` se mesure exactement.
 *
 *   node scripts/replay-corpus.mjs [--dir .driftlight/sessions]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { evaluateBehaviorDecision } from "../dist/src/classification/behavior-signals.js";
import { loadScoringConfigSync } from "../dist/src/config/scoring-config.js";
import { projectStatePath } from "../dist/src/shared/state-paths.js";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const directory = path.resolve(argument("--dir", projectStatePath(process.cwd(), "sessions")));
const config = loadScoringConfigSync(process.cwd());

/**
 * Configuration historique : aucune famille n'était seulement corroborante,
 * donc une preuve de procédé isolée suffisait à allumer l'orange.
 */
const previousConfig = {
  ...config,
  behavior: { ...config.behavior, corroboratingFamilies: [] },
};

/**
 * Les événements anciens n'ont pas de champ `family` : il est retrouvé depuis la
 * configuration courante, comme le fait `familyFor` à l'exécution.
 */
function findingsFrom(event) {
  const signals = event.scoreBreakdown?.signals;
  if (!Array.isArray(signals) || signals.length === 0) return null;
  return signals.map((signal) => ({
    id: signal.id,
    severity: signal.severity ?? config.behavior.severities[signal.id] ?? "GREEN",
    reason: signal.explanation ?? "",
    available: signal.available !== false,
    triggered: signal.triggered === true,
  }));
}

const tally = { total: 0, before: {}, after: {} };
const changed = new Map();
const stillAlerting = new Map();

for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
  let session;
  try {
    session = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
  } catch {
    continue;
  }
  for (const event of session.events ?? []) {
    // Étage 2 seulement : les verdicts absolus et les exemptions ne dépendent
    // pas de la table de décision et doivent rester hors de la mesure.
    if (event.stage !== "behavior") continue;
    const findings = findingsFrom(event);
    if (!findings) continue;

    const before = evaluateBehaviorDecision(findings, previousConfig);
    const after = evaluateBehaviorDecision(findings, config);
    tally.total += 1;
    tally.before[before.verdict] = (tally.before[before.verdict] ?? 0) + 1;
    tally.after[after.verdict] = (tally.after[after.verdict] ?? 0) + 1;

    const active = findings.filter((finding) => finding.available && finding.triggered).map((f) => f.id);
    if (before.verdict !== after.verdict) {
      const key = `${before.verdict} → ${after.verdict}  [${active.join(" + ") || "aucun"}]`;
      changed.set(key, (changed.get(key) ?? 0) + 1);
    } else if (after.verdict !== "GREEN") {
      const key = `${after.verdict}  [${active.join(" + ")}]`;
      stillAlerting.set(key, (stillAlerting.get(key) ?? 0) + 1);
    }
  }
}

const rate = (counts) => {
  const alerts = (counts.ORANGE ?? 0) + (counts.RED ?? 0);
  return tally.total ? `${((alerts / tally.total) * 100).toFixed(1)}%` : "n/a";
};
const line = (label, counts) =>
  `${label.padEnd(9)} GREEN ${String(counts.GREEN ?? 0).padStart(4)}   ` +
  `ORANGE ${String(counts.ORANGE ?? 0).padStart(4)}   RED ${String(counts.RED ?? 0).padStart(3)}` +
  `   → taux d'alerte ${rate(counts)}`;

const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

console.log(`Corpus : ${tally.total} événements d'étage 2 dans ${directory}\n`);
console.log(line("avant", tally.before));
console.log(line("après", tally.after));

if (changed.size > 0) {
  console.log("\n--- verdicts modifiés ---");
  for (const [key, count] of sorted(changed)) console.log(String(count).padStart(5), key);
}
if (stillAlerting.size > 0) {
  console.log("\n--- alertes conservées ---");
  for (const [key, count] of sorted(stillAlerting)) console.log(String(count).padStart(5), key);
}
