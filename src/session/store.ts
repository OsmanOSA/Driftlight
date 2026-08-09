import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionRecord } from "../domain/types.js";
import { safeIdentifier } from "../shared/paths.js";

export class SessionStore {
  private readonly sessionsDirectory: string;

  public constructor(private readonly root: string) {
    this.sessionsDirectory = path.join(root, ".driftlight", "sessions");
  }

  public sessionPath(id: string): string {
    return path.join(this.sessionsDirectory, `${safeIdentifier(id)}.json`);
  }

  public async save(session: SessionRecord): Promise<void> {
    await fs.mkdir(this.sessionsDirectory, { recursive: true });
    const target = this.sessionPath(session.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  }

  public async load(id: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.sessionPath(id), "utf8")) as SessionRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  public async latest(): Promise<SessionRecord | null> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionsDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
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
    const latest = candidates[0];
    if (!latest) return null;
    return JSON.parse(await fs.readFile(path.join(this.sessionsDirectory, latest.name), "utf8")) as SessionRecord;
  }
}
