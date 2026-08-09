# PRD — DriftLight

**Version :** 0.1  
**Statut :** Draft  
**Produit :** DriftLight 
**Catégorie :** Developer Tool / AI Coding Safety / Agent Observability

---

# 1. Résumé

DriftLight est un petit outil local qui indique en temps réel si un agent de coding est en train de modifier des éléments cohérents avec la demande initiale de l’utilisateur.

L’utilisateur donne une instruction à Claude Code, Codex, Cursor ou un autre coding agent :

> “Change la couleur du bouton Checkout.”

DriftLight observe les fichiers et ressources touchés par l’agent.

Tant que les modifications semblent correspondre à la demande :

**🟢 Dans le scope**

Si l’agent commence à toucher des fichiers dont la pertinence est incertaine :

**🟠 Hors scope probable**

Si l’agent effectue une modification manifestement inattendue ou à fort impact :

**🔴 Changement inattendu**

DriftLight ne bloque pas l’agent par défaut.  
Il ne remplace ni Git, ni l’IDE, ni l’agent.

Le produit s’installe directement sur l’ordinateur de l’utilisateur. Il ne nécessite ni compte permanent, ni serveur DriftLight, ni abonnement. Le produit initial est vendu avec un paiement unique et prend en charge Claude Code en premier.

Il répond à une seule question :

> **“Est-ce que mon agent est encore en train de faire ce que je lui ai demandé ?”**

---

# 2. Problème

Les coding agents disposent de plus en plus d’autonomie.

À partir d’une instruction simple, ils peuvent :

- explorer le repository ;
- modifier plusieurs fichiers ;
- installer des dépendances ;
- changer une configuration ;
- créer ou modifier une migration ;
- modifier des tests ;
- refactorer du code adjacent ;
- exécuter des commandes ;
- toucher des fichiers que l’utilisateur n’avait jamais envisagés.

Ces actions peuvent être parfaitement justifiées.

Mais aujourd’hui, l’utilisateur ne dispose généralement pas d’un signal simple lui permettant de distinguer :

**“L’agent fait le travail demandé.”**

de :

**“L’agent est en train d’élargir le travail de sa propre initiative.”**

Les interfaces actuelles montrent principalement :

- les commandes exécutées ;
- les fichiers modifiés ;
- le diff ;
- le raisonnement ou résumé de l’agent.

Elles demandent donc à l’utilisateur d’interpréter lui-même le scope.

Cette friction devient particulièrement visible avec les agents autonomes qui travaillent pendant plusieurs minutes.

---

# 3. Vision

Faire de DriftLight le **voyant local de dérive des coding agents**, avec Claude Code comme première intégration et une compatibilité élargie uniquement après validation du MVP.

Comme une lumière d’activité :

- 🟢 l’agent travaille normalement ;
- 🟠 il s’éloigne potentiellement du scope ;
- 🔴 il fait quelque chose que l’utilisateur devrait probablement regarder.

DriftLight doit être compréhensible en moins de cinq secondes, même par quelqu’un qui n’a jamais utilisé le produit.

---

# 4. Proposition de valeur

## Pour l’utilisateur

DriftLight permet de :

- détecter immédiatement les dérives de scope ;
- surveiller un agent sans lire chaque action ;
- intervenir avant qu’une petite tâche ne devienne un gros changement ;
- déléguer davantage tout en conservant une sensation de contrôle ;
- comprendre rapidement pourquoi un changement est considéré comme inhabituel.
- protéger les modifications qui existaient déjà avant le démarrage de l’agent ;
- obtenir ce signal sans envoyer le repository à un service DriftLight.

## Promesse

> **Know when your coding agent goes off-script.**

Alternative :

> **A scope warning light for coding agents.**

Version française :

> **Le voyant qui te dit quand ton agent sort du périmètre.**

---

# 5. Principes produit

## 5.1 Invisible quand tout va bien

DriftLight ne doit pas devenir une nouvelle interface complexe à surveiller.

La plupart du temps, le produit doit rester vert et silencieux.

---

## 5.2 Informer avant de bloquer

Le MVP ne bloque pas les actions.

DriftLight observe et signale.

Le produit doit créer de la confiance avant d’introduire éventuellement des mécanismes d’autorisation.

---

## 5.3 Compréhensible immédiatement

L’utilisateur ne doit pas avoir à comprendre un “risk score 73/100”.

Le signal principal reste :

**🟢 🟠 🔴**

---

## 5.4 Expliquer chaque alerte

Chaque alerte doit répondre à :

> Pourquoi DriftLight pense-t-il que cette modification sort du scope ?

---

## 5.5 Minimiser les faux positifs

Un produit qui devient orange toutes les trente secondes sera ignoré.

Le seuil doit favoriser la pertinence plutôt que l’exhaustivité.

---

# 6. Utilisateurs cibles

## Persona primaire — Développeur utilisant des coding agents

Profil :

- développeur professionnel ;
- utilise Claude Code, Codex, Cursor ou équivalent quotidiennement ;
- délègue des tâches de plus en plus larges ;
- garde généralement Git ouvert pour surveiller ce qui change.

Problème :

> “Je veux laisser l’agent travailler mais je veux savoir immédiatement s’il commence à faire quelque chose que je n’avais pas demandé.”

---

## Persona secondaire — Tech lead

Utilise plusieurs agents ou supervise des développeurs travaillant avec des agents.

Problème :

> “Je veux réduire les changements inutiles et les PR gonflées par des décisions autonomes de l’agent.”

---

## Hors cible du MVP — Gouvernance d’entreprise

Équipes voulant définir des règles organisationnelles :

- ne jamais modifier `/infra` sans autorisation ;
- signaler toute migration ;
- signaler les nouvelles dépendances ;
- signaler les changements CI/CD ;
- signaler les secrets ou permissions.

Ce besoin ne fait pas partie du MVP et ne doit pas influencer l’architecture ou l’interface du produit initial.

---

# 7. Job To Be Done

Lorsque je délègue une tâche à un coding agent,

je veux savoir instantanément lorsqu’il commence à effectuer des changements qui ne semblent pas nécessaires à ma demande,

afin de pouvoir vérifier ce qu’il fait avant que le changement ne devienne important.

---

# 8. Cas d’usage principal

Instruction :

> “Change la couleur du bouton Checkout.”

Claude Code commence son travail.

DriftLight affiche :

**🟢 CheckoutButton.tsx**

L’agent modifie ensuite :

`src/components/CheckoutButton.tsx`

Puis :

`src/styles/buttons.css`

DriftLight reste :

**🟢 Within scope**

L’agent modifie ensuite :

`package.json`

DriftLight affiche :

**🟠 Outside scope — package.json**

L’utilisateur clique.

DriftLight explique :

> La tâche concerne l’apparence du bouton Checkout.  
> Modifier les dépendances du projet n’était pas nécessairement attendu.

L’agent crée ensuite :

`db/migrations/20260808_update_checkout.sql`

DriftLight affiche :

**🔴 Unexpected change**

Explication :

> Une migration de base de données est un changement à fort impact qui semble sans rapport direct avec une modification visuelle du bouton Checkout.

---

# 9. Moment magique

Le produit doit pouvoir être démontré en quelques secondes.

Commande :

> Fix this typo.

DriftLight :

**🟢**

L’agent touche un fichier.

**🟢 README.md**

Puis l’agent commence à toucher :

- `package.json`
- `src/config.ts`
- `.github/workflows/ci.yml`
- `db/schema.sql`

DriftLight :

**🔴 Unexpected change — 5 files outside scope**

Le produit est compris sans explication supplémentaire.

---

# 10. Expérience utilisateur MVP

## 10.1 État initial

Lorsqu’une nouvelle tâche agent démarre :

**DriftLight**
`Understanding task…`

Puis :

**🟢 Monitoring**

---

## 10.2 État vert

Exemple :

**🟢 Within scope**

`CheckoutButton.tsx`

Sous-texte facultatif :

`Matches requested UI change`

---

## 10.3 État orange

Exemple :

**🟠 Possible scope drift**

`package.json`

Sous-texte :

`Dependency change not implied by task`

CTA :

**Why?**

---

## 10.4 État rouge

Exemple :

**🔴 Unexpected change**

`db/migrations/20260808_checkout.sql`

Sous-texte :

`Database migration appears unrelated`

CTA :

**Inspect**

---

# 11. Interaction après clic

Le détail d’une alerte affiche quatre informations.

### Requested

> Change the Checkout button color to blue.

### Agent action

> Created `db/migrations/20260808_checkout.sql`

### Why flagged

> The requested task concerns UI styling. A database schema change is not normally required for this task.

### Suggested action

> Review this change before allowing the agent to continue.

MVP :

Boutons :

**Inspect diff**

**Mark as expected**

**Add to task scope**

`Mark as expected` acquitte uniquement cette alerte. `Add to task scope` met à jour le périmètre pour les actions suivantes de la session.

Option future :

**Stop agent**

---

# 12. Définition du scope

DriftLight doit construire une représentation du périmètre attendu à partir de la demande utilisateur.

Exemple :

Prompt :

> “Change the Checkout button color.”

Scope implicite :

- composant Checkout ;
- CSS ;
- styles ;
- éventuellement tests visuels ;
- fichiers frontend directement liés.

Probablement hors scope :

- dépendances ;
- backend ;
- database ;
- CI ;
- infra ;
- authentication.

Le scope ne doit donc pas être uniquement une liste de fichiers explicitement nommés.

Il doit être **sémantique**.

## Évolution du scope pendant une session

Le périmètre peut évoluer lorsque l’utilisateur ajoute une instruction ou accepte explicitement une expansion.

DriftLight doit distinguer :

- une nouvelle demande formulée par l’utilisateur ;
- une dépendance nécessaire découverte pendant le travail ;
- une amélioration proposée spontanément par l’agent ;
- une action que l’utilisateur marque comme attendue.

L’explication de l’agent ne suffit pas à étendre automatiquement le scope. Seule une instruction utilisateur ou l’action **Add to task scope** peut modifier le contrat d’intention actif.

---

# 13. Modèle de détection

Chaque action reçoit un niveau de compatibilité avec la tâche.

Conceptuellement :

`scope_score(action, task, repo_context)`

Exemple :

| Action | Score | Statut |
|---|---:|---|
| Modifier CheckoutButton.tsx | 0.96 | 🟢 |
| Modifier buttons.css | 0.88 | 🟢 |
| Modifier snapshot test | 0.72 | 🟢 |
| Modifier package.json | 0.44 | 🟠 |
| Ajouter une dependency | 0.31 | 🟠 |
| Modifier auth middleware | 0.12 | 🔴 |
| Créer une DB migration | 0.05 | 🔴 |

Le score exact n’est jamais nécessairement affiché à l’utilisateur.

---

# 14. Signaux utilisés

Le moteur peut analyser plusieurs dimensions.

## Sémantique

Relation entre :

- demande utilisateur ;
- nom du fichier ;
- fonction du fichier ;
- diff.

---

## Distance dans le code

Exemple :

`CheckoutButton.tsx`

→ `Button.css`

distance faible.

`CheckoutButton.tsx`

→ `database/migrations`

distance forte.

---

## Type de changement

Certaines actions sont naturellement plus sensibles :

- nouvelle dépendance ;
- migration DB ;
- suppression de fichier ;
- modification de secrets ;
- permissions ;
- CI ;
- Docker ;
- infrastructure ;
- auth ;
- deployment.

---

## Amplitude

Une tâche simple qui déclenche :

- 1 fichier → normal ;
- 4 fichiers → éventuellement normal ;
- 27 fichiers → suspect.

---

## Apparition de nouveaux sous-problèmes

Exemple :

Prompt initial :

> Fix typo.

Agent :

> I noticed the component could also be refactored.

Le changement de mission constitue lui-même un signal de dérive.

## État initial du repository

Avant le démarrage de l’agent, DriftLight capture une baseline locale :

- fichiers déjà modifiés ;
- fichiers non suivis ;
- suppressions déjà présentes ;
- branche et commit de référence lorsque Git est disponible.

Ces changements préexistants appartiennent potentiellement à l’utilisateur ou à un autre agent. Toute tentative de les restaurer, supprimer, écraser ou « nettoyer » sans instruction explicite constitue une alerte rouge prioritaire.

DriftLight ne doit jamais utiliser `git restore`, `git checkout`, `git reset`, `git clean` ou une commande équivalente pour corriger le repository.

---

# 15. Architecture MVP

DriftLight se compose de quatre blocs.

### 1. Task capture

Récupération de la demande initiale donnée à l’agent.

Exemples :

- hook Claude Code ;
- MCP ;
- wrapper CLI ;
- extension IDE.

Le MVP capture aussi les instructions de suivi qui modifient explicitement la tâche. Il conserve un contrat d’intention actif et versionné localement pendant la session.

---

### 2. Change observer

Observe :

- état initial du worktree avant l’agent ;
- fichiers créés ;
- fichiers modifiés ;
- fichiers supprimés ;
- commandes importantes ;
- éventuellement diffs.

Lorsque l’intégration expose un hook avant tool call, DriftLight classifie l’action proposée avant son exécution mais retourne **allow** dans le MVP. Lorsque ce hook n’existe pas, un file watcher détecte le changement immédiatement après l’écriture, pendant qu’il reste réversible.

---

### 3. Scope classifier

Entrées :

- prompt initial ;
- contrat d’intention actif ;
- changements observés ;
- baseline Git ;
- structure repository ;
- éventuellement contenu des fichiers.

Sortie :

`GREEN | ORANGE | RED`

avec :

`reason`

---

### 4. UI

Widget toujours visible.

Exemple :

`🟢 DriftLight`

ou :

`🟠 package.json`

ou :

`🔴 DB migration`

---

# 16. Stratégie d’intégration MVP

Le meilleur MVP doit éviter de supporter dix agents immédiatement.

## Intégration initiale recommandée

**Claude Code**

Raisons :

- usage agentique fort ;
- CLI facilement observable ;
- utilisateurs déjà habitués aux permissions et tool calls ;
- audience développeur susceptible de comprendre immédiatement le problème.

DriftLight pourrait prendre la forme de :

- hooks Claude Code en priorité ;
- CLI wrapper léger pour le lancement et l’affichage ;
- MCP server léger ;
- extension VS Code complémentaire.

Exemple :

```bash
DriftLight claude
```

ou :

```bash
npx DriftLight
```

Puis Claude Code fonctionne normalement.

---

# 17. Scope du MVP

## Inclus

- capture du prompt initial ;
- capture des instructions de suivi qui étendent explicitement la tâche ;
- baseline Git et protection des changements préexistants ;
- observation des fichiers modifiés ;
- classification vert / orange / rouge ;
- détection des fichiers sensibles ;
- explication simple des alertes ;
- widget discret toujours visible ;
- historique de la session ;
- actions **Mark as expected** et **Add to task scope** ;
- support d’un seul coding agent ;
- fonctionnement sur repository Git local.

## Non inclus

- blocage automatique ;
- approbation avant chaque action ;
- dashboard entreprise ;
- politiques d’organisation ;
- service cloud DriftLight ;
- gestion multi-agent ;
- rollback ;
- remplacement de Git ;
- code review complète ;
- détection de bugs ;
- analyse de sécurité exhaustive.

---

# 18. Règles déterministes MVP

Avant même d’utiliser un modèle sémantique, DriftLight peut bénéficier de règles simples.

Exemples d’orange :

- changement `package.json` ;
- nouveau package ;
- modification config ;
- changement de fichier hors dossier attendu ;
- nombre de fichiers supérieur à un seuil.

Exemples de rouge :

- migration DB ;
- `.env` ;
- secret ;
- workflow CI/CD ;
- Terraform ;
- suppression massive ;
- permissions ;
- auth ;
- production configuration.
- restauration ou suppression d’un changement qui existait avant le lancement de l’agent ;
- commande destructive visant plusieurs fichiers préexistants.

Ces règles réduisent le coût et améliorent la prédictibilité.

---

# 19. Approche hybride recommandée

Le moteur MVP combine :

### Rules engine

Très rapide et déterministe.

+

### LLM scope judge

Analyse la relation sémantique entre tâche et action.

Entrée :

> User request: Change Checkout button color.

> Proposed modification: package.json adds dependency `color`.

Sortie interne :

- relevance : medium ;
- impact : medium ;
- explanation.

Le juge s’exécute selon l’un des deux modes choisis par l’utilisateur :

1. modèle local compatible, sans sortie réseau ;
2. fournisseur externe configuré avec la propre clé API de l’utilisateur.

DriftLight ne finance, ne proxyfie et ne stocke aucun appel d’inférence. Le moteur de règles et les protections Git restent disponibles même sans modèle sémantique.

+

### Repo context

Arborescence et relations simples entre fichiers.

Seul le contexte minimal nécessaire est transmis au juge : demande, métadonnées de l’action, chemins concernés et extrait de diff limité lorsque celui-ci est indispensable.

---

# 20. Exemple de classification

Prompt :

> Fix the typo in the pricing page.

Agent actions :

`src/pages/Pricing.tsx`

→ 🟢

`src/pages/Pricing.test.tsx`

→ 🟢

`src/components/PricingCard.tsx`

→ 🟠

`package.json`

→ 🟠

`.github/workflows/deploy.yml`

→ 🔴

`db/migrations/add_plan_column.sql`

→ 🔴

---

# 21. UX : design de la lumière

Le produit doit physiquement ressembler davantage à un **indicateur** qu’à une application.

Idéalement :

### État vert

`● DriftLight`

### État orange

`● package.json`

### État rouge

`● Unexpected: DB migration`

Le rouge peut légèrement pulser.

Pas de notifications agressives dans le MVP.

Pas de modal automatique.

Le développeur clique uniquement s’il veut comprendre.

---

# 22. Historique session

Popover :

**Current task**

> Change Checkout button color.

### Changes

🟢 `CheckoutButton.tsx`

🟢 `buttons.css`

🟠 `package.json`

🔴 `db/migrations/checkout.sql`

Chaque ligne est cliquable.

---

# 23. Métriques produit

## North Star

**Retained monitoring rate**

Pourcentage d’utilisateurs activés qui terminent au moins cinq sessions surveillées et gardent DriftLight activé après une semaine.

Métrique de qualité indispensable :

**Useful alert rate**

Pourcentage d’alertes pour lesquelles l’utilisateur indique :

> “Oui, je voulais voir ça.”

---

## Métriques secondaires

- sessions surveillées ;
- tâches par utilisateur/semaine ;
- nombre moyen d’alertes/session ;
- taux d’alertes rouges jugées utiles ;
- taux d’alertes orange jugées raisonnables ;
- taux **Mark as expected** ;
- taux **Add to task scope** ;
- taux “Useful warning” ;
- faux positifs signalés ;
- temps entre dérive et alerte ;
- taux de rétention hebdomadaire.

---

# 24. Objectifs MVP

Après quatre semaines d’utilisation par des développeurs actifs :

### Activation et rétention

> 60 % des testeurs terminent au moins cinq sessions surveillées et gardent DriftLight activé pendant toute la semaine de test.

### Utilité

> ≥ 80 % des alertes rouges sont considérées utiles.

> ≥ 60 % des alertes orange sont considérées raisonnables, même lorsque l’utilisateur décide de poursuivre.

### Bruit

> < 5 % des sessions génèrent une alerte que l’utilisateur juge clairement absurde.

> La médiane reste inférieure ou égale à une alerte visible par session.

### Performance

> Classification visible moins de deux secondes après détection du changement.

### Signal commercial

> À l’issue du test, au moins 25 % des testeurs acceptent réellement d’acheter DriftLight au prix proposé, sans réduction artificielle.

---

# 25. Risque principal : faux positifs

Le risque numéro un n’est pas de manquer une dérive.

C’est d’en signaler trop.

Exemple :

Prompt :

> Add Stripe checkout.

Agent modifie :

`package.json`

DriftLight ne doit pas dire automatiquement :

🔴

Ajouter le SDK Stripe est probablement légitime.

Le système doit donc analyser le **contexte de la tâche** avant d’appliquer ses règles.

---

# 26. Risque : “l’agent avait une bonne raison”

Un changement hors scope n’est pas nécessairement mauvais.

DriftLight ne doit pas dire :

> “This is wrong.”

Il doit dire :

> “This was not obviously implied by your request.”

Le produit détecte une **dérive de périmètre**, pas une erreur.

---

# 27. Risque : dérive invisible

Certaines dérives ne correspondent pas à un nouveau fichier.

Exemple :

Prompt :

> Fix bug in checkout calculation.

L’agent modifie la bonne fonction mais ajoute également un gros refactor.

Version future :

DriftLight devra analyser le **diff sémantique**, et pas uniquement les fichiers touchés.

---

# 28. Privacy

Le code source peut être extrêmement sensible.

Principe :

**Local by default.**

Garanties du produit :

- observation, baseline Git, historique et règles exécutés localement ;
- aucun compte permanent requis ;
- aucun code, diff ou historique envoyé à un serveur DriftLight ;
- aucune télémétrie contenant du code, des chemins ou des prompts ;
- aucune persistance distante ;
- analyse externe désactivée par défaut ;
- possibilité d’utiliser un modèle local ;
- possibilité facultative d’utiliser la clé API personnelle de l’utilisateur avec un contexte minimisé.

L’interface doit indiquer clairement quel moteur de classification est actif et quelles données, le cas échéant, quittent la machine.

---

# 29. Business model

## Licence locale — paiement unique

Hypothèse de lancement :

- prix public entre 39 € et 59 € ;
- paiement unique ;
- téléchargement et fonctionnement local ;
- aucune infrastructure ou inférence financée par DriftLight ;
- aucune connexion continue requise pour utiliser le produit ;
- licence individuelle pour la version majeure achetée.

La licence inclut :

- intégration Claude Code ;
- signal vert / orange / rouge ;
- baseline Git et protection du travail existant ;
- historique local ;
- règles locales ;
- juge sémantique avec modèle local ou clé utilisateur ;
- mises à jour correctives de la version majeure.

Une version d’évaluation limitée peut être proposée pour réduire la friction avant achat, mais elle ne doit nécessiter aucun abonnement.

Une future version majeure peut être vendue séparément. Les utilisateurs conservent indéfiniment la version déjà achetée. Il n’existe ni plan Team, ni dashboard centralisé, ni engagement à fournir gratuitement toutes les futures intégrations.

Le MVP doit d’abord prouver que les développeurs veulent réellement conserver DriftLight activé et qu’ils acceptent de payer une fois pour cette tranquillité.

---

# 30. Expansion produit

Si le voyant fonctionne, DriftLight peut progressivement évoluer. Ces phases sont optionnelles et ne constituent ni une roadmap d’entreprise, ni une condition de succès du produit initial.

## Phase 2 — Scope policies

Exemples :

> Never touch `/infra`.

> Warn me before database changes.

> package.json requires approval.

---

## Phase 3 — Permission layer

🔴 DriftLight détecte une dérive.

Boutons :

**Allow once**

**Always allow**

**Stop**

DriftLight devient une couche d’autorisation indépendante de l’agent.

---

## Phase 4 — Multi-agent

DriftLight observe :

- Claude Code ;
- Codex ;
- Cursor ;
- Gemini CLI ;
- agents internes.

Une seule politique de scope quel que soit l’agent.

---

## Phase 5 — Agent trust layer

À long terme, DriftLight pourrait mesurer :

- dérive de scope ;
- modification risquée ;
- amplitude inattendue ;
- opérations irréversibles ;
- escalade de permissions ;
- consommation inhabituelle de ressources.

Mais ce n’est pas le produit initial.

---

# 31. Positionnement

DriftLight ne doit pas être présenté comme :

> AI coding security platform.

Trop large.

Ni :

> Agent observability suite.

Trop abstrait.

Ni :

> AI code review.

Faux problème.

Le positionnement initial :

> **See when your coding agent goes outside the task you gave it.**

Ou :

> **A tiny warning light for coding agents.**

---

# 32. Concurrence et différenciation

## Visibilité et rollback

- Cursor Review et Checkpoints ;
- Aider Git et `/undo` ;
- diffs et patches Codex ;
- historique Git et `git diff`.

Ces outils montrent ce qui a changé et permettent parfois de revenir en arrière. Ils ne déterminent pas automatiquement si chaque changement était justifié par la demande.

## Scope et permissions manuels

- Cursor Manual, Ask, Plan et Rules ;
- Claude Code permissions, hooks et sandbox ;
- Antigravity permissions ;
- Cline Plan & Act ;
- produits de runtime security comme Operant ScopeGuard ou Agentshield.

Ces solutions sont efficaces lorsque l’utilisateur connaît les fichiers, outils ou chemins à autoriser. Elles introduisent une configuration manuelle que DriftLight veut éviter pour les tâches ordinaires.

## Concurrents sémantiques proches

- **Claude Code Auto mode** utilise un classifieur séparé conditionné par la conversation pour bloquer certaines actions dépassant la requête. C’est le concurrent natif le plus proche. Sa documentation indique néanmoins que les éditions ordinaires dans le working directory peuvent être auto-approuvées avant classification ;
- **gstack `/review` et `/ship`** compare plan, TODO, commits, PR et diff pour signaler le scope creep avant livraison. La détection est principalement post-hoc ;
- **ScopeJudge** démontre une classification conditionnée par la requête avant chaque tool call, mais reste un travail de recherche spécialisé dans les agents de sécurité offensive.

## Différenciation exacte de DriftLight

> **Analyse locale et continue des modifications ordinaires du repository, conditionnée par l’intention, sans exiger un scope manuel et indépendamment de l’agent.**

DriftLight doit rester utile précisément entre les deux extrêmes :

- la simple observation après coup ;
- les politiques de sécurité manuelles et lourdes.

Il ne doit pas devenir un nouveau panneau de diff, un système d’allowlists ou une plateforme de gouvernance d’agents.

---

# 33. Avantage produit

L’interface est volontairement triviale. L’avantage de DriftLight repose sur :

- la précision de la classification locale ;
- un très faible taux de bruit ;
- la protection fiable du worktree existant ;
- une explication immédiatement compréhensible ;
- une installation simple ;
- des intégrations maintenues avec les coding agents pris en charge.

DriftLight ne dépend pas d’un dataset centralisé. Les prompts, chemins, diffs et jugements humains restent locaux.

Une exportation volontaire et anonymisée de cas de test pourrait exister plus tard, mais elle ne fait pas partie du MVP, de la proposition de valeur ou du modèle économique.

---

# 34. Questions à valider

Avant d’investir lourdement :

1. À quelle fréquence les coding agents sortent-ils réellement du scope sur des tâches quotidiennes ?
2. Les utilisateurs remarquent-ils déjà ces dérives ?
3. Est-ce suffisamment fréquent pour laisser DriftLight activé ?
4. Quel taux de faux positifs est acceptable ?
5. Orange est-il réellement utile ou uniquement rouge ?
6. Les utilisateurs veulent-ils seulement être informés ou également pouvoir bloquer ?
7. Une classification au niveau fichier suffit-elle pour créer la valeur initiale ?
8. Quel est le meilleur point d’intégration avec Claude Code ?
9. Combien de contexte repository faut-il analyser pour avoir une bonne classification ?
10. Un modèle local offre-t-il une précision suffisante pour le juge sémantique ?
11. Quelle proportion d’utilisateurs préfère utiliser sa propre clé API ?
12. Les utilisateurs acceptent-ils réellement un paiement unique de 39 € à 59 € ?
13. L’absence de compte, de serveur et d’abonnement constitue-t-elle un facteur d’achat important ?
14. Quelle charge de maintenance impose chaque nouvelle version de Claude Code ?

---

# 35. Plan de validation avant développement complet

## Étape 1 — Calibration hors ligne

Créer un prototype très simple.

Il reçoit :

- prompt initial ;
- liste de fichiers touchés ;
- diff optionnel.

Il retourne :

🟢 / 🟠 / 🔴

Tester sur environ 100 vraies sessions de coding agent, avec des tâches courtes, longues, sous-spécifiées et multi-fichiers.

Demander ensuite au développeur :

> “Would you have wanted DriftLight to flag this?”

Comparer jugement DriftLight / jugement humain.

Mesurer séparément :

- précision des alertes rouges ;
- précision des alertes orange ;
- dérives manquées ;
- faux positifs causés par une dépendance légitime ;
- cas où un changement préexistant est menacé ;
- valeur ajoutée du juge sémantique par rapport aux règles seules.

## Étape 2 — Shadow mode en conditions réelles

Installer DriftLight chez 15 à 20 développeurs utilisant Claude Code sur de vrais repositories pendant une semaine.

Le prototype observe et alerte mais ne bloque aucune action. Après chaque alerte, l’utilisateur peut répondre :

- utile ;
- raisonnable mais non nécessaire ;
- faux positif ;
- action attendue à ajouter au scope.

## Étape 3 — Test d’achat

À la fin de la semaine, proposer réellement DriftLight au prix cible de 39 €, sans réduction artificielle et sans transformer la question en simple sondage d’intention.

Critères de continuation :

- au moins 60 % des testeurs terminent cinq sessions et gardent DriftLight activé ;
- au moins 80 % des alertes rouges sont utiles ;
- au moins 60 % des alertes orange sont raisonnables ;
- moins de 5 % des sessions contiennent une alerte clairement absurde ;
- plusieurs dérives réelles sont détectées avant la fin de la tâche ;
- au moins 25 % des testeurs acceptent réellement de payer.

Critère de continuation :

> Le système doit trouver régulièrement des actions que l’utilisateur considère réellement comme surprenantes, avec suffisamment peu de bruit pour rester activé.

Critère d’arrêt :

> Si les alertes utiles apparaissent trop rarement, si le juge exige trop de configuration manuelle ou si les utilisateurs préfèrent Claude Auto plus `git diff`, DriftLight ne doit pas être développé au-delà du prototype.

---

# 36. MVP idéal en une phrase

> **Une petite pastille toujours visible qui compare ce que tu as demandé à ton coding agent avec ce qu’il est réellement en train de modifier, et devient orange ou rouge lorsqu’il semble sortir du scope.**

---

# 37. Version “landing page”

## Your coding agent is doing more than you asked.

DriftLight watches what your agent changes and compares it with your original request.

**🟢 Within scope**  
`CheckoutButton.tsx`

**🟠 Possible scope drift**  
`package.json`

**🔴 Unexpected change**  
`db/migrations/checkout.sql`

No new IDE.  
No new agent.  
No complicated dashboard.

Just a warning light when your agent goes off-script.
