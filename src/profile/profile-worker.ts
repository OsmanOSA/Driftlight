import path from "node:path";
import { loadScoringConfigSync } from "../config/scoring-config.js";
import { scanRepository } from "../observer/snapshot.js";
import { buildRepoProfile } from "./repo-profile.js";

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) return;
  const resolved = path.resolve(root);
  const snapshot = await scanRepository(resolved);
  await buildRepoProfile(resolved, snapshot, loadScoringConfigSync(resolved));
}

void main().catch(() => {
  // Tâche d'observation fail-open : aucune erreur ne remonte au hook parent.
});
