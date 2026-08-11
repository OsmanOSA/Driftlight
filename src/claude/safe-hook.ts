import type { ClaudeHookInput } from "../domain/types.js";
import { handleClaudeHook } from "./handler.js";

/**
 * Filet de sécurité au point d'entrée du processus.
 *
 * DriftLight est un voyant, pas un garde-barrière. Il peut se tromper de
 * couleur ; il ne peut pas empêcher de travailler. Une exception, un disque
 * plein, un JSON inattendu ou une régression de notre part doivent produire un
 * silence complet et une sortie normale — jamais une erreur remontée à l'agent,
 * jamais une action retenue par accident.
 *
 * Conséquence assumée : une panne de DriftLight est invisible. C'est le bon
 * compromis pour un voyant, et `hookHealth` laisse la trace nécessaire pour
 * qu'un diagnostic reste possible après coup.
 */
export type HookDegradation = "invalid-input" | "timeout" | "error";

export interface SafeHookOutcome {
  /** Ce qu'il faut écrire sur stdout. Vide signifie « rien à dire ». */
  stdout: string;
  degraded?: HookDegradation;
  detail?: string;
}

/**
 * Budget volontairement inférieur au délai d'attente de Claude Code, qui est de
 * dix secondes. Être tué par l'hôte au milieu d'une écriture est pire que
 * rendre la main proprement un peu plus tôt sans verdict.
 */
export const HOOK_TIME_BUDGET_MS = 5_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInput(raw: string): ClaudeHookInput | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ClaudeHookInput;
  } catch {
    return null;
  }
}

export interface SafeHookOptions {
  budgetMs?: number;
  handler?: typeof handleClaudeHook;
}

export async function runHookSafely(
  raw: string,
  options: SafeHookOptions = {},
): Promise<SafeHookOutcome> {
  if (!raw.trim()) return { stdout: "" };

  const input = parseInput(raw);
  if (!input) return { stdout: "", degraded: "invalid-input" };

  const handler = options.handler ?? handleClaudeHook;
  const budget = options.budgetMs ?? HOOK_TIME_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;

  try {
    const outcome = await Promise.race([
      handler(input).then((value) => ({ kind: "done" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), budget);
        // Le minuteur ne doit pas maintenir le processus en vie à lui seul.
        timer.unref?.();
      }),
    ]);

    if (outcome.kind === "timeout") return { stdout: "", degraded: "timeout" };
    if (!outcome.value) return { stdout: "" };

    try {
      return { stdout: JSON.stringify(outcome.value) };
    } catch (error) {
      // Une réponse non sérialisable vaut absence de réponse : mieux vaut se
      // taire que d'écrire sur stdout un fragment que l'hôte ne saura pas lire.
      return { stdout: "", degraded: "error", detail: message(error) };
    }
  } catch (error) {
    return { stdout: "", degraded: "error", detail: message(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
