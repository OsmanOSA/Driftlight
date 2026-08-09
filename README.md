# DriftLight

DriftLight est un voyant local qui compare la demande donnée à un coding agent avec les fichiers réellement touchés. Cette tranche observe, explique et demande une confirmation avant les actions rouges de Claude Code ; elle ne restaure jamais le worktree.

## Garanties de cette version

- exécution et historique entièrement locaux ;
- aucun compte, serveur DriftLight, abonnement ou télémétrie ;
- aucun code, prompt, diff ou chemin envoyé sur le réseau ;
- aucune commande de rollback ou de nettoyage exécutée ;
- détection des créations, modifications et suppressions ;
- protection renforcée des changements présents avant la session ;
- classifieur déterministe à score cumulé, toujours rendu en `GREEN | ORANGE | RED` ;
- confirmation Claude Code sur rouge par défaut, sans exécution destructive automatique ;
- notification système sur rouge, plafonnée et dédupliquée, jamais bloquante ;
- titre du terminal reflétant le statut, restauré en fin de session ;
- aucun affichage pour les événements verts.

DriftLight ignore son propre dossier `.driftlight/`, ainsi que les sorties volumineuses habituelles (`node_modules/`, `dist/`, `coverage/`, etc.). L'historique conserve des chemins, des métadonnées et des empreintes SHA-256, jamais le contenu des fichiers.

## Prérequis et installation

- Node.js 20 ou plus récent ;
- Git disponible dans le `PATH` pour les protections de baseline ;
- Claude Code 2.1.211 ou plus récent pour garantir que `ask` force aussi la confirmation en mode auto/full-approve.

```bash
npm install
npm run build
```

Sous PowerShell, si la politique d'exécution bloque `npm.ps1`, utilisez simplement `npm.cmd install` et `npm.cmd run build`.

Pendant le développement, lancez le CLI avec `node dist/src/cli.js`. Après installation comme paquet, la commande est `driftlight`.

## Démonstration locale minimale

Dans un dépôt Git de test, ouvrez un premier terminal :

```bash
node D:/Driftlight/dist/src/cli.js start --task "Fix the typo in README" --cwd D:/mon-projet
```

Dans un second terminal, modifiez successivement une dépendance directe du fichier nommé dans la tâche, un fichier JS/TS non connecté, puis un fichier correspondant à un motif sensible du profil. DriftLight affiche un signal concis et écrit la session sous `D:/mon-projet/.driftlight/sessions/`. Arrêtez proprement avec `Ctrl+C`.

Exemples de lecture et d'acquittement :

```bash
node D:/Driftlight/dist/src/cli.js status --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js explain event-123 --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js mark event-123 --noise --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js mark event-456 --useful --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js mark-expected event-123 --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js add-scope "La configuration Vite fait partie de la tâche" --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js ack --cwd D:/mon-projet
```

`explain` affiche, pour chaque signal, la valeur brute, le poids, la contribution et son éventuelle indisponibilité. `mark --noise|--useful` qualifie ensuite une alerte orange ou rouge pour calibrer DriftLight localement. Les événements verts restent dans le journal JSON mais ne sont jamais affichés. `Mark as expected` acquitte seulement l'événement choisi. `Add to task scope` enrichit le fichier d'intention courant. `ack` remet à zéro le statut persistant utilisable plus tard par une statusline.

## Intégration Claude Code

Le format est aligné sur la documentation officielle actuelle de Claude Code : commandes en forme `command` + `args`, JSON reçu sur stdin, et événements `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `FileChanged`, `Stop` et `SessionEnd`.

Installez les hooks dans le dépôt à observer :

```bash
node D:/Driftlight/dist/src/cli.js claude install --cwd D:/mon-projet
```

L'installation fusionne les entrées dans `.claude/settings.local.json` sans remplacer les hooks existants. Vérifiez-les avec `/hooks` dans Claude Code.

Le hook `PreToolUse` classe les écritures et commandes proposées. Sur rouge, il renvoie `permissionDecision: "ask"` : Claude Code suspend l'action dans son dialogue de permission jusqu'à la réponse de l'utilisateur. L'orange est seulement journalisé par défaut. `PostToolUse` enregistre aussi les fichiers lus par l'agent, puis `PostToolUse` et `FileChanged` mettent l'historique à jour à partir de l'état réel du disque. Le hook `Stop` affiche uniquement les alertes orange et rouges du tour qui se termine.

Les hooks joignent par ailleurs un champ `terminalSequence` à leur réponse pour le titre du terminal (voir plus bas). Ce champ est purement additif : il ne retient jamais une action, et une version de Claude Code qui ne le connaîtrait pas l'ignore sans conséquence.

Chaque `UserPromptSubmit` écrit atomiquement `.driftlight/current-intent.json`. Le classifieur relit directement ce fichier au moment de chaque décision, sans propagation entre processus. Un fichier explicitement nommé est donc exempté, y compris s'il est sensible.

La protection du travail Git préexistant ne signale plus le simple fait de continuer un fichier déjà modifié. Elle exige simultanément une baseline non commitée, un fichier hors intention et non lu pendant le tour, ainsi qu'une opération destructive : suppression, `Write` complet, édition sans aucune lecture antérieure dans la session ou suppression nette importante de lignes. Une seule alerte est conservée par fichier et par tour.

La configuration locale facultative se trouve dans `.driftlight/config.json` :

```json
{
  "blockOnRed": true,
  "blockOnOrange": false,
  "largeLineDeletionThreshold": 50,
  "notifyOnRed": true,
  "notifyOnOrange": false,
  "notificationSound": true,
  "terminalTitle": true
}
```

| Clé | Défaut | Effet |
| --- | --- | --- |
| `blockOnRed` | `true` | Le rouge passe par le dialogue de confirmation de Claude Code. |
| `blockOnOrange` | `false` | S'il est activé, l'orange déclenche lui aussi la confirmation. |
| `largeLineDeletionThreshold` | `50` | Lignes supprimées nettes à partir desquelles l'édition est jugée destructive. |
| `notifyOnRed` | `true` | Notification système sur rouge. |
| `notifyOnOrange` | `false` | Notification système sur orange. |
| `notificationSound` | `true` | Son accompagnant la notification. |
| `terminalTitle` | `true` | Mise à jour du titre du terminal. |

**Aucun de ces réglages ne désactive la classification.** Ils ne touchent qu'à la restitution : un événement non notifié et non bloquant reste intégralement classé, journalisé et visible dans `status`, `explain` et le résumé `Stop`.

## Notifications natives

Le rouge déclenche une notification système avec son, dont le corps porte le chemin du fichier et la règle déclenchée. L'orange est enregistré sans notifier : passez `notifyOnOrange` à `true` pour l'activer. Le vert ne notifie jamais.

Le titre décrit l'issue réelle du hook, pas la sévérité seule :

| Issue | Titre |
| --- | --- |
| Le hook a effectivement renvoyé un refus (`permissionDecision` retenant l'action) | `DriftLight — action bloquée` |
| L'événement est enregistré, l'agent poursuit | `DriftLight — modification détectée` |

Un verdict rouge ne bloque que si `blockOnRed` est actif. Annoncer « action bloquée » pendant que l'agent continue de travailler serait un faux voyant, c'est-à-dire exactement ce que DriftLight prétend éviter.

### Anti-bruit

Le registre `.driftlight/notified-events.json` est persisté, car chaque hook s'exécute dans un processus neuf : toute déduplication en mémoire serait perdue d'un événement au suivant. Trois garde-fous s'appliquent dans l'ordre :

1. un `eventId` ne notifie **jamais** deux fois ;
2. un même couple **chemin + règle** reste silencieux pendant **10 minutes** ;
3. une session ne dépasse pas **3 notifications**. Au-delà, les alertes sont comptées sans bruit et le total est repris dans le résumé du hook `Stop` : `🔕 4 notification(s) tue(s) par le plafond de session`. Les alertes elles-mêmes restent intégralement journalisées et listées — seul l'envoi système est plafonné.

Les compteurs repartent à zéro à chaque nouvelle session. Les entrées récentes, elles, survivent à un redémarrage : relancer une session ne rend pas la même alerte moins répétitive.

### Environnement

Aucune notification n'est émise si `NODE_ENV` vaut `test`, si `CI` est défini, ou si `DRIFTLIGHT_NO_NOTIFY` est présent — la simple définition de la variable suffit. `scripts/run-tests.mjs` force `NODE_ENV=test`, si bien que la suite peut invoquer le vrai binaire sans jamais faire surgir de notification sur la machine qui l'exécute. Les tests injectent un notificateur factice et vérifient les appels.

La couche s'appuie sur [`node-notifier`](https://www.npmjs.com/package/node-notifier) (SnoreToast sous Windows, NSUserNotification sous macOS, même code des deux côtés), déclaré en `optionalDependencies` et chargé dynamiquement. S'il est absent, cassé ou refusé par le système, DriftLight continue de classer et de bloquer normalement : la notification est un complément, jamais un point de défaillance. `toasted-notifier` est un fork à l'API identique ; en changer se limite à `BACKEND_MODULE` dans `src/notify/backend.ts` et `src/notify/notify-runner.ts`.

L'affichage est délégué à un processus détaché (`src/notify/notify-runner.ts`). La bibliothèque garde en effet son binaire d'affichage rattaché au processus appelant : sous Windows, SnoreToast maintient ce parent en vie pendant toute la durée du toast (~9 s mesurées) et meurt avec lui. Notifier depuis le hook lui-même coûterait donc plusieurs secondes par alerte, pour un timeout de hook fixé à 10 s. Avec le lanceur détaché, le hook rend son verdict en ~100 ms.

## Titre du terminal

Le titre reflète le statut courant via la séquence ANSI OSC 0, visible dans la barre des tâches même quand le terminal est en arrière-plan :

```
🔴 DriftLight — 1 alerte      🟠 DriftLight — 3 alertes      mon-projet
```

Le pictogramme suit la sévérité maximale depuis le dernier `ack`, le compte agrège orange et rouge, et le vert rend un titre neutre. `driftlight ack` remet immédiatement le titre au neutre.

Deux chemins d'émission, parce que les contraintes diffèrent.

**En mode hook**, le processus n'a pas de terminal de contrôle. DriftLight renvoie la séquence dans le champ `terminalSequence` et Claude Code l'émet via son propre chemin d'écriture — ce qui est sans course, fonctionne sous tmux et screen, et fonctionne sous Windows où `/dev/tty` n'existe pas. Ce champ n'accepte que les OSC `0/1/2/9/99/777` et BEL : **toute séquence hors allowlist fait ignorer le champ entier**. La pile de titres XTerm (`ESC [22;0t` / `ESC [23;0t`, du CSI) en est donc exclue, et `SessionEnd` rend explicitement le titre neutre du dépôt. La fonction `isTerminalSequenceAllowed` reproduit cette allowlist et est testée : une séquence refusée serait silencieusement ignorée, donc invisible en production.

**En mode CLI** (`driftlight start`), le processus possède son terminal : DriftLight écrit directement sur stdout, et la pile de titres redevient utilisable. La restauration émet d'abord le titre neutre puis le dépilement — les terminaux sans pile s'arrêtent sur le titre neutre, ceux qui la gèrent retrouvent le titre exact d'avant la session.

`terminalTitle: false` désactive complètement la fonction.

Le fichier `.driftlight/current-status.json` contient le niveau maximal depuis le dernier `ack`, les compteurs `GREEN`, `ORANGE` et `RED`, ainsi que l'horodatage du dernier événement. Il ne contient ni code, ni prompt, ni diff.

## Profil du dépôt et graphe d'import

Au démarrage d'une session, DriftLight construit une seule fois :

- `.driftlight/repo-profile.json` : nombre de commits, taux de modification, cooccurrences et sensibilité dérivée ;
- `.driftlight/import-graph.json` : imports statiques et dynamiques JavaScript/TypeScript, avec résolution relative et alias `tsconfig.paths`.

Le taux de modification est indisponible sous 50 commits. La cooccurrence est indisponible sous 100 commits. Ces signaux restent explicitement marqués indisponibles : aucune valeur synthétique ne les remplace. Le score renormalise les poids restants.

La sensibilité provient des motifs du `.gitignore` du projet et des expressions de secrets déclarées dans la configuration de score. Le code TypeScript ne contient plus de liste de chemins sensibles.

## Score cumulé

Les poids, les seuils et les courbes de normalisation sont dans le fichier versionné `driftlight.scoring.json`. Un projet observé peut fournir son propre fichier à sa racine ; sinon DriftLight charge celui livré avec le paquet.

Le score combine :

- distance au fichier ancre dans le graphe d'imports ;
- rareté historique du fichier ;
- cooccurrence avec les ancres ;
- lignes supprimées et nombre de fichiers touchés dans le tour ;
- sensibilité dérivée du dépôt ;
- forte contribution négative lorsque le fichier est explicitement nommé.

Les ancres sont les fichiers JS/TS nommés ou résolus depuis `.driftlight/current-intent.json`. Sans ancre résoluble, la distance et la cooccurrence sont indisponibles. Un fichier non connecté reçoit la valeur de risque définie par la configuration. Chaque événement conserve sa décomposition complète sous `scoreBreakdown`.

La protection destructive des changements non commités au démarrage reste une règle absolue, prioritaire et hors score. Elle ne peut pas être compensée par une contribution négative. Les commandes destructives restent elles aussi identifiées comme décisions absolues.

## Architecture

- `src/git/baseline.ts` — état Git initial, branche, commit et changements préexistants ;
- `src/observer/` — snapshot haché, diff et polling multiplateforme ;
- `src/classification/` — règles et implémentation du contrat `Classifier` ;
- `src/profile/` — profil Git, sensibilité dérivée et graphe d'import ;
- `src/intent/` — intention courante atomique, relue à chaque classification ;
- `src/config/` — options locales de confirmation, de notification et de titre ;
- `src/status/` — état persistant et acquittement ;
- `src/session/` — historique local atomique ;
- `src/claude/` — installation et traitement des hooks Claude Code ;
- `src/notify/` — adaptateur de notifications natives, registre anti-bruit persistant et lanceur détaché ;
- `src/ui/terminal.ts` — signal terminal compact et résumé du tour ;
- `src/ui/terminal-title.ts` — titre via OSC 0 : séquence rendue à Claude Code en mode hook, écriture directe et pile de titres en mode CLI ;
- `test/fixtures/` — tâches et dérives représentatives.

## Qualité

```bash
npm run lint
npm test
npm run build
```

Les tests d'intégration créent uniquement des dépôts temporaires et n'exécutent aucune commande destructive contre le dépôt surveillé.

Ils n'émettent pas non plus de notification système, alors même qu'ils invoquent le vrai binaire : `scripts/run-tests.mjs` force `NODE_ENV=test`, et un test échoue si cette garantie disparaît. Les tests de notification injectent un notificateur factice et vérifient les appels.

## Limites connues de cette tranche

- graphe limité à JavaScript/TypeScript et à l'analyse syntaxique locale des imports ;
- résolution d'intention fondée sur les chemins et noms de fichiers, sans juge LLM local ou distant ;
- watcher par polling, sans optimisation pour les monorepos massifs ;
- pas d'interface graphique, de diff interactif ou de lancement automatique de l'agent ;
- pas de rollback ni d'exécution automatique d'une commande destructive ;
- support agent explicite limité à Claude Code ;
- notifications validées sous Windows uniquement ; le chemin macOS partage le même code et la même API mais n'a pas été exécuté sur machine ;
- `node-notifier` n'a pas été publié depuis février 2022 et entraîne un avertissement `npm audit` *moderate* via `uuid@8`, non exploitable ici puisque seul `uuid.v4()` est appelé, sans argument `buf` ;
- la bibliothèque embarque des binaires d'affichage (`snoretoast` sous Windows, `terminal-notifier` sous macOS) : rien à installer séparément, mais ce n'est pas du JavaScript pur ;
- en mode hook, le titre exact d'avant la session ne peut pas être restauré — la pile de titres XTerm est hors allowlist — donc `SessionEnd` rend le nom du dépôt ;
- si Claude Code se termine sans émettre `SessionEnd`, le titre reste sur la dernière alerte jusqu'au prochain `driftlight ack`.
