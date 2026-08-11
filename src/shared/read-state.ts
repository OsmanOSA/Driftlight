import { readFileSync, promises as fs } from "node:fs";

/**
 * Politique de lecture de l'état local : illisible vaut absent.
 *
 * Tout ce que DriftLight écrit sous `~/.driftlight` est reconstructible — un
 * profil se recalcule, un graphe se réindexe, une intention se réécrit au
 * prochain prompt. Laisser une exception remonter ferait tomber le hook entier
 * et éteindrait le voyant complètement, alors qu'il suffit de perdre un signal.
 *
 * Un fichier tronqué par un arrêt brutal, un JSON à moitié écrit par une
 * version antérieure, un droit d'accès refusé : dans tous ces cas DriftLight
 * doit continuer d'observer, avec moins de contexte plutôt qu'avec rien.
 */
export function readJsonStateSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readJsonState<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
