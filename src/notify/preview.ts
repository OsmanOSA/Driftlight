import type { Severity } from "../domain/types.js";
import type { NativeNotification } from "./backend.js";
import { severityIconPath } from "./icons.js";

/**
 * Alerte d'exemple, pour juger de la forme d'une notification.
 *
 * Elle ne décrit aucun événement réel : le fichier est inventé, la demande
 * aussi, et aucun hook n'a été consulté. Elle doit donc le dire.
 *
 * Une notification d'aperçu qui annonce « action refusée » alors que l'agent
 * continue de travailler apprend à l'utilisateur que cette phrase peut être
 * fausse — et c'est précisément la phrase qui doit rester digne de foi quand
 * elle sort d'un vrai verdict. Le même piège avait déjà coûté un titre à ce
 * projet ; le reproduire dans un aperçu le rendrait simplement plus discret.
 *
 * Elle n'est pas non plus persistante : une notification ne reste à l'écran que
 * lorsqu'elle attend une décision, et un aperçu n'en attend aucune. Elle
 * s'efface seule, mais se laisse survoler tant qu'on la regarde.
 */
export function previewNotification(level: Severity): NativeNotification {
  const icon = severityIconPath(level);
  const shape = level === "RED"
    ? { meta: "Alerte rouge · 2 signaux concordants", body: "Ce contenu n'existe nulle part ailleurs." }
    : { meta: "À vérifier · 1 signal", body: "Rien n'est retenu : l'agent poursuit." };
  return {
    title: "DriftLight · aperçu — exemple d'alerte",
    message: `Aperçu : ${shape.meta}\n`
      + "Réécriture d'un fichier contenant du travail non sauvegardé : src/exemple.ts\n"
      + "Aucune action n'a été évaluée.",
    detail: {
      verb: "Réécriture",
      headline: "Fichier contenant du travail non sauvegardé",
      evidence: "src/exemple.ts",
      meta: shape.meta,
      intent: "« Corrige la faute de frappe dans src/app.ts »",
      action: shape.body,
      // Aucun verdict : il n'y a rien à refuser ni à confirmer.
      status: "Aperçu — aucune action n'a été évaluée",
    },
    level,
    sound: true,
    attribution: "DriftLight — voyant local de dérive",
    // Étiquette stable : un nouvel aperçu remplace le précédent au lieu de
    // s'empiler avec lui.
    tag: "driftlight-notification-preview",
    ...(icon ? { icon } : {}),
  };
}
