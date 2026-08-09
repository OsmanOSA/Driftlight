import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureGitBaseline } from "../src/git/baseline.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

test("captures branch, commit, modified, untracked and deleted files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-git-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.email", "driftlight@example.test"]);
  git(root, ["config", "user.name", "DriftLight Test"]);
  await fs.writeFile(path.join(root, "modified.txt"), "initial\n");
  await fs.writeFile(path.join(root, "deleted.txt"), "initial\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  await fs.writeFile(path.join(root, "modified.txt"), "user work\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "notes\n");
  await fs.rm(path.join(root, "deleted.txt"));

  const baseline = await captureGitBaseline(root);
  assert.equal(baseline.isGit, true);
  assert.ok(baseline.branch);
  assert.equal(baseline.commit, git(root, ["rev-parse", "HEAD"]));
  assert.equal(baseline.files.find((file) => file.path === "modified.txt")?.kind, "modified");
  assert.equal(baseline.files.find((file) => file.path === "untracked.txt")?.kind, "untracked");
  assert.equal(baseline.files.find((file) => file.path === "deleted.txt")?.kind, "deleted");
  assert.ok(baseline.files.find((file) => file.path === "modified.txt")?.headHash);
});

test("returns an explicit non-Git baseline without mutating the directory", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driftlight-nogit-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const baseline = await captureGitBaseline(root);
  assert.equal(baseline.isGit, false);
  assert.equal(baseline.files.length, 0);
});
