import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { writeCurrentIntent } from "../src/intent/current-intent.js";
import type { DriftLightConfig, SessionEvent, Severity } from "../src/domain/types.js";
import type { BackendLoader, NativeNotification, NotifierBackend } from "../src/notify/backend.js";
import { notificationFromPayload } from "../src/notify/backend.js";
import {
  buildNotification,
  dismissPendingNotifications,
  dispatchNotifications,
  notificationsDisabledByEnvironment,
  shouldNotify,
} from "../src/notify/dispatcher.js";
import {
  NotificationLedger,
  SESSION_NOTIFICATION_CAP,
  SILENCE_WINDOW_MS,
  suppressedByCap,
} from "../src/notify/notified-log.js";
import { appIconPath, severityIconPath } from "../src/notify/icons.js";
import { identityStatus } from "../src/notify/identity.js";
import { previewNotification } from "../src/notify/preview.js";
import {
  buildToastXml,
  DEFAULT_TOAST_APP_ID,
  dismissToastScript,
  DRIFTLIGHT_TOAST_APP_ID,
  richToastScript,
  toastAppId,
  toastTag,
  WINDOWS_TOAST_STARTUP_MS,
  windowsToastArguments,
} from "../src/notify/windows-toast.js";
import {
  panelEventName,
  PANEL_CONFIRMATION_MS,
  WINDOWS_PANEL_CONFIRM_MS,
  WINDOWS_PANEL_MAX_HEIGHT,
  WINDOWS_PANEL_STARTUP_MS,
  WINDOWS_PANEL_WIDTH,
  windowsPanelPayload,
  windowsPanelScript,
} from "../src/notify/windows-panel.js";
import { formatStopSummary } from "../src/ui/terminal.js";

const SESSION = "claude-session-1";

/** Environnement neutre : les tests ne doivent pas dépendre du CI ambiant. */
const NEUTRAL_ENV: NodeJS.ProcessEnv = {};

function event(id: string, level: Severity, overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "proposed-action",
    path: "src/secret.ts",
    changeKind: "modified",
    level,
    reasons: ["Fichier hors du périmètre annoncé."],
    codes: ["cumulative-score"],
    ruleId: "cumulative-score",
    scoreBreakdown: {
      mode: "absolute",
      configVersion: "test",
      score: null,
      unclampedScore: null,
      thresholds: { orange: 40, red: 70 },
      normalizationFactor: 1,
      signals: [],
      unavailableSignals: [],
      verdict: level,
      absoluteRuleId: "cumulative-score",
    },
    expected: false,
    ...overrides,
  };
}

function fakeNotifier(): { loader: BackendLoader; sent: NativeNotification[]; loads: number } {
  const sent: NativeNotification[] = [];
  const state = { loads: 0 };
  const backend: NotifierBackend = {
    name: "fake",
    send: async (notification) => {
      sent.push(notification);
    },
  };
  return {
    sent,
    get loads() {
      return state.loads;
    },
    loader: async () => {
      state.loads += 1;
      return backend;
    },
  };
}

async function temporaryRoot(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-notify-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
}

const config = (overrides: Partial<DriftLightConfig> = {}): DriftLightConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

/**
 * Ce n'est pas la gravité qui choisit la surface, mais l'interruption.
 *
 * Le panneau s'impose à l'écran et attend une décision : il ne se justifie que
 * si l'agent est réellement arrêté. Ouvert pour toute alerte rouge, il
 * apparaissait au début de l'appel d'outil et repartait à sa fin — pour une
 * commande rapide, un clignotement qu'on n'a pas le temps de lire.
 */
test("only an alert that stopped the agent claims the screen", () => {
  const halting = buildNotification("/repo", event("e1", "RED"), config(), "denied");
  assert.equal(halting.halted, true);

  for (const outcome of ["asked", "recorded"] as const) {
    assert.equal(
      buildNotification("/repo", event("e1", "RED"), config(), outcome).halted,
      undefined,
      `rien n'a été retenu (${outcome}) : le toast suffit, et se laisse relire`,
    );
  }

  // Refus sans arrêt : la décision n'attend nulle part, le panneau non plus.
  const withoutHalt = buildNotification("/repo", event("e1", "RED"), config({ haltOnRefusal: false }), "denied");
  assert.equal(withoutHalt.halted, undefined);
  assert.equal(withoutHalt.authorize, undefined, "sans arrêt, aucun geste n'est en attente");

  // Le repli n'a lieu qu'après cette attente : au-delà, une alerte qui a coupé
  // le tour resterait invisible pendant ce temps-là, panneau mort-né.
  assert.ok(WINDOWS_PANEL_CONFIRM_MS <= 5_000);
  assert.ok(WINDOWS_PANEL_CONFIRM_MS < WINDOWS_PANEL_STARTUP_MS, "plus court que le budget d'aperçu");
  // Une décision rendue ne doit pas laisser d'écriteau à ranger à la main.
  assert.ok(PANEL_CONFIRMATION_MS > 3_000, "assez pour lire la confirmation");
  assert.ok(PANEL_CONFIRMATION_MS <= 10_000, "trop court pour devenir un écriteau");
});

/**
 * La notification traverse un processus détaché, sérialisée en JSON puis
 * reconstruite. Un champ oublié à la relecture ne casse rien de visible :
 * l'alerte arrive quand même, simplement amputée de ce qui la rendait juste.
 * C'est exactement ainsi que le niveau et la description structurée se sont
 * perdus en route la première fois.
 */
test("no field of a notification is dropped on the detached hand-off", () => {
  const built = buildNotification("/repo", event("e1", "RED"), config(), "denied");
  const revived = notificationFromPayload(JSON.parse(JSON.stringify(built)) as NativeNotification);

  for (const field of Object.keys(built) as (keyof NativeNotification)[]) {
    // L'icône est la seule à être revérifiée sur disque au dernier moment.
    if (field === "icon") continue;
    assert.deepEqual(revived[field], built[field], `champ perdu à la remise : ${field}`);
  }
});

/**
 * `notify test` fabrique une alerte pour en montrer la forme : aucun hook n'a
 * tourné, rien n'a été évalué. Lui faire annoncer « action refusée » pendant que
 * l'agent continue de travailler apprendrait que cette phrase peut être fausse
 * — la seule phrase qui doit rester digne de foi quand elle sort d'un vrai
 * verdict.
 */
test("the preview announces itself instead of borrowing a verdict", () => {
  for (const level of ["RED", "ORANGE"] as const) {
    const preview = previewNotification(level);
    const status = preview.detail?.status ?? "";

    assert.doesNotMatch(preview.title, /bloqu|refus/i, `titre empruntant un verdict (${level})`);
    assert.doesNotMatch(status, /bloqu|refus|confirmation demandée/i, `pied empruntant un verdict (${level})`);
    assert.match(status, /Aperçu/);
    assert.match(preview.message, /Aperçu/, "le texte plat sert macOS, il doit le dire aussi");
    assert.notEqual(
      preview.persistent,
      true,
      "une notification ne reste à l'écran que si elle attend une décision ; un aperçu n'en attend aucune",
    );
    assert.equal(preview.level, level, "l'aperçu doit emprunter la surface du niveau qu'il illustre");
  }
});

/**
 * Le panneau ne propose de trancher que lorsqu'il y a réellement quelque chose
 * en attente.
 *
 * Un refus ferme arrête l'agent : la décision revient à l'utilisateur, et lui
 * offrir le geste sur place lui évite de retrouver une commande à taper. Une
 * alerte qui n'a rien retenu n'attend rien — un bouton y serait décoratif,
 * exactement le mensonge poli que ce projet a déjà eu à retirer trois fois.
 */
test("only a firm refusal offers a decision on the panel", () => {
  const refused = buildNotification("/repo", event("e1", "RED"), config(), "denied");
  assert.ok(refused.authorize, "un refus arrête l'agent : le geste doit être offert");
  assert.equal(refused.authorize?.args.includes("add-scope"), true);
  assert.equal(
    refused.authorize?.args.includes("src/secret.ts"),
    true,
    "c'est le sujet de l'alerte qui est autorisé, pas autre chose",
  );
  // Le tour de l'agent est clos : rien ne peut le relancer, et le dire évite
  // d'attendre en vain devant un panneau.
  assert.match(refused.authorize?.confirmation ?? "", /Redemandez/i);

  for (const outcome of ["asked", "recorded"] as const) {
    assert.equal(
      buildNotification("/repo", event("e1", "RED"), config(), outcome).authorize,
      undefined,
      `rien n'a été retenu (${outcome}) : aucun bouton ne doit apparaître`,
    );
  }
});

/**
 * Le sujet d'une alerte vient de l'agent : chemin, ou commande entière. Le
 * faire traverser un interpréteur en ferait un vecteur d'exécution, dans le
 * processus même qui prétend surveiller.
 */
test("the panel's decision never assembles a command line", () => {
  const hostile = event("e1", "RED", {
    path: undefined,
    detail: 'rm -rf x"; Start-Process calc; #',
  });
  const refused = buildNotification("/repo", hostile, config(), "denied");

  assert.deepEqual(
    refused.authorize?.args.at(-1),
    'rm -rf x"; Start-Process calc; #',
    "le sujet reste un argument entier, jamais concaténé",
  );
  const script = windowsPanelScript(refused);
  assert.ok(!script.includes("Start-Process calc"), "le texte hostile ne doit pas figurer en clair");
  assert.match(script, /-ArgumentList \$payload\.authorize\.args/, "les arguments partent en tableau");
  // Une fois la décision rendue, le panneau se retire de lui-même.
  assert.match(script, /\$after\.Start\(\)/, "la confirmation doit être suivie d'une fermeture");
});

// --- Libellé dérivé de l'issue réelle du hook ---------------------------------

test("the notification title states what actually happened, not the severity", () => {
  const root = path.join(os.tmpdir(), "boutique-en-ligne");
  const blocked = buildNotification(root, event("e1", "RED"), config(), true);
  assert.equal(blocked.title, "DriftLight · boutique-en-ligne — confirmation demandée");
  assert.doesNotMatch(blocked.message, /DriftLight (approve|reject)/);

  const observed = buildNotification(root, event("e1", "RED"), config(), false);
  assert.doesNotMatch(
    observed.title,
    /confirmation/,
    "claiming the action was blocked while the agent keeps working would be a lie",
  );
  assert.match(observed.title, /alerte rouge/);
  assert.doesNotMatch(observed.message, /DriftLight approve/);

  for (const notification of [blocked, observed]) {
    assert.match(notification.message, /src\/secret\.ts/);
  }
});

/**
 * Refus ferme et demande de confirmation n'engagent pas la même promesse :
 * l'un ne se contourne pas, l'autre dépend du mode de permission de l'hôte.
 * Les confondre, c'est promettre une sécurité qu'on ne contrôle pas.
 */
test("a firm refusal and a confirmation request are never announced alike", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  const refused = event("e-denied", "RED", { path: "src/perdu.ts" });
  const asked = event("e-asked", "RED", { path: "src/demande.ts" });

  await dispatchNotifications(root, [refused, asked], config(), SESSION, {
    loadBackend: notifier.loader,
    blockedEventIds: [refused.id, asked.id],
    deniedEventIds: [refused.id],
    environment: NEUTRAL_ENV,
  });

  assert.match(notifier.sent[0]?.title ?? "", /action refusée$/);
  assert.match(notifier.sent[1]?.title ?? "", /confirmation demandée$/);
});

/**
 * Une notification ne décrit que ce que DriftLight a fait.
 *
 * Il sait ce qu'il a répondu au hook ; il ignore ce que son interlocuteur en
 * fera, et n'a aucun moyen de le vérifier. Toute phrase au futur, ou qui
 * affirme un résultat constatable, devient fausse dès que le hook est appelé
 * par autre chose qu'un agent obéissant — et elle le devient sous les yeux de
 * qui la lit, pendant que le travail continue à l'écran.
 *
 * Ce piège est revenu trois fois : dans le titre, puis dans l'aperçu, puis dans
 * le pied du panneau. D'où ce garde-fou sur les trois surfaces à la fois.
 */
test("no notification predicts what anyone other than DriftLight will do", () => {
  const forbidden = /ne l'exécutera pas|ne sera pas exécut|action bloquée|a été bloqué|s'est arrêté/i;
  const root = "/repo";

  for (const outcome of ["denied", "asked", "recorded"] as const) {
    const alert = buildNotification(root, event("e1", "RED"), config(), outcome);
    assert.doesNotMatch(alert.title, forbidden, `titre (${outcome})`);
    assert.doesNotMatch(alert.message, forbidden, `corps (${outcome})`);
    assert.doesNotMatch(alert.detail?.status ?? "", forbidden, `pied du panneau (${outcome})`);
  }

  // Le refus doit rester lisible comme un refus : le prudence ne doit pas
  // l'avoir dilué en simple observation.
  const refused = buildNotification(root, event("e1", "RED"), config(), "denied");
  assert.match(refused.detail?.status ?? "", /refusée/i);
  assert.match(refused.title, /refusée/i);
});

/**
 * L'installation est désormais valable pour toute la machine : une alerte qui
 * ne nomme pas son dépôt oblige à deviner lequel des projets ouverts a bougé.
 */
test("the notification names the project it comes from", () => {
  const notification = buildNotification(
    path.join(os.tmpdir(), "api-facturation"),
    event("e1", "RED"),
    config(),
    false,
  );
  assert.match(notification.title, /api-facturation/);
});

/**
 * Un centre de notifications archive ce qu'il affiche. Une commande y laissant
 * un jeton en clair le rendrait lisible longtemps après la fin de la session.
 */
test("a token carried by a command never reaches the notification centre", () => {
  const notification = buildNotification(
    "/repo",
    event("e1", "RED", {
      path: undefined,
      detail: 'terraform destroy -var="token=sk-live-9f2ab77c41de88b0"',
      ruleId: "infrastructure-command",
      codes: ["infrastructure-command"],
    }),
    config(),
    true,
  );
  assert.doesNotMatch(notification.message, /9f2ab77c41de88b0/);
  assert.match(notification.message, /REDACTED/);
});

/** Le jargon appartient à `driftlight explain`, pas à un toast lu de biais. */
test("the message carries the request instead of rule identifiers", () => {
  const intent = {
    schemaVersion: 1 as const,
    version: 3,
    turnId: "turn-1",
    text: "Corrige la faute de frappe dans src/app.ts",
    scopeAdditions: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const notification = buildNotification(
    "/repo",
    event("e1", "RED", { path: ".env", ruleId: "sensitive-file", codes: ["sensitive-file"] }),
    config(),
    true,
    intent,
  );
  const lines = notification.message.split("\n");
  assert.equal(lines[0], "Écriture dans un fichier de secrets : .env");
  assert.match(lines[1] ?? "", /Vous aviez demandé.+Corrige la faute de frappe/);
  assert.match(lines[2] ?? "", /Refusez/);
  assert.doesNotMatch(notification.message, /sensitive-file/, "aucun identifiant technique");
  assert.doesNotMatch(notification.message, /\(\^\|\//, "aucune expression régulière");
});

test("a long path keeps its end, and a missing request drops its line", () => {
  const notification = buildNotification(
    "/repo",
    event("e1", "ORANGE", { path: "packages/services/billing/src/infrastructure/persistence/entity.ts" }),
    config(),
    false,
  );
  const lines = notification.message.split("\n");
  assert.match(lines[0] ?? "", /entity\.ts$/, "la fin du chemin situe, son début non");
  assert.ok(!notification.message.includes("«"), "pas de citation vide sans intention connue");
  for (const line of lines) assert.ok(line.length <= 110, `ligne trop longue : ${line}`);
});

test("only the event the hook actually refused is announced as blocked", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  const refused = event("e-refused", "RED", { path: "src/refused.ts" });
  const recorded = event("e-recorded", "RED", { path: "src/recorded.ts" });

  await dispatchNotifications(root, [refused, recorded], config(), SESSION, {
    loadBackend: notifier.loader,
    blockedEventIds: [refused.id],
    environment: NEUTRAL_ENV,
  });

  assert.equal(notifier.sent.length, 2);
  assert.match(notifier.sent[0]?.title ?? "", /confirmation demandée$/);
  assert.doesNotMatch(notifier.sent[1]?.title ?? "", /confirmation/);
});

/**
 * Régression observée en usage réel : une session sans intention propre
 * reprenait l'intention partagée du dépôt, et le toast citait une demande
 * vieille de plusieurs heures — écrite dans une autre session. L'utilisateur
 * jugeait alors l'alerte sur une phrase qu'il n'avait pas écrite ici.
 */
test("a request written in another session is never quoted", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  await writeCurrentIntent(root, "Nettoie entièrement le dossier legacy");

  await dispatchNotifications(root, [event("e1", "RED")], config(), "claude-autre-session", {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });

  assert.equal(notifier.sent.length, 1);
  assert.doesNotMatch(
    notifier.sent[0]?.message ?? "",
    /legacy/,
    "mieux vaut ne rien citer que citer la demande d'une autre session",
  );
});

// --- Garde d'environnement ----------------------------------------------------

test("the environment guard recognises test, CI and the explicit opt-out", () => {
  assert.equal(notificationsDisabledByEnvironment({ NODE_ENV: "test" }), true);
  assert.equal(notificationsDisabledByEnvironment({ CI: "true" }), true);
  assert.equal(notificationsDisabledByEnvironment({ CI: "" }), true, "CI merely being defined is enough");
  assert.equal(notificationsDisabledByEnvironment({ DRIFTLIGHT_NO_NOTIFY: "1" }), true);
  assert.equal(notificationsDisabledByEnvironment({ NODE_ENV: "production" }), false);
  assert.equal(notificationsDisabledByEnvironment({}), false);
});

test("no system notification escapes while running under a test or CI environment", async (context) => {
  const root = await temporaryRoot(context);

  for (const environment of [{ NODE_ENV: "test" }, { CI: "1" }, { DRIFTLIGHT_NO_NOTIFY: "1" }]) {
    const notifier = fakeNotifier();
    const outcome = await dispatchNotifications(root, [event("e-guard", "RED")], config(), SESSION, {
      loadBackend: notifier.loader,
      environment,
    });
    assert.deepEqual(outcome.map((item) => item.outcome), ["environment-disabled"]);
    assert.equal(notifier.sent.length, 0);
    assert.equal(notifier.loads, 0, "the library must not even be loaded");
  }
});

test("this very test suite runs with notifications disabled", () => {
  assert.equal(
    notificationsDisabledByEnvironment(),
    true,
    "run-tests.mjs must set NODE_ENV=test so integration tests cannot fire real toasts",
  );
});

// --- Déduplication persistée --------------------------------------------------

test("a given eventId is notified at most once, across separate processes", async (context) => {
  const root = await temporaryRoot(context);
  const first = fakeNotifier();
  const red = event("e-dedup", "RED");

  const initial = await dispatchNotifications(root, [red], config(), SESSION, {
    loadBackend: first.loader,
    environment: NEUTRAL_ENV,
  });
  assert.deepEqual(initial.map((item) => item.outcome), ["sent"]);

  // Aucun état partagé : un hook Claude Code s'exécute dans un processus neuf.
  const second = fakeNotifier();
  const replay = await dispatchNotifications(root, [red], config(), SESSION, {
    loadBackend: second.loader,
    environment: NEUTRAL_ENV,
  });
  assert.deepEqual(replay.map((item) => item.outcome), ["duplicate-event"]);
  assert.equal(second.sent.length, 0);
});

test("the same path and rule stays silent inside the 10 minute window", async (context) => {
  const root = await temporaryRoot(context);
  const ledger = new NotificationLedger(root);
  const base = Date.parse("2026-01-01T12:00:00.000Z");
  const request = { subject: "src/a.ts", ruleId: "cumulative-score", sessionId: SESSION };

  assert.equal(ledger.reserve({ ...request, eventId: "first", now: base }), "accepted");
  assert.equal(
    ledger.reserve({ ...request, eventId: "second", now: base + SILENCE_WINDOW_MS - 1000 }),
    "duplicate-recent",
    "a distinct event on the same path and rule must stay silent inside the window",
  );
  assert.equal(
    ledger.reserve({ ...request, eventId: "third", now: base + SILENCE_WINDOW_MS + 1000 }),
    "accepted",
    "past the window the same path may notify again",
  );
});

test("a different rule or a different path is not silenced by the window", async (context) => {
  const root = await temporaryRoot(context);
  const ledger = new NotificationLedger(root);
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  assert.equal(
    ledger.reserve({ eventId: "a", subject: "src/a.ts", ruleId: "rule-one", sessionId: SESSION, now }),
    "accepted",
  );
  assert.equal(
    ledger.reserve({ eventId: "b", subject: "src/a.ts", ruleId: "rule-two", sessionId: SESSION, now }),
    "accepted",
    "another rule on the same path is a different signal",
  );
  assert.equal(
    ledger.reserve({ eventId: "c", subject: "src/b.ts", ruleId: "rule-one", sessionId: SESSION, now }),
    "accepted",
    "the same rule on another path is a different signal",
  );
});

// --- Plafond de session -------------------------------------------------------

test("a session never exceeds the hard notification cap, and counts what it silenced", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  // Chemins distincts, pour isoler le plafond de la fenêtre de silence.
  const events = Array.from({ length: SESSION_NOTIFICATION_CAP + 2 }, (_, index) =>
    event(`e-cap-${index}`, "RED", { path: `src/file-${index}.ts` }));

  const outcome = await dispatchNotifications(root, events, config(), SESSION, {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });

  const sent = outcome.filter((item) => item.outcome === "sent");
  const capped = outcome.filter((item) => item.outcome === "session-cap");
  assert.equal(sent.length, SESSION_NOTIFICATION_CAP);
  assert.equal(capped.length, 2);
  assert.equal(notifier.sent.length, SESSION_NOTIFICATION_CAP);
  assert.equal(suppressedByCap(root, SESSION), 2, "silenced alerts are counted for the Stop summary");
});

test("a new session resets the cap and its silent counter", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  const saturate = Array.from({ length: SESSION_NOTIFICATION_CAP + 1 }, (_, index) =>
    event(`e-first-${index}`, "RED", { path: `src/first-${index}.ts` }));

  await dispatchNotifications(root, saturate, config(), "session-a", {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });
  assert.equal(suppressedByCap(root, "session-a"), 1);

  const next = await dispatchNotifications(root, [event("e-next", "RED", { path: "src/next.ts" })], config(), "session-b", {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });
  assert.deepEqual(next.map((item) => item.outcome), ["sent"]);
  assert.equal(suppressedByCap(root, "session-b"), 0);
  assert.equal(suppressedByCap(root, "session-a"), 0, "the counter belongs to the current session only");
});

// --- Un blocage n'est jamais tu -------------------------------------------

test("a blocked action notifies again every time the agent proposes it anew", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  // Scénario réel : l'agent propose une suppression, l'utilisateur ne valide pas,
  // l'agent la repropose quelques tours plus tard. À chaque fois il reste arrêté,
  // en attente — donc à chaque fois l'utilisateur doit être prévenu.
  for (const attempt of ["first", "second", "third"]) {
    const proposal = event(`event-block-${attempt}`, "RED", { path: "src/important.ts" });
    const outcome = await dispatchNotifications(root, [proposal], config(), SESSION, {
      loadBackend: notifier.loader,
      blockedEventIds: [proposal.id],
      environment: NEUTRAL_ENV,
    });
    assert.deepEqual(
      outcome.map((item) => item.outcome),
      ["sent"],
      `attempt ${attempt}: a silenced block leaves the user unaware the agent is waiting`,
    );
  }

  assert.equal(notifier.sent.length, 3, "same path, same rule, three blocks, three notifications");
  assert.equal(
    notifier.sent.every((notification) => /confirmation demandée$/.test(notification.title)),
    true,
  );
});

test("a blocked action is not silenced by the session cap either", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  // Le plafond est saturé par des événements ordinaires...
  const filler = Array.from({ length: SESSION_NOTIFICATION_CAP }, (_, index) =>
    event(`event-filler-${index}`, "RED", { path: `src/filler-${index}.ts` }));
  await dispatchNotifications(root, filler, config(), SESSION, {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });
  assert.equal(notifier.sent.length, SESSION_NOTIFICATION_CAP);

  // ...mais l'agent qui attend une décision passe quand même.
  const blocked = event("event-blocked-past-cap", "RED", { path: "src/critical.ts" });
  const outcome = await dispatchNotifications(root, [blocked], config(), SESSION, {
    loadBackend: notifier.loader,
    blockedEventIds: [blocked.id],
    environment: NEUTRAL_ENV,
  });

  assert.deepEqual(outcome.map((item) => item.outcome), ["sent"]);
  assert.equal(suppressedByCap(root, SESSION), 0, "a block is never counted as silenced");
});

test("the same eventId still notifies only once, even when blocking", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  const proposal = event("event-block-idempotent", "RED");

  // Rejouer le *même* événement — un hook relancé — reste une seule demande.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dispatchNotifications(root, [proposal], config(), SESSION, {
      loadBackend: notifier.loader,
      blockedEventIds: [proposal.id],
      environment: NEUTRAL_ENV,
    });
  }
  assert.equal(notifier.sent.length, 1);
});

test("anti-noise still applies to merely recorded events", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  // Sans blocage, rien n'attend l'utilisateur : la répétition redevient du bruit.
  const first = event("event-observed-1", "RED", { path: "src/same.ts" });
  const second = event("event-observed-2", "RED", { path: "src/same.ts" });
  await dispatchNotifications(root, [first], config(), SESSION, {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });
  const repeat = await dispatchNotifications(root, [second], config(), SESSION, {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });

  assert.deepEqual(repeat.map((item) => item.outcome), ["duplicate-recent"]);
  assert.equal(notifier.sent.length, 1);
});

test("the Stop summary surfaces the silenced count, and stays quiet when nothing was capped", () => {
  const alerts = [event("e-stop", "RED", { turnId: "turn-1" })];

  const withCap = formatStopSummary(alerts, "turn-1", 4) ?? "";
  assert.match(withCap, /4 notification/);
  assert.match(withCap, /plafond/);
  assert.match(withCap, /e-stop/, "the alert itself is still listed, only the toast was withheld");

  const withoutCap = formatStopSummary(alerts, "turn-1", 0) ?? "";
  assert.ok(!withoutCap.includes("plafond"), "no cap line when nothing was silenced");
  assert.equal(formatStopSummary(alerts, "other-turn", 4), null, "still nothing when the turn has no alert");
});

// --- Sélection par niveau -----------------------------------------------------

test("Windows toast uses argument arrays and a bounded startup window", () => {
  const notification: NativeNotification = {
    title: "DriftLight — confirmation demandée",
    message: "C:\\Work Folder\\.env\ndestructive-git-command",
    sound: true,
  };
  assert.deepEqual(windowsToastArguments(notification), [
    "-t",
    notification.title,
    "-m",
    notification.message,
    "-s",
    "Notification.Default",
  ]);
  assert.ok(WINDOWS_TOAST_STARTUP_MS < 1_000);
});

test("the Windows panel lays out the structured detail rather than stacked lines", () => {
  const readyFile = path.join(os.tmpdir(), "driftlight-panel-ready-unit-test");
  const payload = windowsPanelPayload({
    ...richNotification,
    detail: {
      verb: "Réécriture",
      headline: "fichier contenant du travail non sauvegardé",
      evidence: "src/legacy.ts",
      meta: "Alerte rouge · 2 signaux concordants",
      intent: "« Corrige & range »",
      action: "Refusez maintenant.",
      status: "Action refusée — l'agent n'est pas autorisé à l'exécuter",
    },
    readyFile,
  });

  assert.equal(payload.context, "DriftLight · projet");
  assert.equal(payload.verb, "Réécriture");
  assert.equal(payload.headline, "Fichier contenant du travail non sauvegardé", "l'énoncé ouvre le panneau, donc il porte la majuscule");
  assert.equal(payload.evidence, "src/legacy.ts", "le sujet vit dans son propre encart, pas collé à l'énoncé");
  assert.equal(payload.meta, "Alerte rouge · 2 signaux concordants");
  assert.equal(payload.status, "Action refusée — l'agent n'est pas autorisé à l'exécuter");
  assert.equal(payload.persistent, true);
  assert.equal(payload.readyFile, readyFile);
  assert.match(payload.accentStart, /^#FF/);
  assert.equal(
    windowsPanelPayload({ ...richNotification, readyFile: path.join(process.cwd(), "unexpected.txt") }).readyFile,
    undefined,
    "un accusé de démarrage ne peut jamais écrire hors du dossier temporaire",
  );
});

/**
 * Une notification construite ailleurs dans le code n'a pas de description
 * structurée. Elle doit rester lisible, seulement moins riche : sans ce repli,
 * le panneau s'afficherait vide.
 */
test("a notification without structured detail still fills the panel", () => {
  const payload = windowsPanelPayload(richNotification);

  assert.equal(payload.headline, "Réécriture d'un fichier");
  assert.equal(payload.evidence, "src/legacy.ts");
  assert.equal(payload.intent, "Vous aviez demandé : « Corrige & range »");
  assert.equal(payload.action, "Refusez maintenant.");
  assert.equal(payload.verb, "", "sans verbe connu, la rangée se replie plutôt que d'en inventer un");
  assert.equal(payload.status, "Action refusée");
});

test("the Windows panel keeps user text out of executable PowerShell", () => {
  const notification = {
    ...richNotification,
    title: "DriftLight · projet — action refusée'; exit 9; #",
  };
  const script = windowsPanelScript(notification);

  assert.ok(!script.includes(notification.title));
  assert.match(script, /FromBase64String/);
  assert.match(script, /-EncodedCommand|XamlReader|PanelHeadline/);
});

test("the Windows panel is notification-sized and its application owns the window", () => {
  const script = windowsPanelScript(richNotification);

  assert.ok(WINDOWS_PANEL_WIDTH <= 440, "une notification, pas une boîte de dialogue");
  assert.ok(WINDOWS_PANEL_MAX_HEIGHT <= 400, "le plafond doit rester celui d'un coin d'écran");
  assert.match(script, /ShutdownMode.*OnExplicitShutdown/);
  assert.match(script, /\$app\.Run\(\$window\)/);
  assert.doesNotMatch(script, /\$window\.Show\(\)/);
  assert.match(script, /-not \$payload\.persistent/);
});

/**
 * Le panneau ne détient pas la décision : le hook l'a rendue avant qu'il ne
 * s'affiche, et l'agent tranche dans sa propre interface. Un bouton d'accord ou
 * de refus y serait décoratif — exactement la promesse creuse que ce projet a
 * déjà eu à retirer d'un titre de notification.
 */
test("the panel offers no verdict it cannot deliver", () => {
  const script = windowsPanelScript(richNotification);

  assert.doesNotMatch(script, /Autoriser|Approuver|Refuser|Rejeter/i);
  // Seul bouton présent : fermer la fenêtre, ce que le panneau contrôle bel et bien.
  assert.match(script, /\$close\.Add_Click\(\{\$window\.Close\(\)\}\)/);
});

test("panel dismissal names are bounded and contain no executable characters", () => {
  assert.equal(panelEventName("event/avec:signes"), "Local\\DriftLight.Notification.event-avec-signes");
  assert.ok(panelEventName("x".repeat(200)).length <= 94);
});

/**
 * SnoreToast n'affiche rien du tout lorsque `-p` désigne un fichier absent.
 * Perdre la couleur est acceptable ; perdre l'alerte ne l'est pas.
 */
test("a severity badge is attached only when the file really exists", () => {
  const base: NativeNotification = { title: "t", message: "m", sound: false };
  const real = severityIconPath("RED");
  assert.ok(real, "les pastilles doivent être livrées avec le paquet");
  assert.ok(windowsToastArguments({ ...base, icon: real }).includes("-p"));

  const missing = windowsToastArguments({ ...base, icon: path.join(os.tmpdir(), "absente.png") });
  assert.ok(!missing.includes("-p"), "un chemin mort ne doit jamais atteindre SnoreToast");
  assert.ok(!windowsToastArguments(base).includes("-p"));
});

// --- Toast Windows enrichi ----------------------------------------------------

const richNotification: NativeNotification = {
  title: "DriftLight · projet — action refusée",
  message: "Réécriture d'un fichier : src/legacy.ts\nVous aviez demandé : « Corrige & range »\nRefusez maintenant.",
  sound: true,
  persistent: true,
  attribution: "DriftLight — voyant local de dérive",
};

/**
 * Le contenu vient de l'utilisateur : un chemin ou une demande contenant `&`
 * ou `<` rendrait le document invalide, et Windows n'afficherait alors rien du
 * tout — une alerte perdue pour une apostrophe.
 */
test("user content is escaped before it reaches the toast document", () => {
  const xml = buildToastXml({
    ...richNotification,
    title: 'Projet <script> & "guillemets"',
    message: "Chemin : src/a&b.ts\nDemande : « ' »",
  });
  assert.ok(!/<script>/.test(xml), "aucune balise ne doit survivre au contenu utilisateur");
  assert.match(xml, /&amp;/);
  assert.match(xml, /&lt;script&gt;/);
  assert.match(xml, /&quot;/);
});

test("the Windows toast improves hierarchy without rewriting its content", () => {
  const xml = buildToastXml(richNotification, "file:///badge-red.png");

  assert.match(xml, /<visual lang="fr-FR">/);
  assert.match(xml, /hint-style="title"[^>]*>DriftLight · projet — action refusée<\/text>/);
  assert.match(xml, /hint-style="body"[^>]*>Réécriture d&apos;un fichier : src\/legacy\.ts<\/text>/);
  assert.match(xml, /hint-style="captionSubtle"[^>]*>Vous aviez demandé/);
  assert.match(xml, /hint-style="bodySubtle"[^>]*>Refusez maintenant/);
  assert.match(xml, /alternateText="DriftLight"/);
  assert.match(xml, /content="Ignorer"/);
  assert.doesNotMatch(xml, /Alerte rouge|Confirmation requise|Fermer l’alerte/);
});

/**
 * ToastGeneric n'accepte que quatre éléments de texte. Au-delà, Windows rejette
 * le document entier : dépasser le budget ne dégraderait pas la notification,
 * il la ferait disparaître.
 */
test("the toast never exceeds the four text elements Windows accepts", () => {
  const xml = buildToastXml({
    ...richNotification,
    message: ["une", "deux", "trois", "quatre", "cinq"].join("\n"),
  });
  assert.equal((xml.match(/<text/g) ?? []).length, 4);
  assert.ok(!xml.includes("quatre"), "le contenu excédentaire est coupé, pas empilé");
});

test("the attribution yields its place to the content when the budget is tight", () => {
  const dense = buildToastXml(richNotification);
  assert.ok(!dense.includes("placement=\"attribution\""), "trois lignes de corps saturent le budget");

  const sparse = buildToastXml({ ...richNotification, message: "une seule ligne" });
  assert.match(sparse, /placement="attribution"/);
});

/**
 * Une alerte qui retient une action ne doit pas pouvoir s'effacer pendant qu'on
 * regarde ailleurs : c'est exactement le moment où elle sert.
 */
test("an alert that holds an action stays until it is dismissed", () => {
  assert.match(buildToastXml(richNotification), /scenario="reminder"/);
  assert.match(buildToastXml({ ...richNotification, persistent: false }), /duration="long"/);
  assert.match(buildToastXml(richNotification), /activationType="system" arguments="dismiss"/);
});

test("a silent notification says so in the document itself", () => {
  assert.match(buildToastXml({ ...richNotification, sound: false }), /<audio silent="true"\/>/);
  assert.ok(!buildToastXml(richNotification).includes("<audio"));
});

test("the PowerShell payload survives any quoting through base64", () => {
  const xml = buildToastXml({ ...richNotification, title: "Guillemets ' et \" mêlés" });
  const script = richToastScript(xml, "Some.App.Id");
  const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
  assert.ok(encoded, "la charge utile doit être encodée");
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), xml);
});

// --- Retrait d'une alerte dont la décision est prise ---------------------------

/**
 * Signalé en usage réel : approuver la commande dans l'agent laissait la
 * notification à l'écran, à réclamer une décision déjà rendue. Une alerte qui
 * survit à son objet apprend à l'utilisateur à les ignorer toutes.
 */
test("a persistent alert carries the tag that will let it be withdrawn", () => {
  const held = buildNotification("/repo", event("e-held", "RED"), config(), "asked");
  assert.equal(held.tag, "e-held");
  assert.equal(held.persistent, true);

  const recorded = buildNotification("/repo", event("e-seen", "RED"), config(), "recorded");
  assert.equal(recorded.tag, undefined, "une alerte qui ne retient rien n'a rien à retirer");
  assert.equal(recorded.persistent, undefined);
});

test("the tag stays within what Windows accepts", () => {
  assert.equal(toastTag("event-123_abc.def"), "event-123_abc.def");
  assert.equal(toastTag("chemin/avec:signes"), "chemin-avec-signes");
  assert.equal(toastTag("x".repeat(200)).length, 64);
});

test("the withdrawal script names every tag, the group and the identity", () => {
  const script = dismissToastScript(["un", "deux"], "Mon.Identite");
  assert.match(script, /@\('un','deux'\)/);
  assert.match(script, /'driftlight'/);
  assert.match(script, /'Mon\.Identite'/);
  assert.match(script, /History/);
});

test("a quote in an identity cannot break out of the script", () => {
  const script = dismissToastScript(["a'b"], "App'Id");
  assert.match(script, /'a''b'/);
  assert.match(script, /'App''Id'/);
});

test("the toast is labelled at send time, or it can never be found again", () => {
  const xml = buildToastXml(richNotification);
  assert.match(richToastScript(xml, "App", "etiquette"), /\$toast\.Tag='etiquette'/);
  assert.match(richToastScript(xml, "App", "etiquette"), /\$toast\.Group='driftlight'/);
  assert.ok(!richToastScript(xml, "App").includes("$toast.Tag"));
});

test("pending alerts are withdrawn once, then forgotten", async (context) => {
  const root = await temporaryRoot(context);
  const withdrawn: string[][] = [];
  const notifier = fakeNotifier();
  const loadBackend: BackendLoader = async () => ({
    name: "fake",
    send: notifier.loader ? async (notification) => {
      (await notifier.loader()) as unknown;
      notifier.sent.push(notification);
    } : async () => undefined,
    dismiss: async (tags) => {
      withdrawn.push([...tags]);
    },
  });

  await dispatchNotifications(root, [event("e1", "RED")], config(), SESSION, {
    loadBackend,
    blockedEventIds: ["e1"],
    environment: NEUTRAL_ENV,
  });

  assert.deepEqual(
    await dismissPendingNotifications(root, SESSION, { loadBackend, environment: NEUTRAL_ENV }),
    ["e1"],
  );
  assert.deepEqual(withdrawn, [["e1"]]);

  assert.deepEqual(
    await dismissPendingNotifications(root, SESSION, { loadBackend, environment: NEUTRAL_ENV }),
    [],
    "un retrait déjà effectué ne doit pas être rejoué",
  );
  assert.equal(withdrawn.length, 1);
});

test("another session's alerts are never withdrawn by mistake", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  await dispatchNotifications(root, [event("e1", "RED")], config(), "session-a", {
    loadBackend: notifier.loader,
    blockedEventIds: ["e1"],
    environment: NEUTRAL_ENV,
  });

  assert.deepEqual(
    await dismissPendingNotifications(root, "session-b", {
      loadBackend: notifier.loader,
      environment: NEUTRAL_ENV,
    }),
    [],
  );
  assert.deepEqual(
    await dismissPendingNotifications(root, "session-a", {
      loadBackend: notifier.loader,
      environment: NEUTRAL_ENV,
    }),
    ["e1"],
  );
});

test("a backend unable to withdraw never breaks the caller", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();
  await dispatchNotifications(root, [event("e1", "RED")], config(), SESSION, {
    loadBackend: notifier.loader,
    blockedEventIds: ["e1"],
    environment: NEUTRAL_ENV,
  });
  // Le faux backend n'implémente pas `dismiss` : l'appel doit rester sans effet
  // plutôt que de lever, comme lorsqu'une bibliothèque ancienne est installée.
  await assert.doesNotReject(dismissPendingNotifications(root, SESSION, {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  }));
});

test("the toast identity follows the override, then what is installed", () => {
  assert.equal(toastAppId({ DRIFTLIGHT_TOAST_APPID: "Mon.Identite" }, false), "Mon.Identite");
  assert.equal(toastAppId({ DRIFTLIGHT_TOAST_APPID: "   " }, false), DEFAULT_TOAST_APP_ID);
  assert.equal(toastAppId({}, false), DEFAULT_TOAST_APP_ID);
  assert.equal(toastAppId({}, true), DRIFTLIGHT_TOAST_APP_ID);
});

test("the application identity is reported as unsupported off Windows", () => {
  const status = identityStatus("darwin");
  assert.equal(status.supported, false);
  assert.equal(status.installed, false);
});

test("the severity badges shipped with the package are valid PNG files", async () => {
  for (const level of ["RED", "ORANGE"] as const) {
    const file = severityIconPath(level);
    assert.ok(file, `pastille manquante pour ${level}`);
    const header = await fs.readFile(file);
    assert.deepEqual(
      [...header.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "un PNG invalide supprimerait la notification au lieu de la décorer",
    );
    assert.equal(header.readUInt32BE(16), 256, "Windows recadre en cercle : l'image doit rester nette");
  }
  assert.equal(severityIconPath("GREEN"), undefined, "le vert ne notifie jamais");
});

/**
 * Windows lit l'icône du raccourci pour l'en-tête de la notification. Un ICO
 * absent ou mal formé ferait retomber DriftLight sur l'icône de l'exécutable
 * qui l'a lancé — c'est-à-dire sur celle de Node.
 */
test("the application icon ships as both PNG and a well-formed ICO", async () => {
  const png = appIconPath("png");
  const ico = appIconPath("ico");
  assert.ok(png && ico, "les deux formes doivent être livrées");
  const buffer = await fs.readFile(ico);
  assert.equal(buffer.readUInt16LE(0), 0, "champ réservé");
  assert.equal(buffer.readUInt16LE(2), 1, "type icône");
  assert.equal(buffer.readUInt16LE(4), 1, "une image");
  const length = buffer.readUInt32LE(14);
  const offset = buffer.readUInt32LE(18);
  assert.equal(offset + length, buffer.length, "l'entrée doit couvrir exactement le fichier");
  assert.deepEqual(
    [...buffer.subarray(offset, offset + 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "l'ICO encapsule un PNG",
  );
});

test("orange does not notify under the default configuration", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  assert.equal(DEFAULT_CONFIG.notifyOnOrange, false, "notifyOnOrange must default to false");
  assert.equal(shouldNotify(event("e-orange", "ORANGE"), DEFAULT_CONFIG), false);

  const outcome = await dispatchNotifications(root, [event("e-orange", "ORANGE")], config(), SESSION, {
    loadBackend: notifier.loader,
    environment: NEUTRAL_ENV,
  });

  assert.deepEqual(outcome.map((item) => item.outcome), ["level-disabled"]);
  assert.equal(notifier.sent.length, 0);
  assert.equal(notifier.loads, 0, "the library must not even be loaded when nothing qualifies");
});

test("orange notifies once notifyOnOrange is enabled", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  const outcome = await dispatchNotifications(
    root,
    [event("e-orange-on", "ORANGE")],
    config({ notifyOnOrange: true }),
    SESSION,
    { loadBackend: notifier.loader, environment: NEUTRAL_ENV },
  );

  assert.deepEqual(outcome.map((item) => item.outcome), ["sent"]);
  assert.equal(notifier.sent.length, 1);
});

test("green and lifecycle events never notify", async (context) => {
  const root = await temporaryRoot(context);
  const notifier = fakeNotifier();

  const outcome = await dispatchNotifications(
    root,
    [event("e-green", "GREEN"), event("e-lifecycle", "RED", { type: "lifecycle" })],
    config({ notifyOnOrange: true }),
    SESSION,
    { loadBackend: notifier.loader, environment: NEUTRAL_ENV },
  );

  assert.deepEqual(outcome.map((item) => item.outcome), ["level-disabled", "level-disabled"]);
  assert.equal(notifier.sent.length, 0);
});

// --- Dégradation --------------------------------------------------------------

test("a missing notification library degrades without throwing", async (context) => {
  const root = await temporaryRoot(context);
  const outcome = await dispatchNotifications(root, [event("e-none", "RED")], config(), SESSION, {
    loadBackend: async () => null,
    environment: NEUTRAL_ENV,
  });
  assert.deepEqual(outcome.map((item) => item.outcome), ["backend-unavailable"]);
});

test("a notification library that throws degrades without throwing", async (context) => {
  const root = await temporaryRoot(context);

  const loaderThrows = await dispatchNotifications(root, [event("e-throw-load", "RED")], config(), SESSION, {
    loadBackend: async () => {
      throw new Error("module introuvable");
    },
    environment: NEUTRAL_ENV,
  });
  assert.deepEqual(loaderThrows.map((item) => item.outcome), ["backend-unavailable"]);

  const sendThrows = await dispatchNotifications(root, [event("e-throw-send", "RED", { path: "src/other.ts" })], config(), SESSION, {
    loadBackend: async () => ({
      name: "broken",
      send: async () => {
        throw new Error("toast refusé par le système");
      },
    }),
    environment: NEUTRAL_ENV,
  });
  assert.deepEqual(sendThrows.map((item) => item.outcome), ["backend-unavailable"]);
});
