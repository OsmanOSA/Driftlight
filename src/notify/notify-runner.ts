/**
 * Processus détaché qui affiche une notification native, puis s'éteint.
 *
 * Il existe parce que la bibliothèque garde son processus d'affichage rattaché
 * au sien : sous Windows, SnoreToast meurt dès que son parent se termine, et
 * maintient ce parent en vie tant que le toast est affiché (~9 s mesurées).
 * Attendre depuis un hook Claude Code coûterait donc plusieurs secondes par
 * alerte, pour un timeout de hook fixé à 10 s.
 *
 * Ce lanceur est détaché du hook : celui-ci rend son verdict immédiatement,
 * pendant que la notification vit sa vie ici.
 */

interface NotifierLike {
  notify: (options: Record<string, unknown>, callback: (error: Error | null) => void) => unknown;
}

/** Filet de sécurité : ce processus ne doit jamais devenir orphelin permanent. */
const MAX_LIFETIME_MS = 60_000;

function isNotifierLike(value: unknown): value is NotifierLike {
  return typeof value === "object"
    && value !== null
    && typeof (value as NotifierLike).notify === "function";
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) return;

  const payload = JSON.parse(raw) as { title?: string; message?: string; sound?: boolean };
  const imported: unknown = await import("node-notifier");
  const notifier = isNotifierLike(imported) ? imported : (imported as { default?: unknown }).default;
  if (!isNotifierLike(notifier)) return;

  const guard = setTimeout(() => process.exit(0), MAX_LIFETIME_MS);

  notifier.notify(
    {
      title: payload.title ?? "DriftLight",
      message: payload.message ?? "",
      sound: payload.sound ?? true,
      wait: false,
    },
    () => {
      clearTimeout(guard);
      process.exit(0);
    },
  );
}

// Aucune sortie, aucun code d'erreur : personne n'écoute ce processus.
void main().catch(() => process.exit(0));
