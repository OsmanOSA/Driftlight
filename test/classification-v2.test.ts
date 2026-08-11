import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeterministicClassifier } from "../src/classification/deterministic-classifier.js";
import { combineBehaviorFindings, evaluateBehaviorDecision } from "../src/classification/behavior-signals.js";
import { loadScoringConfigSync } from "../src/config/scoring-config.js";
import type { Classification, ClassificationInput, SessionEvent } from "../src/domain/types.js";
import { captureGitBaseline } from "../src/git/baseline.js";
import { writeCurrentIntent } from "../src/intent/current-intent.js";
import { scanRepository } from "../src/observer/snapshot.js";
import { buildImportGraph } from "../src/profile/import-graph.js";
import { buildRepoProfile } from "../src/profile/repo-profile.js";
import { formatScoreExplanation } from "../src/ui/terminal.js";

const TURN = "turn-1";

interface Workspace {
  root: string;
  classify: (
    relativePath: string,
    overrides?: Partial<ClassificationInput>,
  ) => Promise<Classification>;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function workspace(
  context: test.TestContext,
  options: { intent?: string; gitignore?: string; commits?: number; graphFiles?: number; dirtyPath?: string } = {},
): Promise<Workspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-v2-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0","dependencies":{"left-pad":"^1.0.0"}}\n');
  await fs.writeFile(path.join(root, "src", "anchor.ts"), 'import { direct } from "./direct";\nexport const anchor = direct;\n');
  await fs.writeFile(path.join(root, "src", "direct.ts"), "export const direct = 1;\n");
  for (let index = 2; index < (options.graphFiles ?? 2); index += 1) {
    await fs.writeFile(path.join(root, "src", `filler-${index}.ts`), `export const filler${index} = ${index};\n`);
  }
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  if (options.gitignore !== undefined) await fs.writeFile(path.join(root, ".gitignore"), options.gitignore);

  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  for (let index = 1; index < (options.commits ?? 1); index += 1) {
    await fs.writeFile(path.join(root, "README.md"), `hello ${index}\n`);
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", `history-${index}`]);
  }
  if (options.dirtyPath) {
    await fs.writeFile(path.join(root, ...options.dirtyPath.split("/")), "travail utilisateur non commité\n");
  }

  const baseline = await captureGitBaseline(root);
  const snapshot = await scanRepository(root);
  const scoringConfig = loadScoringConfigSync(root);
  await buildRepoProfile(root, snapshot, scoringConfig);
  await buildImportGraph(root, snapshot);
  await writeCurrentIntent(root, options.intent ?? "Corrige src/anchor.ts", { turnId: TURN, resetScope: true });

  const classifier = new DeterministicClassifier();
  return {
    root,
    classify: async (relativePath, overrides = {}) => {
      const current = await scanRepository(root);
      return classifier.classify({
        root,
        change: { path: relativePath, kind: "modified" },
        baseline,
        initialSnapshot: snapshot,
        currentSnapshot: current,
        changedFileCount: 1,
        deletedFileCount: 0,
        agentReads: [],
        emittedRuleIds: [],
        operation: { kind: "edit", deletedLineCount: 0 },
        ...overrides,
      });
    },
  };
}

// ── Étage 1 — exemptions ─────────────────────────────────────────────────────

test("v2: un fichier lu avant écriture est exempté, sans alerte", async (context) => {
  const workspaceContext = await workspace(context);
  const verdict = await workspaceContext.classify("src/direct.ts", {
    agentReads: [{ path: "src/direct.ts", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
  });

  assert.equal(verdict.level, "GREEN");
  assert.equal(verdict.stage, "exempt");
  assert.equal(verdict.exemptedBy, "read-this-turn");
});

test("v2: un fichier nommé dans l'intention est exempté même en réécriture intégrale", async (context) => {
  const workspaceContext = await workspace(context, { intent: "Réécris src/direct.ts entièrement" });
  const verdict = await workspaceContext.classify("src/direct.ts", {
    operation: { kind: "write", deletedLineCount: 500 },
  });

  assert.equal(verdict.level, "GREEN");
  assert.equal(verdict.exemptedBy, "named-in-intent");
});

test("v2: la lecture n'exempte plus une opération destructive", async (context) => {
  const workspaceContext = await workspace(context);
  // Lire avant de vider est le déroulement normal d'une édition destructive :
  // un veto absolu ouvrirait un trou en faux négatifs.
  const verdict = await workspaceContext.classify("src/direct.ts", {
    agentReads: [{ path: "src/direct.ts", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
    operation: { kind: "write", deletedLineCount: 400 },
  });

  assert.notEqual(verdict.stage, "exempt");
  assert.notEqual(verdict.level, "GREEN");
  assert.ok(verdict.codes.includes("destructive-edit"));
});

test("v2: gitignore n'exempte pas un fichier correspondant à un motif de secret", async (context) => {
  const workspaceContext = await workspace(context, { gitignore: "node_modules/\n.env\ndist/\n" });

  // .env est gitignoré dans la quasi-totalité des projets : sans cette limite,
  // l'exemption rendrait invisible exactement la catégorie à protéger.
  const secret = await workspaceContext.classify(".env");
  assert.notEqual(secret.exemptedBy, "git-ignored");
  assert.equal(secret.level, "RED");
  assert.ok(secret.codes.includes("sensitive-file"));

  // Un artefact de build ordinaire, lui, reste bien exempté.
  const artifact = await workspaceContext.classify("dist/bundle.js");
  assert.equal(artifact.level, "GREEN");
  assert.equal(artifact.exemptedBy, "git-ignored");
});

// ── Étage 2 — signaux de comportement ────────────────────────────────────────

test("v2: les familles empêchent les signaux corrélés de s'additionner", async (context) => {
  const workspaceContext = await workspace(context);
  const config = loadScoringConfigSync(workspaceContext.root);

  assert.equal(combineBehaviorFindings([], config), "GREEN");
  const correlated = evaluateBehaviorDecision([
    { id: "destructive-edit", severity: "ORANGE", reason: "" },
    { id: "full-file-reformat", severity: "ORANGE", reason: "" },
  ], config);
  assert.equal(correlated.verdict, "ORANGE");
  assert.deepEqual(correlated.activeFamilies, ["content-destruction"]);

  const independent = [
    { id: "destructive-edit", severity: "ORANGE" as const, reason: "" },
    { id: "dependency-added", severity: "ORANGE" as const, reason: "" },
  ];
  assert.equal(
    combineBehaviorFindings(independent, config),
    "ORANGE",
    "aucune accumulation implicite de signaux orange n'est autorisée",
  );

  const configuredEscalation = structuredClone(config);
  configuredEscalation.behavior.decisionTable.unshift({
    id: "destruction-plus-dependency",
    verdict: "RED",
    when: {
      minimumSignalSeverity: "ORANGE",
      minimumDistinctFamilies: 2,
      requiredFamilies: ["content-destruction", "dependency-change"],
    },
  });
  assert.equal(combineBehaviorFindings(independent, configuredEscalation), "RED");
  assert.equal(
    evaluateBehaviorDecision([{ id: "sensitive-file", severity: "RED", reason: "" }], config).verdict,
    "RED",
  );
});

/**
 * Régression de calibration : `write-without-read` a représenté 174 des 176
 * alertes de l'étage 2 sur le corpus réel, soit un voyant allumé en permanence.
 * Une preuve de procédé décrit la manière de faire, pas un dommage observable.
 */
test("v2: une preuve de procédé isolée n'allume pas le voyant, mais corrobore", async (context) => {
  const workspaceContext = await workspace(context);
  const config = loadScoringConfigSync(workspaceContext.root);
  const unread = { id: "write-without-read", severity: "ORANGE" as const, reason: "" };

  const alone = evaluateBehaviorDecision([unread], config);
  assert.equal(alone.verdict, "GREEN", "l'absence de lecture seule ne décide pas");

  const corroborated = evaluateBehaviorDecision(
    [unread, { id: "destructive-edit", severity: "ORANGE", reason: "" }],
    config,
  );
  assert.equal(corroborated.verdict, "ORANGE");
  assert.deepEqual(corroborated.activeFamilies.slice().sort(), ["content-destruction", "process-evidence"]);

  // Un dommage observable, lui, continue de décider seul.
  assert.equal(
    evaluateBehaviorDecision([{ id: "destructive-edit", severity: "ORANGE", reason: "" }], config).verdict,
    "ORANGE",
  );

  // Et la garantie rouge ne dépend d'aucune corroboration.
  assert.equal(
    evaluateBehaviorDecision([unread, { id: "sensitive-file", severity: "RED", reason: "" }], config).verdict,
    "RED",
  );
});

test("v2: la configuration refuse de rendre une famille rouge seulement corroborante", async (context) => {
  const workspaceContext = await workspace(context);
  const config = loadScoringConfigSync(workspaceContext.root);
  const broken = structuredClone(config) as unknown as Record<string, unknown>;
  (broken.behavior as Record<string, unknown>).corroboratingFamilies = ["sensitivity"];
  await fs.writeFile(path.join(workspaceContext.root, "driftlight.scoring.json"), JSON.stringify(broken));

  assert.throws(
    () => loadScoringConfigSync(workspaceContext.root),
    /ne peut pas être seulement corroborante/,
    "désarmer la garantie rouge par configuration doit être impossible",
  );
});

test("v2: le plan est un indice, jamais une exemption ni un masque critique", async (context) => {
  const workspaceContext = await workspace(context);

  const ordinary = await workspaceContext.classify("src/direct.ts", {
    declaredPlanPaths: ["src/direct.ts"],
  });
  assert.equal(ordinary.level, "GREEN");
  assert.equal(ordinary.stage, "behavior");
  assert.equal(ordinary.exemptedBy, undefined);
  const unread = ordinary.scoreBreakdown.signals.find((signal) => signal.id === "write-without-read");
  assert.deepEqual(unread?.rawValue, { existedBefore: true, readInSession: false, declaredInPlan: true });
  assert.equal(unread?.triggered, false);

  const destructive = await workspaceContext.classify("src/direct.ts", {
    declaredPlanPaths: ["src/direct.ts"],
    operation: { kind: "write", deletedLineCount: 200 },
  });
  assert.equal(destructive.level, "ORANGE");
  assert.ok(destructive.codes.includes("destructive-edit"));
  assert.equal(destructive.exemptedBy, undefined);

  const sensitive = await workspaceContext.classify(".env", {
    declaredPlanPaths: [".env"],
  });
  assert.equal(sensitive.level, "RED");
  assert.ok(sensitive.codes.includes("sensitive-file"));

  await fs.writeFile(
    path.join(workspaceContext.root, "package.json"),
    '{"name":"fixture","version":"1.0.0","dependencies":{"left-pad":"^1.0.0","lodash":"^4.0.0"}}\n',
  );
  const dependency = await workspaceContext.classify("package.json", {
    declaredPlanPaths: ["package.json"],
  });
  assert.equal(dependency.level, "ORANGE");
  assert.ok(dependency.codes.includes("dependency-added"));
});

test("v2: un ajout de dépendance alerte, un changement de version non", async (context) => {
  const workspaceContext = await workspace(context);

  await fs.writeFile(
    path.join(workspaceContext.root, "package.json"),
    '{"name":"fixture","version":"1.0.0","dependencies":{"left-pad":"^9.9.9"}}\n',
  );
  const bump = await workspaceContext.classify("package.json", {
    agentReads: [{ path: "package.json", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
  });
  assert.ok(!bump.codes.includes("dependency-added"), "un bump de version n'est pas un ajout");

  await fs.writeFile(
    path.join(workspaceContext.root, "package.json"),
    '{"name":"fixture","version":"1.0.0","dependencies":{"left-pad":"^1.0.0","lodash":"^4.0.0"}}\n',
  );
  const added = await workspaceContext.classify("package.json", {
    agentReads: [{ path: "package.json", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
  });
  assert.ok(added.codes.includes("dependency-added"));
  assert.match(added.reasons.join(" "), /lodash/);
});

// ── Étage 3 — observation seulement ──────────────────────────────────────────

test("v2: importDistance est indisponible hors du graphe, jamais compté", async (context) => {
  const workspaceContext = await workspace(context);
  const verdict = await workspaceContext.classify(".env");

  const distance = verdict.shadowScore?.signals.find((signal) => signal.id === "importDistance");
  assert.ok(distance, "le signal doit rester listé pour la traçabilité");
  assert.equal(distance?.available, false, "un .env n'est pas un module : signal non applicable");
  assert.equal(distance?.contribution, 0, "un signal indisponible ne contribue jamais");
  assert.match(distance?.explanation ?? "", /hors du graphe/);
  assert.ok(verdict.shadowScore?.unavailableSignals.includes("importDistance"));
});

test("v2: un shadowScore élevé n'alerte pas tant que shadowSignalsCanAlert est faux", async (context) => {
  const workspaceContext = await workspace(context, { graphFiles: 20 });
  const verdict = await workspaceContext.classify("src/filler-2.ts", {
    agentReads: [{ path: "src/filler-2.ts", turnId: "tour-précédent", timestamp: "2026-01-01T00:00:00.000Z" }],
  });

  assert.equal(verdict.level, "GREEN", "l'étage 3 ne décide pas");
  assert.ok(verdict.shadowScore, "mais il est bien mesuré et journalisé");
  assert.equal(verdict.shadowScore?.mode, "scored");
  assert.equal(verdict.shadowScore?.verdict, "RED");
});

test("v2: shadowSignalsCanAlert promeut le shadowScore sans diminuer l'étage 2", async (context) => {
  const workspaceContext = await workspace(context, { graphFiles: 20 });
  await fs.mkdir(path.join(workspaceContext.root, ".driftlight"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceContext.root, ".driftlight", "config.json"),
    JSON.stringify({ shadowSignalsCanAlert: true }),
  );
  const verdict = await workspaceContext.classify("src/filler-2.ts", {
    agentReads: [{ path: "src/filler-2.ts", turnId: "tour-précédent", timestamp: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(verdict.level, "RED");
  assert.equal(verdict.stage, "shadow");
  assert.equal(verdict.ruleId, "shadow-score");

  const behaviorRed = await workspaceContext.classify(".env", {
    agentReads: [{ path: ".env", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(behaviorRed.level, "RED");
  assert.equal(behaviorRed.stage, "behavior");
});

test("v2: l'exemption de création expire au tour suivant", async (context) => {
  const workspaceContext = await workspace(context);
  await fs.writeFile(path.join(workspaceContext.root, "src", "new.ts"), "export const value = 1;\n");
  const first = await workspaceContext.classify("src/new.ts", {
    change: { path: "src/new.ts", kind: "created" },
  });
  assert.equal(first.exemptedBy, "created-this-session");

  const later = await workspaceContext.classify("src/new.ts", {
    change: { path: "src/new.ts", kind: "modified" },
    operation: { kind: "write", deletedLineCount: 0 },
    createdPathsThisTurn: [],
  });
  assert.notEqual(later.stage, "exempt");
  assert.ok(later.codes.includes("destructive-edit"));
});

test("v2: un reformatage intégral observable est tracé comme signal distinct", async (context) => {
  const workspaceContext = await workspace(context);
  const verdict = await workspaceContext.classify("src/direct.ts", {
    agentReads: [{ path: "src/direct.ts", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
    operation: { kind: "write", deletedLineCount: 0, fullFileReformat: true },
  });
  assert.ok(verdict.codes.includes("destructive-edit"));
  assert.ok(verdict.codes.includes("full-file-reformat"));
  assert.equal(verdict.level, "ORANGE", "deux descriptions de la même destruction ne s'escaladent pas");
  assert.equal(verdict.scoreBreakdown.decisionRuleId, "orange-signal");
  assert.deepEqual(verdict.scoreBreakdown.activeSignalFamilies, ["content-destruction"]);
  const signal = verdict.scoreBreakdown.signals.find((item) => item.id === "full-file-reformat");
  assert.equal(signal?.available, true);
  assert.equal(signal?.triggered, true);
});

test("v2: un dépôt jeune renormalise sans planter", async (context) => {
  const workspaceContext = await workspace(context, { commits: 10, graphFiles: 20 });
  const verdict = await workspaceContext.classify("src/direct.ts", {
    agentReads: [{ path: "src/direct.ts", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
  });

  const shadow = verdict.shadowScore;
  assert.ok(shadow);
  // Sous 50 commits le taux de modification est indisponible, sous 100 la cooccurrence.
  assert.ok(shadow!.unavailableSignals.includes("fileRarity"));
  assert.ok(shadow!.unavailableSignals.includes("anchorCooccurrence"));
  assert.ok(shadow!.normalizationFactor > 1, "les poids restants sont renormalisés");
  assert.equal(typeof shadow!.score, "number");
});

test("v2: l'étage 0 reste rouge malgré lecture, plan et exemption de création", async (context) => {
  const workspaceContext = await workspace(context, { dirtyPath: "src/direct.ts" });
  await fs.rm(path.join(workspaceContext.root, "src", "direct.ts"));
  const verdict = await workspaceContext.classify("src/direct.ts", {
    change: { path: "src/direct.ts", kind: "deleted" },
    agentReads: [{ path: "src/direct.ts", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
    declaredPlanPaths: ["src/direct.ts"],
    createdPathsThisTurn: ["src/direct.ts"],
    operation: { kind: "observed", deletedLineCount: 1 },
  });
  assert.equal(verdict.level, "RED");
  assert.equal(verdict.stage, "absolute");
  assert.equal(verdict.exemptedBy, undefined);
});

test("v2: un projet non-JS garde l'étage 2 quand le graphe est indisponible", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-non-js-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "README.md"), "avant\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const initial = await scanRepository(root);
  const baseline = await captureGitBaseline(root);
  await buildImportGraph(root, initial);
  await writeCurrentIntent(root, "Modifie un autre document", { turnId: TURN, resetScope: true });
  await fs.writeFile(path.join(root, "README.md"), "après\n");
  const current = await scanRepository(root);
  const classify = (operation: { kind: "edit" | "write"; deletedLineCount: number }) =>
    new DeterministicClassifier().classify({
      root,
      change: { path: "README.md", kind: "modified", before: initial.files["README.md"], after: current.files["README.md"] },
      baseline,
      initialSnapshot: initial,
      currentSnapshot: current,
      changedFileCount: 1,
      deletedFileCount: 0,
      agentReads: [],
      emittedRuleIds: [],
      operation,
    });

  // Une édition ordinaire sur un fichier non lu : le seul signal actif est une
  // preuve de procédé, qui ne décide jamais seule.
  const ordinary = classify({ kind: "edit", deletedLineCount: 0 });
  assert.equal(ordinary.stage, "behavior");
  assert.equal(ordinary.shadowScore?.signals.find((signal) => signal.id === "importDistance")?.available, false);
  assert.equal(ordinary.level, "GREEN");
  assert.equal(
    ordinary.scoreBreakdown.signals.find((signal) => signal.id === "write-without-read")?.triggered,
    true,
    "le signal reste observé et journalisé, il ne décide simplement pas seul",
  );

  // La même absence de lecture, corroborée par une destruction observable,
  // alerte bien : l'étage 2 reste opérant sans graphe d'import.
  const destructive = classify({ kind: "write", deletedLineCount: 400 });
  assert.equal(destructive.stage, "behavior");
  assert.equal(destructive.level, "ORANGE");
  assert.deepEqual(
    destructive.scoreBreakdown.activeSignalFamilies?.slice().sort(),
    ["content-destruction", "process-evidence"],
  );
});

test("v2: explain sépare le verdict effectif du shadowScore", async (context) => {
  const workspaceContext = await workspace(context);
  const classification = await workspaceContext.classify("src/direct.ts", {
    agentReads: [{ path: "src/direct.ts", turnId: TURN, timestamp: "2026-01-01T00:00:00.000Z" }],
    operation: { kind: "write", deletedLineCount: 100 },
  });
  const event: SessionEvent = {
    id: "event-v2-explain",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "proposed-action",
    path: "src/direct.ts",
    changeKind: "modified",
    level: classification.level,
    reasons: classification.reasons,
    codes: classification.codes,
    ruleId: classification.ruleId,
    scoreBreakdown: classification.scoreBreakdown,
    shadowScore: classification.shadowScore,
    stage: classification.stage,
    expected: false,
  };
  const explanation = formatScoreExplanation(event);
  assert.match(explanation, /Verdict effectif par table de règles/);
  assert.match(explanation, /décision orange-signal/);
  assert.match(explanation, /famille content-destruction/);
  assert.match(explanation, /destructive-edit/);
  assert.match(explanation, /Étage 3 · observation seulement/);
  assert.match(explanation, /importDistance/);
});
