import assert from "node:assert/strict";
import test from "node:test";
import {
  configureCodexNativeApprovals,
  hasCodexNativeApprovals,
  restoreCodexNativeApprovals,
} from "../src/adapters/codex/native-approvals.js";

const configPath = "C:\\Users\\Ada\\.codex\\config.toml";

test("Codex: une config absente reçoit la politique d'approbation native", () => {
  const configured = configureCodexNativeApprovals("", configPath, false);
  assert.equal(hasCodexNativeApprovals(configured.source), true);
  assert.match(configured.source, /^approval_policy = "untrusted"$/m);
  assert.match(configured.source, /^approvals_reviewer = "user"$/m);

  const restored = restoreCodexNativeApprovals(configured.source, configured.state);
  assert.equal(restored.source, "");
});

test("Codex: les réglages et sections tiers sont préservés puis restaurés", () => {
  const original = [
    "model = \"gpt-5.6-sol\"",
    "approval_policy = \"on-request\"",
    "approvals_reviewer = \"auto_review\"",
    "",
    "[projects.'D:\\\\work']",
    "trust_level = \"trusted\"",
    "",
  ].join("\n");
  const configured = configureCodexNativeApprovals(original, configPath, true);
  assert.equal(hasCodexNativeApprovals(configured.source), true);
  assert.match(configured.source, /model = "gpt-5\.6-sol"/);
  assert.match(configured.source, /\[projects\.'D:\\\\work'\]/);

  const restored = restoreCodexNativeApprovals(configured.source, configured.state);
  assert.equal(restored.source, original);
});

test("Codex: Connect répété est idempotent et ne duplique aucune clé", () => {
  const first = configureCodexNativeApprovals("model = \"gpt-5.6-sol\"\n", configPath, true);
  const second = configureCodexNativeApprovals(first.source, configPath, true, first.state);
  assert.equal(second.source, first.source);
  assert.equal(second.changed, false);
  assert.equal((second.source.match(/^approval_policy\s*=/gm) ?? []).length, 1);
  assert.equal((second.source.match(/^approvals_reviewer\s*=/gm) ?? []).length, 1);
});

test("Codex: un choix utilisateur postérieur n'est ni repris ni annulé", () => {
  const first = configureCodexNativeApprovals("", configPath, false);
  const userEdited = first.source.replace(
    'approval_policy = "untrusted"',
    'approval_policy = "never"',
  );
  const repeated = configureCodexNativeApprovals(userEdited, configPath, true, first.state);
  assert.equal(repeated.source, userEdited);

  const restored = restoreCodexNativeApprovals(repeated.source, repeated.state);
  assert.match(restored.source, /^approval_policy = "never"$/m);
  assert.doesNotMatch(restored.source, /^approvals_reviewer\s*=/m);
});
