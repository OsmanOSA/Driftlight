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
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
