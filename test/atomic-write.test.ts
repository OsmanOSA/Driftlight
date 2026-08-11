import assert from "node:assert/strict";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from "../src/shared/atomic-write.js";

async function directory(context: test.TestContext): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-atomic-"));
  context.after(async () => await fs.rm(created, { recursive: true, force: true }));
  return created;
}

const temporaries = (root: string): string[] =>
  readdirSync(root).filter((name) => name.endsWith(".tmp"));

test("an atomic write creates the target and leaves no temporary behind", async (context) => {
  const root = await directory(context);
  const target = path.join(root, "state.json");

  await writeJsonAtomic(target, { level: "GREEN" });
  assert.equal(await fs.readFile(target, "utf8"), '{\n  "level": "GREEN"\n}\n');

  writeJsonAtomicSync(target, { level: "RED" });
  assert.equal(JSON.parse(await fs.readFile(target, "utf8")).level, "RED");

  assert.deepEqual(temporaries(root), [], "aucun .tmp ne subsiste après un succès");
});

test("missing parent directories are created", async (context) => {
  const root = await directory(context);
  const nested = path.join(root, "projects", "app", "sessions", "one.json");

  await writeJsonAtomic(nested, { id: "one" });
  assert.ok(existsSync(nested));

  writeFileAtomicSync(path.join(root, "autre", "note.txt"), "contenu");
  assert.equal(await fs.readFile(path.join(root, "autre", "note.txt"), "utf8"), "contenu");
});

/**
 * Régression : le temporaire n'était supprimé que dans deux des dix
 * implémentations, et des `.tmp` orphelins s'accumulaient à côté de leur cible.
 * Ici la cible est un répertoire, ce qui fait échouer le renommage à coup sûr.
 */
test("a failed rename removes its temporary instead of orphaning it", async (context) => {
  const root = await directory(context);
  const target = path.join(root, "occupied");
  await fs.mkdir(path.join(target, "child"), { recursive: true });

  await assert.rejects(async () => await writeFileAtomic(target, "contenu"));
  assert.deepEqual(temporaries(root), [], "le temporaire est nettoyé après échec");

  assert.throws(() => writeFileAtomicSync(target, "contenu"));
  assert.deepEqual(temporaries(root), [], "y compris sur le chemin synchrone");
});

/**
 * Chaque hook s'exécute dans un processus neuf et plusieurs peuvent écrire le
 * même fichier. Le PID seul ne distinguait pas deux écritures concurrentes
 * lancées par un même processus, et Windows refuse transitoirement un
 * renommage vers une cible qu'un autre écrivain vient d'ouvrir.
 */
test("concurrent writes to one target do not collide", async (context) => {
  const root = await directory(context);
  const target = path.join(root, "contended.json");

  await Promise.all(
    Array.from({ length: 24 }, (_, index) => writeJsonAtomic(target, { writer: index })),
  );

  assert.deepEqual(temporaries(root), [], "aucun temporaire résiduel");
  const written = JSON.parse(await fs.readFile(target, "utf8")) as { writer: number };
  assert.ok(
    Number.isInteger(written.writer),
    "le fichier final est celui d'un écrivain, jamais un mélange de deux",
  );
});
