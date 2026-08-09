import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ObservedChange } from "../src/domain/types.js";
import { PollingObserver } from "../src/observer/polling-observer.js";
import { scanRepository } from "../src/observer/snapshot.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for observer event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("polling observer reports creation, modification and deletion", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-observer-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "existing.txt"), "one\n");
  const initial = await scanRepository(root);
  assert.equal(initial.files["existing.txt"]?.lineCount, 1);
  const observer = new PollingObserver(root, initial, 40);
  const observed: ObservedChange[] = [];
  observer.start(({ changes }) => {
    observed.push(...changes);
  });
  context.after(() => observer.stop());

  await fs.writeFile(path.join(root, "created.txt"), "created\n");
  await waitFor(() => observed.some((change) => change.path === "created.txt" && change.kind === "created"));

  await fs.writeFile(path.join(root, "existing.txt"), "two\n");
  await waitFor(() => observed.some((change) => change.path === "existing.txt" && change.kind === "modified"));

  await fs.rm(path.join(root, "created.txt"));
  await waitFor(() => observed.some((change) => change.path === "created.txt" && change.kind === "deleted"));

  assert.deepEqual(
    observed.filter((change) => change.path === "created.txt").map((change) => change.kind),
    ["created", "deleted"],
  );
});

test("observer excludes its own history and dependency output", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-observer-exclude-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".driftlight", "sessions"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, ".driftlight", "sessions", "one.json"), "{}");
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1");
  const snapshot = await scanRepository(root);
  assert.deepEqual(Object.keys(snapshot.files), []);
});
