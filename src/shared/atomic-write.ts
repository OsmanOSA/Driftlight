import { randomUUID } from "node:crypto";
import { mkdirSync, promises as fs, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Écriture atomique : un temporaire voisin, puis un renommage.
 *
 * Chaque hook s'exécute dans un processus neuf, et plusieurs peuvent écrire le
 * même fichier en même temps. Le nom du temporaire porte donc le PID *et* un
 * UUID : le seul PID ne suffit pas, un même processus enchaînant deux écritures
 * asynchrones du même fichier se marcherait dessus.
 *
 * Le temporaire est supprimé si le renommage échoue. Sans cela il subsiste
 * indéfiniment à côté de sa cible — c'est ainsi que des `.tmp` orphelins
 * s'étaient accumulés.
 */
function temporaryFor(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * Windows refuse transitoirement un renommage vers une cible qu'un autre
 * processus vient d'ouvrir, avec `EPERM`, `EACCES` ou `EBUSY`. Plusieurs hooks
 * écrivent le même fichier de statut en parallèle : sans réessai, l'un d'eux
 * échoue alors que rien n'est réellement en faute.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 6;

function transient(error: unknown, attempt: number): boolean {
  return attempt + 1 < RENAME_ATTEMPTS
    && TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

async function renameWithRetry(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      if (!transient(error, attempt)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
    }
  }
}

function renameWithRetrySync(temporary: string, target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      if (!transient(error, attempt)) throw error;
    }
  }
}

export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = temporaryFor(target);
  await fs.writeFile(temporary, contents, "utf8");
  try {
    await renameWithRetry(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeFileAtomicSync(target: string, contents: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = temporaryFor(target);
  writeFileSync(temporary, contents, "utf8");
  try {
    renameWithRetrySync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Le nettoyage est un mieux, jamais une condition de succès.
    }
    throw error;
  }
}

/** Sérialisation JSON indentée, terminée par un saut de ligne, écrite atomiquement. */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonAtomicSync(target: string, value: unknown): void {
  writeFileAtomicSync(target, `${JSON.stringify(value, null, 2)}\n`);
}
