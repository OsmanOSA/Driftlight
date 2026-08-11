import assert from "node:assert/strict";
import test from "node:test";
import { READ_TOOL_MATCHER, mergeClaudeHookSettings } from "../src/claude/installer.js";
import { CLAUDE_READ_TOOLS, isReadLikeTool } from "../src/intent/agent-context.js";

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
  assert.ok(Array.isArray(merged.hooks?.Stop));
  assert.ok(Array.isArray(merged.hooks?.SessionEnd));
  const postGroups = merged.hooks?.PostToolUse as Array<{ matcher?: string }>;
  assert.ok(postGroups.some((group) => group.matcher === READ_TOOL_MATCHER));

  mergeClaudeHookSettings(merged, handler);
  const groups = merged.hooks?.PreToolUse as Array<{ hooks: unknown[] }>;
  assert.equal(groups[0]?.hooks.length, 1, "reinstall must not duplicate the handler");
});

/**
 * Régression : le matcher n'a longtemps couvert que `Read`, alors que le Core
 * traite aussi Grep et Glob. Leurs lectures n'étaient jamais livrées, et chaque
 * fichier trouvé par recherche comptait comme « jamais lu ».
 */
test("every read-like tool the core understands is actually delivered by a hook", () => {
  const merged = mergeClaudeHookSettings({}, {
    type: "command" as const,
    command: "node",
    args: ["/tool/driftlight.js", "hook"],
    timeout: 10,
    statusMessage: "DriftLight observe localement…",
  });

  const matchers = (merged.hooks?.PostToolUse as Array<{ matcher?: string }>)
    .map((group) => group.matcher)
    .filter((matcher): matcher is string => typeof matcher === "string");

  for (const tool of CLAUDE_READ_TOOLS) {
    assert.ok(
      isReadLikeTool(tool),
      `${tool} est annoncé comme outil de lecture mais le Core ne le reconnaît pas`,
    );
    assert.ok(
      matchers.some((matcher) => new RegExp(`^(?:${matcher})$`).test(tool)),
      `${tool} est reconnu par le Core mais aucun hook PostToolUse ne le livre`,
    );
  }
});
