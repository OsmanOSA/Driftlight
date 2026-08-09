# Classification v2 — étages, exemptions et mode observation

La v2 remplace le score plat où du bruit moyen pouvait finir par produire une alerte. Le cas déclencheur était `.env.previous`, classé à 72/100 avec une forte contribution `importDistance` alors que ce fichier n'est pas un module.

## Ordre d'évaluation

L'ordre est strict. L'étage 0 décide avant toute exemption. L'étage 1 peut rendre un verdict vert. L'étage 2 produit le verdict comportemental. L'étage 3 reste en observation, sauf promotion explicite.

## Étage 0 — règle absolue

La suppression ou la réécriture intégrale d'un fichier qui avait des modifications non commitées au démarrage de la session, et qui se trouve hors de la demande courante, est toujours **ROUGE**.

- aucune exemption ne s'applique ;
- aucune option ne désactive la règle ;
- une lecture ou une mention dans le plan de l'agent ne l'affaiblit pas ;
- le verdict et la règle de récupération sont hors score.

La résolution du périmètre reste locale et prudente : chemin complet, nom de fichier, ajout de scope, ou répertoire explicitement cité seul. Elle ne s'appuie pas sur un juge distant.

## Étage 1 — exemptions

Une exemption produit **VERT**, n'émet aucune notification et enregistre systématiquement `exemptedBy`.

| Exemption | Portée |
| --- | --- |
| `named-in-intent` | Fichier nommé ou résolu depuis `.driftlight/current-intent.json`. Autorisation explicite, y compris pour une opération destructive, sauf étage 0. |
| `read-this-turn` | Fichier lu pendant le tour par Read, Grep ou Glob. Ne couvre pas une destruction, un secret ou un ajout de dépendance. |
| `git-ignored` | Fichier ignoré par Git, sauf si un motif de secret correspond ou si un autre fait critique est observé. |
| `created-this-session` | Nom de journal conservé pour compatibilité ; la portée réelle est le **tour de création uniquement**. Expire au tour suivant et ne couvre pas un fait critique. |

Un « fait critique » pour les exemptions implicites est une suppression, une réécriture complète, un renommage, une suppression nette dépassant `largeLineDeletionThreshold`, un motif de secret ou un ajout de dépendance. Cette borne évite qu'une lecture normale avant destruction, ou qu'une création ancienne, devienne un veto permanent.

Les chemins lus par les recherches et les chemins de plan sont extraits par les adapters, puis le Core ne conserve que les chemins utiles — jamais le contenu complet des sorties de recherche ou du plan. Une déclaration dans le plan est un indice généré par l'agent, pas une autorisation utilisateur : elle ne produit plus d'exemption. Elle peut uniquement neutraliser `write-without-read` pour le chemin annoncé ; destruction, secret, dépendance et étage 0 restent évalués normalement.

## Étage 2 — signaux de comportement

Ce sont les seuls signaux autorisés à alerter par défaut. Ils utilisent uniquement des faits observables sur l'opération courante.

| Signal | Déclencheur par défaut |
| --- | --- |
| `write-without-read` | Écriture sur un fichier préexistant jamais lu dans la session. |
| `destructive-edit` | Suppression, réécriture intégrale, renommage ou suppression nette importante. |
| `full-file-reformat` | Reformatage intégral explicitement observé par l'adapter. S'il n'est pas observable, le signal est marqué indisponible plutôt qu'inventé. |
| `dependency-added` | Nouvelle clé dans `dependencies`, `devDependencies`, `optionalDependencies` ou `peerDependencies`. Un changement de version d'une clé existante n'alerte pas. |
| `sensitive-file` | Correspondance avec un motif de secret provenant de `driftlight.scoring.json`. Aucun chemin sensible n'est codé dans TypeScript. |

Chaque signal appartient à une famille configurée. `destructive-edit` et `full-file-reformat`, par exemple, appartiennent tous deux à `content-destruction` et ne constituent donc pas deux risques indépendants.

La combinaison suit `behavior.decisionTable`, une table ordonnée et configurable :

- la première règle dont la sévérité minimale, le nombre de familles distinctes et les familles requises correspondent rend le verdict ;
- la configuration livrée traite d'abord tout signal ROUGE, puis tout signal ORANGE ;
- plusieurs signaux ORANGE restent ORANGE par défaut ;
- une escalade vers ROUGE doit nommer explicitement une combinaison de familles indépendante avant les règles générales ;
- aucun signal actif produit VERT.

Les sévérités, familles, décisions et poids explicatifs sont configurés dans `driftlight.scoring.json`. Le `scoreBreakdown` effectif utilise le mode `rules` et conserve la règle de décision, les familles actives et, pour chaque signal, disponibilité, valeur brute, famille, sévérité, poids, contribution et état déclenché.

## Étage 3 — observation structurelle

Le `shadowScore` contient exclusivement :

1. `importDistance` dans le graphe JS/TS avec résolution des alias `tsconfig.paths` ;
2. `fileRarity`, disponible à partir de 50 commits par défaut ;
3. `anchorCooccurrence`, disponible à partir de 100 commits par défaut.

`importDistance` est indisponible lorsque :

- le fichier n'appartient pas au graphe (`.env`, Markdown, JSON, image, configuration, etc.) ;
- aucune ancre JS/TS n'est résolue ;
- le projet n'est pas JS/TS ;
- le graphe contient moins de `minimumGraphFiles` fichiers (20 par défaut).

Un signal indisponible est retiré. Les poids restants sont renormalisés. Si aucun signal ne reste, `score` vaut `null` : aucune valeur de remplacement n'est inventée.

`shadowSignalsCanAlert` vaut `false` par défaut. Un shadowScore élevé est donc journalisé mais ne notifie pas. Une promotion à `true` peut augmenter le verdict effectif, jamais diminuer un verdict comportemental plus sévère.

## Latence et caches

- le graphe est construit au `SessionStart` ;
- une modification de source invalide uniquement ses arêtes ; une création, suppression ou modification de `tsconfig` reconstruit la topologie ;
- les statistiques Git sont calculées par un worker détaché au `SessionStart` ;
- `.driftlight/repo-profile.json` est réutilisé tant que HEAD et les paramètres statistiques n'ont pas changé ;
- aucun historique Git et aucune construction de graphe ne s'exécute dans le chemin critique de `PreToolUse`.

Si le worker ou le cache est indisponible, les signaux correspondants sont marqués indisponibles et l'étage 2 continue seul.

## Commandes

La classification de commandes applique les mêmes sévérités configurées, sans exécuter ni réécrire la commande.

- les corps de heredoc et de here-string ne sont pas analysés comme des commandes exécutées ;
- `git clean -n`, `--dry-run`, `--help` et `Remove-Item -WhatIf` n'alertent pas ;
- `git checkout ma-branche` n'alerte pas ; la restauration de chemins (`git checkout -- fichier`) reste destructive ;
- les commandes Git, filesystem, dépendances et infrastructure ne sont signalées que pour leurs formes mutatrices.

## Mesure de la précision

`driftlight mark <eventId> --noise|--useful` conserve le feedback sur l'événement et met à jour `.driftlight/feedback-stats.json` : totaux, résultats par étage et par signal. Changer un marquage décrémente l'ancien compteur avant d'incrémenter le nouveau.

Cette mesure couvre donc l'étage 2 dès le premier jour, en plus du shadowScore de l'étage 3.

## Traçabilité

Chaque événement de fichier enregistre :

- `stage` ;
- `exemptedBy` le cas échéant ;
- le verdict effectif et sa décomposition ;
- le `shadowScore` et tous ses signaux disponibles ou indisponibles ;
- l'identité du tour et de l'intention.

`driftlight explain <eventId>` sépare clairement le verdict effectif de l'observation structurelle.

## Contrats testés

- lecture avant édition normale → exemption verte, aucune alerte ;
- intention utilisateur explicite → exemption, sauf étage 0 ;
- plan de l'agent → indice sur l'absence de lecture, jamais exemption ni masque critique ;
- suppression/réécriture d'un fichier sale hors scope → ROUGE absolu ;
- fichier secret gitignoré → non exempté ;
- exemption de création expirée au tour suivant ;
- `.env` → `importDistance` indisponible ;
- graphe immature et historique jeune → signaux retirés sans crash ;
- projet non-JS → étage 2 opérationnel seul ;
- shadowScore élevé → aucune alerte par défaut ;
- bump de version → pas de signal d'ajout ; nouvelle dépendance → alerte ;
- dry-run, checkout de branche et heredoc → aucune fausse alerte de commande ;
- feedback → agrégat persistant par signal.
