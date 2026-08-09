import type { Classification, ClassificationInput, Classifier } from "../domain/types.js";
import { loadConfigSync } from "../config/config.js";
import { loadScoringConfigSync } from "../config/scoring-config.js";
import { readCurrentIntentSync } from "../intent/current-intent.js";
import { readImportGraphSync } from "../profile/import-graph.js";
import { readRepoProfileSync } from "../profile/repo-profile.js";
import { absoluteScoreBreakdown, scoreClassification } from "./scoring-engine.js";
import { evaluatePreexistingProtection, highestSeverity } from "./rules.js";

export class DeterministicClassifier implements Classifier {
  public readonly name = "deterministic-local-v1";

  public classify(input: ClassificationInput): Classification {
    const intent = readCurrentIntentSync(input.root);
    const config = loadConfigSync(input.root);
    const scoringConfig = loadScoringConfigSync(input.root);
    const readPathsInSession = [...new Set(input.agentReads.map((read) => read.path))];
    const readPathsThisTurn = [...new Set(
      input.agentReads.filter((read) => read.turnId === intent?.turnId).map((read) => read.path),
    )];
    const protectionFindings = evaluatePreexistingProtection({
      ...input,
      task: intent?.text ?? "",
      scopeAdditions: intent?.scopeAdditions ?? [],
      readPathsThisTurn,
      readPathsInSession,
      largeLineDeletionThreshold: config.largeLineDeletionThreshold,
    });
    if (protectionFindings.length > 0) {
      const level = highestSeverity(protectionFindings);
      const relevant = protectionFindings.filter((item) => item.severity === level);
      return {
        level,
        reasons: [...new Set(relevant.map((item) => item.reason))],
        codes: [...new Set(relevant.map((item) => item.code))],
        ruleId: relevant[0]?.code ?? "preexisting-protection",
        scoreBreakdown: absoluteScoreBreakdown(scoringConfig, level, relevant[0]?.code ?? "preexisting-protection"),
        ...(intent ? { intentVersion: intent.version, turnId: intent.turnId } : {}),
      };
    }

    const breakdown = scoreClassification(
      input,
      intent,
      readRepoProfileSync(input.root),
      readImportGraphSync(input.root),
      scoringConfig,
    );
    const strongestSignals = breakdown.signals
      .filter((signal) => signal.contribution > 0)
      .sort((left, right) => right.contribution - left.contribution)
      .slice(0, 3)
      .map((signal) => `${signal.id} +${signal.contribution}`);
    return {
      level: breakdown.verdict,
      reasons: [`Score cumulé ${breakdown.score}/${scoringConfig.maximumScore}${strongestSignals.length > 0 ? ` : ${strongestSignals.join(", ")}` : ""}.`],
      codes: ["cumulative-score"],
      ruleId: "cumulative-score",
      scoreBreakdown: breakdown,
      ...(intent ? { intentVersion: intent.version, turnId: intent.turnId } : {}),
    };
  }
}
