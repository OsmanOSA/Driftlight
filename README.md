# DriftLight

DriftLight est un voyant local qui compare la demande donnée à un coding agent avec les fichiers réellement touchés. Cette première tranche verticale observe et explique ; elle ne bloque aucune action et ne restaure jamais le worktree.

## Garanties de cette version

- exécution et historique entièrement locaux ;
- aucun compte, serveur DriftLight, abonnement ou télémétrie ;
- aucun code, prompt, diff ou chemin envoyé sur le réseau ;
- aucune commande de rollback ou de nettoyage exécutée ;
- détection des créations, modifications et suppressions ;
- protection renforcée des changements présents avant la session ;
- classifieur déterministe extensible `GREEN | ORANGE | RED`.

DriftLight ignore son propre dossier `.driftlight/`, ainsi que les sorties volumineuses habituelles (`node_modules/`, `dist/`, `coverage/`, etc.). L'historique conserve des chemins, des métadonnées et des empreintes SHA-256, jamais le contenu des fichiers.

## Prérequis et installation

- Node.js 20 ou plus récent ;
- Git disponible dans le `PATH` pour les protections de baseline.

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

Dans un second terminal, modifiez successivement un fichier ordinaire, `package.json`, puis un chemin sensible comme `.github/workflows/ci.yml`. DriftLight affiche un signal concis et écrit la session sous `D:/mon-projet/.driftlight/sessions/`. Arrêtez proprement avec `Ctrl+C`.

Exemples de lecture et d'acquittement :

```bash
node D:/Driftlight/dist/src/cli.js status --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js mark-expected event-123 --cwd D:/mon-projet
node D:/Driftlight/dist/src/cli.js add-scope "La configuration Vite fait partie de la tâche" --cwd D:/mon-projet
```

`Mark as expected` acquitte seulement l'événement choisi. `Add to task scope` ajoute une version locale du contrat d'intention et influence les classifications suivantes.

## Intégration Claude Code — observation uniquement

Le format a été aligné sur la documentation officielle actuelle de Claude Code : commandes en forme `command` + `args`, JSON reçu sur stdin, et événements `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `FileChanged` et `SessionEnd`.

Installez les hooks dans le dépôt à observer :

```bash
node D:/Driftlight/dist/src/cli.js claude install --cwd D:/mon-projet
```

L'installation fusionne les entrées dans `.claude/settings.local.json` sans remplacer les hooks existants. Vérifiez-les avec `/hooks` dans Claude Code.

Le hook `PreToolUse` observe les écritures et commandes proposées, mais ne renvoie jamais `allow`, `ask`, `deny`, `decision: block` ou un code de sortie bloquant. Les alertes orange et rouges sont rendues avec le champ d'affichage `systemMessage`. `PostToolUse` et le watcher `FileChanged` mettent ensuite l'historique à jour à partir de l'état réel du disque. Les fichiers non couverts par `FileChanged` restent observés après chaque outil et par le mode CLI autonome.

## Règles locales v1

Rouge par défaut :

- migrations et schémas de base de données ;
- `.env`, secrets et clés ;
- CI/CD ;
- auth et permissions ;
- infrastructure et configuration de production ;
- commandes destructives proposées ;
- suppression ou restauration d'un changement préexistant ;
- amplitude de 20 fichiers ou plus.

Orange par défaut :

- `package.json`, lockfiles et nouvelles dépendances ;
- fichiers de configuration ;
- suppression ordinaire ;
- modification supplémentaire d'un fichier déjà sale ;
- amplitude de 8 fichiers ou plus.

Une demande qui mentionne explicitement une catégorie peut réduire le signal d'un changement attendu, sauf pour les secrets et la protection du travail préexistant. Les fichiers ordinaires restent verts pour limiter le bruit. Le contrat `Classifier` permet d'ajouter plus tard un juge local ou un fournisseur configuré avec la clé de l'utilisateur, sans modifier la collecte.

## Architecture

- `src/git/baseline.ts` — état Git initial, branche, commit et changements préexistants ;
- `src/observer/` — snapshot haché, diff et polling multiplateforme ;
- `src/classification/` — règles et implémentation du contrat `Classifier` ;
- `src/session/` — contrat d'intention versionné et historique local atomique ;
- `src/claude/` — installation et traitement non bloquant des hooks Claude Code ;
- `src/ui/terminal.ts` — signal terminal compact ;
- `test/fixtures/` — tâches et dérives représentatives.

## Qualité

```bash
npm run lint
npm test
npm run build
```

Les tests d'intégration créent uniquement des dépôts temporaires et n'exécutent aucune commande destructive contre le dépôt surveillé.

## Limites connues de cette tranche

- classification au niveau fichier et commande, sans analyse sémantique du diff ;
- heuristiques de scope prudentes, sans juge LLM local ou distant ;
- watcher par polling, sans optimisation pour les monorepos massifs ;
- pas d'interface graphique, de diff interactif ou de lancement automatique de l'agent ;
- pas de blocage, d'autorisation ou de rollback ;
- support agent explicite limité à Claude Code.
