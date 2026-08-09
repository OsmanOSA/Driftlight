import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("dist", "test");
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(directory, name));

if (files.length === 0) {
  console.error("No compiled tests found in dist/test.");
  process.exitCode = 1;
} else {
  // NODE_ENV=test coupe les notifications système à la racine : les tests
  // d'intégration invoquent le vrai binaire et ne doivent jamais faire surgir
  // de toast sur la machine qui exécute la suite.
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  process.exitCode = result.status ?? 1;
}
