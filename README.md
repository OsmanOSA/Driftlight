# DriftLight

DriftLight est un voyant local qui compare la demande donnée à un coding agent avec les fichiers réellement touchés. Cette tranche observe, explique et demande une confirmation avant les actions rouges de Claude Code ; elle ne restaure jamais le worktree.

## Garanties de cette version

- exécution et historique entièrement locaux ;
- aucun compte, serveur DriftLight, abonnement ou télémétrie ;
- aucun code, prompt, diff ou chemin envoyé sur le réseau ;
- aucune commande de rollback ou de nettoyage exécutée ;
- détection des créations, modifications et suppressions ;
- protection renforcée des changements présents avant la session ;
- classifieur déterministe en étages stricts, toujours rendu en `GREEN | ORANGE | RED` ;
- confirmation Claude Code sur rouge par défaut, sans exécution destructive automatique ;
- notification système sur rouge, plafonnée et dédupliquée, jamais bloquante ;
- titre du terminal reflétant le statut, restauré en fin de session ;
- aucun affichage pour les événements verts ;
- aucune panne de DriftLight ne peut retenir une action ni remonter une erreur à
  l'agent : une exception, un disque plein ou une entrée inattendue produisent un
  silence complet et une sortie normale, avec une trace locale dans
  `hook-health.json` pour le diagnostic ;
- un état local corrompu dégrade la précision sans éteindre le voyant : un profil
  ou un graphe illisible vaut absent, et la protection des secrets et du travail
  préexistant continue de s'appliquer.

DriftLight n'écrit rien dans les dépôts qu'il observe. L'état de chaque projet — sessions, intention courante, profil, graphe, journaux — vit sous `~/.driftlight/projects/<nom>-<empreinte>/`, hors du dépôt : rien n'apparaît dans votre `git status`, rien ne risque d'être commité par accident. Seul `.driftlight/config.json`, si vous en créez un, appartient au projet.

L'inventaire des fichiers suit les règles de `.gitignore` du projet : les répertoires entièrement ignorés (`node_modules/`, `.venv/`, `vendor/`, `target/`…) sont élagués sans être parcourus. Les *fichiers* ignorés restent observés — `.env` l'est dans presque tous les projets, et c'est précisément ce qu'il faut protéger. L'historique conserve des chemins, des métadonnées et des empreintes SHA-256, jamais le contenu des fichiers.

DriftLight n'observe qu'un dépôt Git. Hors dépôt, il reste entièrement silencieux et n'écrit rien.

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

Dans un second terminal, modifiez successivement une dépendance directe du fichier nommé dans la tâche, un fichier JS/TS non connecté, puis un fichier correspondant à un motif sensible du profil. DriftLight affiche un signal concis et écrit la session sous `~/.driftlight/projects/mon-projet-<empreinte>/sessions/`. Arrêtez proprement avec `Ctrl+C`.

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

## Voir et reprendre l'état de la machine

```bash
driftlight projects            # tous les projets observés, leur taille, leur activité
driftlight projects --purge    # libère l'état des dépôts qui n'existent plus
driftlight doctor              # diagnostic de l'installation courante
```

`projects` marque d'un `✗` les dossiers dont le dépôt a disparu. `--purge` ne
supprime que ceux-là : un projet simplement inactif garde son historique, car
l'ancienneté n'est pas une preuve d'abandon et l'historique est ce qui permet de
calibrer. Un dossier dont l'origine ne peut pas être établie n'est jamais
supprimé — ne rien savoir n'est pas savoir qu'il n'y a rien.

`doctor` vérifie le dépôt courant, l'installation des hooks, la stabilité du
binaire, la configuration de score et l'espace occupé. Il remonte surtout les
dégradations enregistrées par le filet de sécurité : celui-ci étant silencieux
par construction, c'est le seul endroit où une panne répétée devient visible.

## Intégration Claude Code

Le format est aligné sur la documentation officielle actuelle de Claude Code : commandes en forme `command` + `args`, JSON reçu sur stdin, et événements `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `FileChanged`, `Stop` et `SessionEnd`.

Installez les hooks dans le dépôt à observer :

```bash
node D:/Driftlight/dist/src/cli.js claude install --cwd D:/mon-projet
```

Ou une seule fois pour toute la machine, ce qui couvre aussi les dépôts que vous
n'avez pas encore créés :

```bash
node D:/Driftlight/dist/src/cli.js claude install --global
```

L'installation globale écrit dans `~/.claude/settings.json`. Ouvrir n'importe quel
dépôt Git suffit alors à être observé, sans installation par projet.

L'installation fusionne les entrées dans `.claude/settings.local.json` sans remplacer les hooks existants. Vérifiez-les avec `/hooks` dans Claude Code.

Le hook `PreToolUse` classe les écritures et commandes proposées. Sur rouge, il renvoie `permissionDecision: "ask"` : Claude Code suspend l'action dans son dialogue de permission jusqu'à la réponse de l'utilisateur. L'orange est seulement journalisé par défaut. `PostToolUse` enregistre aussi les fichiers lus par l'agent, puis `PostToolUse` et `FileChanged` mettent l'historique à jour à partir de l'état réel du disque. Le hook `Stop` affiche uniquement les alertes orange et rouges du tour qui se termine.

Les hooks joignent par ailleurs un champ `terminalSequence` à leur réponse pour le titre du terminal (voir plus bas). Ce champ est purement additif : il ne retient jamais une action, et une version de Claude Code qui ne le connaîtrait pas l'ignore sans conséquence.

Chaque `UserPromptSubmit` écrit atomiquement l'intention de **sa** session, sous `intents/<session>.json`. Le classifieur relit directement ce fichier au moment de chaque décision, sans propagation entre processus. Un fichier explicitement nommé est donc exempté, y compris s'il est sensible.

L'intention appartient à la session, pas au dépôt : deux fenêtres de l'agent ouvertes sur le même projet poursuivent deux demandes différentes. Chacune est jugée sur la sienne, et la demande de l'une ne peut ni déclencher une alerte chez l'autre, ni blanchir une destruction commise hors de son périmètre.

La protection absolue du travail Git préexistant ne signale pas une édition ordinaire. Elle exige simultanément une baseline non commitée, un fichier hors intention et une suppression ou réécriture intégrale. Le verdict est alors toujours ROUGE, même si le fichier a été lu ou cité dans le plan de l'agent. Une seule alerte absolue est conservée par fichier et par tour.

La configuration s'empile sur trois niveaux : les défauts du produit, puis
`~/.driftlight/config.json` pour la machine, puis `.driftlight/config.json` dans
le dépôt, qui a le dernier mot. Une installation unique se règle donc une fois,
sans empêcher un projet de diverger :

```json
{
  "blockOnRed": true,
  "blockOnOrange": false,
  "enforceRed": "irreversible",
  "largeLineDeletionThreshold": 50,
  "notifyOnRed": true,
  "notifyOnOrange": false,
  "notificationSound": true,
  "terminalTitle": true,
  "shadowSignalsCanAlert": false
}
```

| Clé | Défaut | Effet |
| --- | --- | --- |
| `blockOnRed` | `true` | Le rouge passe par le dialogue de confirmation de Claude Code. |
| `blockOnOrange` | `false` | S'il est activé, l'orange déclenche lui aussi la confirmation. |
| `enforceRed` | `"irreversible"` | Force du blocage. Voir ci-dessous. |

### Demander ou refuser

Une demande de confirmation (`ask`) remet la décision à l'agent hôte, qui peut la court-circuiter selon son mode de permission : l'alerte rouge s'affiche pendant que l'action se déroule quand même. Un refus (`deny`) ne se contourne pas.

| `enforceRed` | Comportement |
| --- | --- |
| `"never"` | Toujours demander. L'action reste retenue, mais l'hôte peut passer outre. |
| `"irreversible"` *(défaut)* | Refuser ce que rien ne pourra restaurer — destruction de travail non commité — et demander pour le reste. |
| `"always"` | Refuser tout rouge. Le plus sûr, et le plus sensible aux faux positifs. |

Le défaut trace la ligne là où se tromper coûte moins cher que laisser passer : un refus injustifié coûte une friction, un fichier non commité écrasé ne revient jamais. Un refus indique toujours à l'agent la voie légitime — `driftlight add-scope` — pour qu'une protection ne devienne pas une impasse.
| `largeLineDeletionThreshold` | `50` | Lignes supprimées nettes à partir desquelles l'édition est jugée destructive. |
| `notifyOnRed` | `true` | Notification système sur rouge. |
| `notifyOnOrange` | `false` | Notification système sur orange. |
| `notificationSound` | `true` | Son accompagnant la notification. |
| `terminalTitle` | `true` | Mise à jour du titre du terminal. |
| `shadowSignalsCanAlert` | `false` | Conserve les signaux structurels en observation. À `true`, ils peuvent augmenter le verdict, jamais le diminuer. |

**Aucun de ces réglages ne désactive la classification.** Ils ne touchent qu'à la restitution : un événement non notifié et non bloquant reste intégralement classé, journalisé et visible dans `status`, `explain` et le résumé `Stop`.

## Intégration Codex globale

Le corpus adverse est rejoué à l'identique par Claude Code et par Codex : une
dérive attrapée d'un côté et manquée de l'autre est un angle mort, pas une
différence d'implémentation acceptable. Un seul écart subsiste, déclaré dans les
scénarios et couvert par un test dédié — un `apply_patch` décrit un delta, donc
le contenu résultant d'un manifeste n'existe qu'une fois le patch appliqué, et
l'ajout de dépendance est alors détecté à l'étape suivante plutôt qu'à la
proposition. L'ampleur réelle d'un patch, elle, est lue depuis son corps : sans
cela une réécriture intégrale sous Codex se présentait comme une simple édition.

L'adapter Codex transforme les hooks natifs Codex en protocole DriftLight versionné puis les remet au même pipeline Core que les autres agents : session, intention courante, classification, statut, historique et notifications natives. L'adapter ne classe pas, ne modifie pas les entrées d'outil et n'ouvre aucun port réseau. `inbox/codex/` conserve en plus les enveloppes normalisées minimales pour le diagnostic local.

Après le build, connectez Codex une seule fois :

```powershell
node D:\Driftlight\dist\src\cli.js codex connect
node D:\Driftlight\dist\src\cli.js codex status
```

Sur macOS, la même commande et le même package Node sont utilisés :

```bash
node /chemin/Driftlight/dist/src/cli.js codex connect
```

L'installateur écrit uniquement dans la configuration utilisateur officielle `${CODEX_HOME:-~/.codex}/`. Il fusionne les événements `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop` et `Stop` dans `hooks.json`, conserve les champs et hooks tiers, et utilise la commande Windows appropriée. Il configure aussi dans `config.toml` la politique native `approval_policy = "untrusted"` et `approvals_reviewer = "user"` : c'est Codex, et non DriftLight, qui présente alors son interface Autoriser / Refuser avant une commande non approuvée. Une seconde connexion ne crée aucun doublon et ne reprend jamais la main sur une valeur modifiée ensuite par l'utilisateur. À la désinstallation, DriftLight restaure uniquement les lignes qu'il avait lui-même changées, si elles sont encore intactes.

Codex doit ensuite approuver la définition exacte du hook :

> Open Codex → `/hooks` → review and trust the DriftLight hook once.

DriftLight n'écrit et n'utilise jamais `--dangerously-bypass-hook-trust`, et n'écrit jamais dans l'état de confiance de Codex : cette approbation est un consentement utilisateur, la forger reviendrait à neutraliser le contrôle qu'elle constitue.

### Diagnostic

`codex status` lit l'état réel plutôt que de supposer une cause unique. Codex tient sa décision d'approbation dans `${CODEX_HOME:-~/.codex}/config.toml`, sous `[hooks.state.'<hooks.json>:<event>:<i>:<j>']`, avec une empreinte du contenu approuvé et, le cas échéant, `enabled = false`. DriftLight en extrait le détail par hook :

```
Codex · HOOKS_DISABLED
Hooks :
  ✓ SessionStart       approuvé et actif
  ✗ PreToolUse         désactivé  ← bloque
  ...
Désactivé dans Codex : PreToolUse. Ouvrez Codex → /hooks et réactivez ce hook.
```

| État | Signification |
| --- | --- |
| `NOT_INSTALLED` | Aucun handler DriftLight dans `hooks.json`. |
| `INSTALLED_NEEDS_APPROVAL` | Installé, mais Codex n'a enregistré aucun de ces hooks — ou les a approuvés sans qu'aucun événement ne soit encore arrivé. |
| `HOOKS_DISABLED` | Au moins un hook porte `enabled = false`. Les hooks fautifs sont nommés. |
| `TRUST_STALE` | `hooks.json` a été réécrit après l'enregistrement des empreintes : Codex les tiendra pour périmées. |
| `DEGRADED` | Configuration partielle, Codex non détecté, ou hooks inconnus de Codex. |
| `CONNECTED` | Hooks actifs et au moins un événement effectivement reçu. |

Deux réserves d'honnêteté sur ce diagnostic. L'empreinte exacte de Codex n'est pas recalculable sans deviner sa forme canonique : la péremption est déduite de l'ordre des dates de modification, ce qui suffit à expliquer une approbation qui « ne tient pas », mais reste une heuristique. Et si `config.toml` est illisible, DriftLight ne conclut pas à un refus : un événement réellement reçu prouve que le hook s'exécute, et cette preuve directe prime sur l'absence d'information.

Pour retirer seulement DriftLight :

```powershell
node D:\Driftlight\dist\src\cli.js codex disconnect
```

### Validation manuelle Codex

1. Exécutez `npm.cmd run build` sous Windows ou `npm run build` sous macOS.
2. Exécutez `node dist/src/cli.js codex connect`.
3. Inspectez `%CODEX_HOME%\hooks.json` sous Windows, ou `${CODEX_HOME:-~/.codex}/hooks.json` sous macOS.
4. Lancez une nouvelle session Codex.
5. Ouvrez `/hooks`, contrôlez la commande DriftLight et approuvez-la.
6. Soumettez `Create a file called scopelight-test.txt`.
7. Vérifiez que `current-intent.json` contient le tour courant et qu'un fichier JSON `USER_PROMPT` apparaît dans `inbox/codex/` de l'état du projet.
8. Vérifiez les messages `TOOL_PROPOSED` puis `FILE_EDITED` lorsque Codex utilise `apply_patch`, ainsi que la session `codex-<session-id>.json` dans `sessions/`.
9. Laissez le tour se terminer.
10. Vérifiez la présence de `AGENT_STOPPED`.
11. Ouvrez un autre repository et lancez une nouvelle session Codex.
12. Vérifiez que sa propre boîte `inbox/codex/` reçoit les événements sans réinstallation.

Le bridge remet au Core le prompt courant et les commandes proposées parce qu'ils sont nécessaires à la classification, après masquage des formats de secrets évidents. `PreToolUse/apply_patch` est classifié avant l'action ; `PostToolUse` déclenche ensuite la réconciliation réelle du filesystem. Le bridge ne persiste ni transcript, ni message assistant complet, ni output d'outil complet. Un payload invalide, un Core indisponible ou une erreur d'écriture conduit toujours à une sortie réussie du hook afin que Codex continue normalement.

### Autoriser ou refuser dans Codex

DriftLight ne crée aucun bouton et ne demande plus de saisir un `eventId`. Les hooks restent en observation et ne renvoient ni `deny` ni `ask`. La documentation Codex précise qu'un hook `PreToolUse` ne peut pas déclencher lui-même le dialogue natif avec `permissionDecision: "ask"` ; cette valeur n'est pas prise en charge. L'interface native est donc déclenchée par la politique d'approbation de Codex configurée lors de `codex connect`. Les commandes classées non fiables par Codex présentent directement ses choix natifs dans l'espace de travail.

Cette séparation a une limite volontaire : DriftLight peut détecter et notifier un rouge que la politique native de Codex ne considère pas comme une commande à approuver. Dans ce cas, DriftLight ne fabrique pas un faux dialogue et reste fail-open. Les futurs mécanismes officiellement documentés pourront être branchés sans réintroduire un protocole textuel propriétaire.

## Notifications natives

Le rouge déclenche une notification système avec son. L'orange est enregistré sans notifier : passez `notifyOnOrange` à `true` pour l'activer. Le vert ne notifie jamais.

Le message tient en trois lignes — le fait, la demande à laquelle le comparer, la conduite à tenir — accompagnées d'une pastille de sévérité :

```
DriftLight · boutique-en-ligne — action refusée
Réécriture d'un fichier contenant du travail non sauvegardé : src/legacy.ts
Vous aviez demandé : « Corrige la faute de frappe dans src/app.ts »
Refusez maintenant : ce contenu n'existe nulle part ailleurs.
```

Le titre décrit l'issue réelle du hook, pas la sévérité seule :

| Issue | Titre |
| --- | --- |
| DriftLight a refusé l'action | `DriftLight · <projet> — action refusée` |
| DriftLight a demandé une confirmation | `DriftLight · <projet> — confirmation demandée` |
| Alerte rouge simplement enregistrée | `DriftLight · <projet> — alerte rouge` |
| Alerte orange | `DriftLight · <projet> — à vérifier` |

### Durée d'affichage

Une alerte qui retient une action reste **à l'écran jusqu'à ce que vous l'écartiez**. Disparaître pendant qu'on regarde ailleurs est précisément ce qu'elle ne doit pas faire.

Sous Windows, DriftLight construit lui-même le document du toast (`scenario="reminder"`) et le remet au système. Si ce chemin échoue — PowerShell indisponible, stratégie d'exécution restrictive, identité non enregistrée — il retombe sur un envoi sobre plutôt que de perdre l'alerte. La première notification d'une machine neuve emprunte donc parfois ce repli ; les suivantes non.

**Sous macOS, la durée d'affichage n'est pas contrôlable depuis l'application.** Elle dépend du style choisi dans *Réglages › Notifications* : « Bannières » disparaît après quelques secondes, « Alertes » persiste jusqu'à ce que vous agissiez. `driftlight doctor` le rappelle. Prétendre l'imposer serait mentir sur ce que l'outil contrôle.

### Identité d'application (Windows)

Windows affiche en en-tête le nom et l'icône de l'application déclarée par un raccourci du menu Démarrer. Sans le nôtre, DriftLight emprunte celle de la bibliothèque qui envoie le toast et s'annonce sous son nom.

```
driftlight notify status      # ce qui est en place
driftlight notify install     # enregistre l'identité DriftLight
driftlight notify uninstall   # la retire
driftlight notify test        # aperçu d'une notification
```

L'installation écrit un raccourci dans votre menu Démarrer. C'est une commande explicite et non un geste d'installation automatique : un outil n'a pas à modifier votre menu Démarrer de lui-même.

DriftLight ne dit jamais « action bloquée ». Il renvoie une demande de confirmation et n'a aucun moyen de savoir si l'agent hôte l'honore : un mode de permission permissif peut la contourner sans le prévenir. Promettre un blocage qu'on ne contrôle pas transformerait une alerte en fausse sécurité.

Sous Claude Code, `blockOnRed` pilote le dialogue de confirmation existant. Sous Codex, DriftLight observe et notifie ; Codex décide seul d'afficher Autoriser / Refuser selon sa politique native. Les identifiants d'événements restent utiles à l'historique et à `explain`, jamais comme commande d'approbation.

### Anti-bruit

Le registre `notified-events.json` est persisté, car chaque hook s'exécute dans un processus neuf : toute déduplication en mémoire serait perdue d'un événement au suivant. Trois garde-fous s'appliquent dans l'ordre :

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

Le fichier `current-status.json` contient le niveau maximal depuis le dernier `ack`, les compteurs `GREEN`, `ORANGE` et `RED`, ainsi que l'horodatage du dernier événement. Il ne contient ni code, ni prompt, ni diff.

## Profil du dépôt et graphe d'import

Au démarrage d'une session, DriftLight prépare :

- `repo-profile.json` : nombre de commits, taux de modification et cooccurrences, calculés par un worker en arrière-plan et mis en cache par HEAD ;
- `import-graph.json` : imports statiques et dynamiques JavaScript/TypeScript, avec résolution relative et alias `tsconfig.paths`.

Le graphe invalide seulement les arêtes des sources modifiées ; une création, suppression ou modification de `tsconfig` reconstruit sa topologie. Il reste indisponible sous 20 fichiers JS/TS. Le taux de modification est indisponible sous 50 commits et la cooccurrence sous 100 commits. Ces seuils sont configurés dans `driftlight.scoring.json`.

Un signal indisponible est retiré et les poids restants sont renormalisés. Si aucun signal ne reste, le score vaut `null` : aucune valeur synthétique ne le remplace. Les motifs de secrets sont déclarés dans la configuration de score ; le code TypeScript ne contient aucune liste de chemins sensibles.

## Classification en étages

L'ordre est strict :

1. règle absolue de protection du travail sale ;
2. exemptions (`current-intent`, lecture du tour, Git ignore, création du tour) ;
3. signaux de comportement observables ;
4. signaux structurels dans `shadowScore`.

Les exemptions implicites de lecture, Git ignore et création ne couvrent jamais une destruction, un secret ou un ajout de dépendance. La création est bornée au tour courant. Les lectures issues de Read, Grep et Glob ainsi que les chemins du plan sont captées par les hooks et journalisées sans conserver le contenu complet des outils. Le plan de l'agent n'est jamais une autorisation : il neutralise uniquement `write-without-read` pour le chemin annoncé, sans masquer les autres signaux.

L'étage comportemental combine explicitement `write-without-read`, `destructive-edit`, `full-file-reformat`, `dependency-added` et `sensitive-file`. Les signaux sont regroupés en familles indépendantes, puis la première règle correspondante de `behavior.decisionTable` rend le verdict. Par défaut, un signal rouge gagne et un ou plusieurs signaux orange restent orange : aucune accumulation implicite ne produit rouge. Un bump de version n'est pas un ajout de dépendance.

Le `shadowScore` ne contient que `importDistance`, `fileRarity` et `anchorCooccurrence`. `.env`, Markdown, JSON, images et fichiers hors graphe ont une distance explicitement indisponible. Par défaut, ce score n'alerte jamais. `driftlight explain` sépare le verdict effectif de cette observation.

Les commandes sont analysées hors corps de heredoc/here-string. Les dry-runs, `git checkout` de branche et commandes d'aide restent silencieux ; seules les formes réellement mutatrices sont signalées.

`driftlight mark <eventId> --noise|--useful` alimente `feedback-stats.json`, avec des compteurs persistants par étage et par signal. La spécification détaillée est dans [`docs/classification-v2.md`](docs/classification-v2.md).

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
- `src/adapters/types.ts` — protocole et contrat d'adapter agent-agnostiques ;
- `src/adapters/codex/` — normalisation, installation globale, health check et bridge Codex fail-open ;
- `src/core/normalized-event-processor.ts` — consommation agent-agnostique vers session, intention, classification, statut et notifications ;
- `src/core/local-core-event-sink.ts` — remise au pipeline puis archivage local tolérant aux pannes ;
- `src/core/local-event-inbox.ts` — archive locale par messages JSON atomiques, sans serveur réseau ;
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
- Codex ne permet pas encore à `PreToolUse` de forcer le dialogue natif d'approbation (`ask` est reconnu mais non pris en charge) : DriftLight reste donc consultatif et la politique native de Codex décide seule d'afficher Autoriser / Refuser ;
- les hooks Codex ne disposent pas ici du champ `terminalSequence` utilisé par Claude Code : le statut persistant et les notifications natives fonctionnent, mais le titre du terminal n'est pas piloté depuis le bridge Codex ;
- le package TypeScript installe un bridge Node (`driftlight-hook`, shim `.cmd` sous npm/Windows) et configure explicitement `node.exe` via `commandWindows` ; il ne produit pas encore un exécutable natif autonome `DriftLight-hook.exe` ;
- notifications validées sous Windows uniquement ; le chemin macOS partage le même code et la même API mais n'a pas été exécuté sur machine ;
- `node-notifier` n'a pas été publié depuis février 2022 et entraîne un avertissement `npm audit` *moderate* via `uuid@8`, non exploitable ici puisque seul `uuid.v4()` est appelé, sans argument `buf` ;
- la bibliothèque embarque des binaires d'affichage (`snoretoast` sous Windows, `terminal-notifier` sous macOS) : rien à installer séparément, mais ce n'est pas du JavaScript pur ;
- en mode hook, le titre exact d'avant la session ne peut pas être restauré — la pile de titres XTerm est hors allowlist — donc `SessionEnd` rend le nom du dépôt ;
- si Claude Code se termine sans émettre `SessionEnd`, le titre reste sur la dernière alerte jusqu'au prochain `driftlight ack`.
