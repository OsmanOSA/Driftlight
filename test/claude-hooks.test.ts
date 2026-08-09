import assert from "node:assert/strict";
import test from "node:test";
import { mergeClaudeHookSettings } from "../src/claude/installer.js";

test("Claude hook installer preserves existing hooks and uses exec form", () => {
  const existing = {
    hooks: {
      Notification: [{ matcher: "", hooks: [{ type: "command", command: "notify" }] }],
    },
    permissions: { allow: ["Read"] },
  };
  const handler = {
    type: "command" as const,
    command: "node",
    args: ["/tool/driftlight.js", "hook"],
    timeout: 10,
    statusMessage: "DriftLight observe localement…",
  };

  const merged = mergeClaudeHookSettings(existing, handler);
  assert.deepEqual(merged.permissions, { allow: ["Read"] });
  assert.ok(Array.isArray(merged.hooks?.Notification));
  assert.ok(Array.isArray(merged.hooks?.SessionStart));
  assert.ok(Array.isArray(merged.hooks?.PreToolUse));
  assert.ok(Array.isArray(merged.hooks?.PostToolUse));
  assert.ok(Array.isArray(merged.hooks?.FileChanged));
  assert.ok(Array.isArray(merged.hooks?.SessionEnd));

  mergeClaudeHookSettings(merged, handler);
  const groups = merged.hooks?.PreToolUse as Array<{ hooks: unknown[] }>;
  assert.equal(groups[0]?.hooks.length, 1, "reinstall must not duplicate the handler");
});
