import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { DriftLightConfig, SessionEvent, Severity } from "../src/domain/types.js";
import type { BackendLoader, NativeNotification, NotifierBackend } from "../src/notify/backend.js";
import {
  buildNotification,
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
import { severityIconPath } from "../src/notify/icons.js";
import { WINDOWS_TOAST_STARTUP_MS, windowsToastArguments } from "../src/notify/windows-toast.js";
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

// --- Libellé dérivé de l'issue réelle du hook ---------------------------------

test("the notification title states what actually happened, not the severity", () => {
  const root = path.join(os.tmpdir(), "boutique-en-ligne");
  const blocked = buildNotification(root, event("e1", "RED"), config(), true);
  assert.equal(blocked.title, "DriftLight · boutique-en-ligne — action bloquée");
  assert.doesNotMatch(blocked.message, /DriftLight (approve|reject)/);

  const observed = buildNotification(root, event("e1", "RED"), config(), false);
  assert.doesNotMatch(
    observed.title,
    /bloqu/,
    "claiming the action was blocked while the agent keeps working would be a lie",
  );
  assert.match(observed.title, /alerte rouge/);
  assert.doesNotMatch(observed.message, /DriftLight approve/);

  for (const notification of [blocked, observed]) {
    assert.match(notification.message, /src\/secret\.ts/);
  }
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
  assert.match(notifier.sent[0]?.title ?? "", /action bloquée$/);
  assert.doesNotMatch(notifier.sent[1]?.title ?? "", /bloqu/);
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
    notifier.sent.every((notification) => /action bloquée$/.test(notification.title)),
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
    title: "DriftLight — action bloquée",
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
    assert.equal(header.readUInt32BE(16), 128);
  }
  assert.equal(severityIconPath("GREEN"), undefined, "le vert ne notifie jamais");
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
