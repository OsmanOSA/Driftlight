import type { Classification, ClassificationInput, Classifier, ScoreBreakdown } from "../domain/types.js";
import { loadConfigSync } from "../config/config.js";
import { loadScoringConfigSync } from "../config/scoring-config.js";
import { readCurrentIntentSync } from "../intent/current-intent.js";
import { readImportGraphSync } from "../profile/import-graph.js";
import { readRepoProfileSync } from "../profile/repo-profile.js";
import { absoluteScoreBreakdown, scoreClassification } from "./scoring-engine.js";
import {
  behaviorScoreBreakdown,
  combineBehaviorFindings,
  evaluateBehaviorSignals,
} from "./behavior-signals.js";
import { evaluateExemptions } from "./exemptions.js";
import { evaluatePreexistingProtection, highestSeverity } from "./rules.js";

/** Classifieur v2 en étages stricts, documenté dans docs/classification-v2.md. */
export class DeterministicClassifier implements Classifier {
  public readonly name = "deterministic-local-v2";

  public classify(input: ClassificationInput): Classification {
    const intent = readCurrentIntentSync(input.root);
    const config = loadConfigSync(input.root);
    const scoringConfig = loadScoringConfigSync(input.root);
    const cachedProfile = readRepoProfileSync(input.root);
    const profile = cachedProfile && cachedProfile.sourceCommit === input.baseline.commit
      ? cachedProfile
      : null;
    const graph = readImportGraphSync(input.root);
    const identity = intent ? { intentVersion: intent.version, turnId: intent.turnId } : {};

    const readPathsInSession = [...new Set(input.agentReads.map((read) => read.path))];
    const readPathsThisTurn = [...new Set(
      input.agentReads.filter((read) => read.turnId === intent?.turnId).map((read) => read.path),
    )];

    // L'étage 3 accompagne tous les événements à des fins de mesure. Il ne
    // participe au verdict que si sa promotion est explicitement activée.
    const shadowScore: ScoreBreakdown = scoreClassification(
      input,
      intent,
      profile,
      graph,
      scoringConfig,
    );

    // Étage 0 — aucune exemption ne s'applique.
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
      const ruleId = relevant[0]?.code ?? "preexisting-protection";
      return {
        level,
        reasons: [...new Set(relevant.map((item) => item.reason))],
        codes: [...new Set(relevant.map((item) => item.code))],
        ruleId,
        scoreBreakdown: absoluteScoreBreakdown(scoringConfig, level, ruleId),
        stage: "absolute",
        shadowScore,
        ...identity,
      };
    }

    // Étage 1 — exemptions bornées et journalisées.
    const exemption = evaluateExemptions(input, {
      intent,
      profile,
      scoringConfig,
      readPathsThisTurn,
      declaredPlanPaths: input.declaredPlanPaths ?? [],
      createdPathsThisTurn: input.createdPathsThisTurn ?? [],
      largeLineDeletionThreshold: config.largeLineDeletionThreshold,
    });
    if (exemption) {
      return {
        level: "GREEN",
        reasons: [exemption.reason],
        codes: [exemption.id],
        ruleId: exemption.id,
        scoreBreakdown: absoluteScoreBreakdown(scoringConfig, "GREEN", exemption.id),
        stage: "exempt",
        exemptedBy: exemption.id,
        shadowScore,
        ...identity,
      };
    }

    // Étage 2 — seuls faits observables autorisés à alerter par défaut.
    const findings = evaluateBehaviorSignals(
      input,
      { profile, readPathsInSession, largeLineDeletionThreshold: config.largeLineDeletionThreshold },
      scoringConfig,
    );
    const behaviorLevel = combineBehaviorFindings(findings, scoringConfig);
    const activeFindings = findings.filter((finding) => finding.available !== false && finding.triggered !== false);

    // Promotion future de l'étage 3 : elle peut augmenter, jamais diminuer.
    const order: Record<Classification["level"], number> = { GREEN: 0, ORANGE: 1, RED: 2 };
    const shadowPromoted = config.shadowSignalsCanAlert
      && order[shadowScore.verdict] > order[behaviorLevel];
    const level = shadowPromoted ? shadowScore.verdict : behaviorLevel;
    const ruleId = shadowPromoted
      ? "shadow-score"
      : activeFindings[0]?.id ?? "no-behavior-signal";

    return {
      level,
      reasons: shadowPromoted
        ? [`shadowScore promu par configuration : ${shadowScore.score}/${scoringConfig.maximumScore}.`]
        : activeFindings.length > 0
          ? activeFindings.map((finding) => finding.reason)
          : ["Aucun signal de comportement déclenché."],
      codes: shadowPromoted ? ["shadow-score"] : activeFindings.map((finding) => finding.id),
      ruleId,
      scoreBreakdown: shadowPromoted
        ? shadowScore
        : behaviorScoreBreakdown(findings, behaviorLevel, scoringConfig),
      stage: shadowPromoted ? "shadow" : "behavior",
      shadowScore,
      ...identity,
    };
  }
}
