#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCodexHookBridge } from "./hook-bridge.js";
import { projectStateDirectory } from "../../shared/state-paths.js";
import { writeJsonAtomic } from "../../shared/atomic-write.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function writeStdout(value: string): Promise<void> {
  if (!value) return;
  await new Promise<void>((resolve) => {
    process.stdout.write(value, () => resolve());
  });
}

interface DiagnosticEnvelope {
  cwd: string;
  hook_event_name: string;
}

type HookHealthStatus = "RECEIVED" | "DELIVERED" | "IGNORED" | "FAILED_OPEN";

function diagnosticEnvelope(rawInput: string): DiagnosticEnvelope | null {
  try {
    const value = JSON.parse(rawInput) as Record<string, unknown>;
    return typeof value.cwd === "string" && typeof value.hook_event_name === "string"
      ? { cwd: value.cwd, hook_event_name: value.hook_event_name }
      : null;
  } catch {
    return null;
  }
}

async function writeHealthTrace(
  rawInput: string,
  delivered: number,
  diagnosticMessage?: string,
  statusOverride?: HookHealthStatus,
): Promise<void> {
  const envelope = diagnosticEnvelope(rawInput);
  if (!envelope) return;
  const directory = projectStateDirectory(envelope.cwd);
  const target = path.join(directory, "codex-hook-health.json");
  const status = statusOverride ?? (diagnosticMessage
    ? "FAILED_OPEN"
    : delivered > 0
      ? "DELIVERED"
      : "IGNORED");
  await writeJsonAtomic(target, {
    schemaVersion: 1,
    eventName: envelope.hook_event_name,
    receivedAt: new Date().toISOString(),
    delivered,
    status,
    ...(diagnosticMessage ? { diagnostic: diagnosticMessage } : {}),
  });
}

async function main(): Promise<void> {
  let rawInput = "";
  let diagnosticMessage: string | undefined;
  try {
    rawInput = await readStdin();
    // Cette trace est Ã©crite avant toute remise au Core : si Codex interrompt
    // ensuite le processus, on sait au moins que le hook a bien Ã©tÃ© lancÃ©.
    await writeHealthTrace(rawInput, 0, undefined, "RECEIVED").catch(() => undefined);
    const result = await runCodexHookBridge(rawInput, {
      debugLog: (message: string): void => {
        diagnosticMessage = message;
        if (process.env.DRIFTLIGHT_DEBUG_HOOKS === "1") process.stderr.write(`${message}\n`);
      },
    });
    await writeStdout(result.stdout);
    await writeHealthTrace(rawInput, result.delivered, diagnosticMessage).catch(() => undefined);
  } catch {
    // Ultime garde fail-open : le hook ne doit jamais casser Codex.
    await writeHealthTrace(rawInput, 0, "DriftLight Codex hook: unexpected bridge failure.").catch(() => undefined);
  }
  // Une notification Windows vit dans un processus dÃ©tachÃ©. `unref()` ne
  // suffit pas toujours lorsque Codex lance le hook dans un job Windows : le
  // handle enfant peut garder Node vivant jusqu'Ã  la fermeture du toast et
  // faire expirer PreToolUse. Tout le travail critique et stdout sont terminÃ©s
  // ici ; une sortie explicite remet immÃ©diatement le verdict Ã  Codex.
  process.exit(0);
}

void main().catch(() => {
  // Une erreur inattendue, y compris pendant la lecture de stdin, reste fail-open.
  process.exit(0);
});
