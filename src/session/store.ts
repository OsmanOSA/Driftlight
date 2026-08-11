import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionRecord } from "../domain/types.js";
import { safeIdentifier } from "../shared/paths.js";
import { projectStatePath } from "../shared/state-paths.js";
import { writeJsonAtomic } from "../shared/atomic-write.js";
import { readJsonState } from "../shared/read-state.js";

/**
 * Les événements verts ne sont jamais affichés, mais ils ne sont pas du déchet :
 * ce sont eux qui donnent le dénominateur du taux d'alerte, donc la seule
 * mesure honnête d'une calibration. On les borne au lieu de les jeter — les
 * plus récents suffisent à mesurer, et les alertes sont toujours conservées
 * intégralement.
 */
const RETAINED_GREEN_EVENTS = 300;

export function boundSessionHistory(session: SessionRecord): SessionRecord {
  const green = session.events.filter((event) => event.level === "GREEN");
  if (green.length <= RETAINED_GREEN_EVENTS) return session;
  const dropped = new Set(green.slice(0, green.length - RETAINED_GREEN_EVENTS));
  session.events = session.events.filter((event) => !dropped.has(event));
  return session;
}

export class SessionStore {
  private readonly sessionsDirectory: string;

  public constructor(private readonly root: string) {
    this.sessionsDirectory = projectStatePath(root, "sessions");
  }

  public sessionPath(id: string): string {
    return path.join(this.sessionsDirectory, `${safeIdentifier(id)}.json`);
  }

  public async save(session: SessionRecord): Promise<void> {
    await writeJsonAtomic(this.sessionPath(session.id), boundSessionHistory(session));
  }

  public async load(id: string): Promise<SessionRecord | null> {
    return await readJsonState<SessionRecord>(this.sessionPath(id));
  }

  public async latest(): Promise<SessionRecord | null> {
    const sessions = await this.list();
    return sessions[0] ?? null;
  }

  public async list(): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionsDirectory);
    } catch {
      // Répertoire absent ou illisible : aucune session à présenter.
      return [];
    }

    const candidates = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => ({
          name,
          stat: await fs.stat(path.join(this.sessionsDirectory, name)),
        })),
    );
    candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    const loaded = await Promise.all(
      candidates.map(async (candidate) =>
        await readJsonState<SessionRecord>(path.join(this.sessionsDirectory, candidate.name))),
    );
    // Une seule session illisible ne doit pas rendre l'historique entier muet.
    return loaded.filter((session): session is SessionRecord => session !== null);
  }
}
