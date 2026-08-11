import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnose } from "../src/status/doctor.js";
import {
  listProjects,
  projectsDirectory,
  purgeVanishedProjects,
  sweepStaleTemporaries,
} from "../src/status/projects.js";
import { PROJECT_MARKER } from "../src/shared/state-paths.js";

/**
 * L'état s'accumule sur la machine à mesure qu'on ouvre des projets. Rien ne
 * permettait de le voir ni de le reprendre : un dépôt supprimé laissait son
 * historique indéfiniment, sans moyen de savoir à quoi il correspondait.
 */

async function stateFor(
  context: test.TestContext,
  slug: string,
  options: { root?: string; sessionCwd?: string; degraded?: string } = {},
): Promise<string> {
  const directory = path.join(projectsDirectory(), slug);
  await fs.mkdir(path.join(directory, "sessions"), { recursive: true });
  context.after(async () => await fs.rm(directory, { recursive: true, force: true }));

  if (options.root) {
    await fs.writeFile(
      path.join(directory, PROJECT_MARKER),
      JSON.stringify({ root: options.root, adoptedAt: new Date().toISOString() }),
    );
  }
  if (options.sessionCwd) {
    await fs.writeFile(
      path.join(directory, "sessions", "one.json"),
      JSON.stringify({ id: "one", cwd: options.sessionCwd, events: [] }),
    );
  }
  if (options.degraded) {
    await fs.writeFile(
      path.join(directory, "hook-health.json"),
      JSON.stringify({ schemaVersion: 1, degraded: options.degraded }),
    );
  }
  return directory;
}

test("a project whose repository is gone is reported, and only that one is purged", async (context) => {
  const alive = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-alive-"));
  context.after(async () => await fs.rm(alive, { recursive: true, force: true }));
  const aliveState = await stateFor(context, "alive-test0001", { root: alive });
  const goneState = await stateFor(context, "gone-test0002", {
    root: path.join(os.tmpdir(), "driftlight-supprime-il-y-a-longtemps"),
  });

  const listed = await listProjects();
  assert.equal(listed.find((item) => item.directory === aliveState)?.present, true);
  assert.equal(listed.find((item) => item.directory === goneState)?.present, false);

  const purged = await purgeVanishedProjects();
  assert.ok(purged.some((item) => item.directory === goneState));
  assert.equal(existsSync(goneState), false, "l'état d'un dépôt disparu est libéré");
  assert.equal(existsSync(aliveState), true, "un dépôt vivant n'est jamais touché");
});

/**
 * L'empreinte d'un chemin n'est pas réversible. Sans récupération, un dossier
 * privé de son marqueur resterait inattribuable — et donc impurgeable — pour
 * toujours.
 */
test("a missing marker is recovered from the session history", async (context) => {
  const gone = path.join(os.tmpdir(), "driftlight-disparu-sans-marqueur");
  const directory = await stateFor(context, "recover-test0003", { sessionCwd: gone });

  const [recovered] = (await listProjects()).filter((item) => item.directory === directory);
  assert.equal(recovered?.root, gone, "la racine est retrouvée dans l'historique");
  assert.equal(recovered?.present, false);

  const marker = JSON.parse(await fs.readFile(path.join(directory, PROJECT_MARKER), "utf8")) as { root: string };
  assert.equal(marker.root, gone, "le marqueur est réparé, la question ne se repose plus");
});

/**
 * Ne rien savoir n'est pas savoir qu'il n'y a rien : un dossier dont on ne peut
 * pas établir l'origine doit survivre à la purge.
 */
test("a project that cannot be attributed is kept, never purged", async (context) => {
  const directory = await stateFor(context, "opaque-test0004");

  const [opaque] = (await listProjects()).filter((item) => item.directory === directory);
  assert.equal(opaque?.root, null);
  assert.equal(opaque?.present, true, "l'ignorance ne vaut pas absence");

  await purgeVanishedProjects();
  assert.equal(existsSync(directory), true);
});

test("a dry run reports without removing anything", async (context) => {
  const directory = await stateFor(context, "dryrun-test0005", {
    root: path.join(os.tmpdir(), "driftlight-absent-dryrun"),
  });

  const preview = await purgeVanishedProjects({ dryRun: true });
  assert.ok(preview.some((item) => item.directory === directory));
  assert.equal(existsSync(directory), true, "un aperçu ne supprime rien");
});

test("stale temporaries left by an interrupted write are swept", async (context) => {
  const directory = await stateFor(context, "sweep-test0006", { root: os.tmpdir() });
  const orphan = path.join(directory, "import-graph.json.1234.abcd.tmp");
  await fs.writeFile(orphan, "{ interrompu");
  await fs.writeFile(path.join(directory, "import-graph.json"), "{}");

  const removed = await sweepStaleTemporaries();
  assert.ok(removed.includes(orphan));
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(path.join(directory, "import-graph.json")), true, "la cible est intacte");
});

test("the doctor surfaces what fail-open deliberately hides", async (context) => {
  await stateFor(context, "degraded-test0007", { root: os.tmpdir(), degraded: "error" });

  const checks = await diagnose(process.cwd());
  const health = checks.find((check) => check.label === "Santé des hooks");
  assert.equal(health?.status, "warn");
  assert.match(health?.detail ?? "", /degraded-test0007/);
  assert.ok(health?.remedy, "un avertissement sans remède n'aide personne");

  // Le diagnostic doit rester lisible sans dépôt : il sert justement à
  // comprendre pourquoi DriftLight ne dit rien.
  const outside = await diagnose(os.tmpdir());
  assert.ok(outside.some((check) => check.label === "Dépôt observé"));
});
