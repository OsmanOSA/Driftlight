import type { Classification, ClassificationInput, Classifier } from "../domain/types.js";
import { evaluateRules, highestSeverity } from "./rules.js";

export class DeterministicClassifier implements Classifier {
  public readonly name = "deterministic-local-v1";

  public classify(input: ClassificationInput): Classification {
    const findings = evaluateRules(input);
    if (findings.length === 0) {
      return {
        level: "GREEN",
        reasons: ["Aucune règle locale sensible n'a été déclenchée."],
        codes: ["within-scope"],
      };
    }

    const level = highestSeverity(findings);
    const relevant = findings.filter((item) => item.severity === level);
    return {
      level,
      reasons: [...new Set(relevant.map((item) => item.reason))],
      codes: [...new Set(relevant.map((item) => item.code))],
    };
  }
}
