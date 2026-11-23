<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/logo-light.svg">
    <img src="docs/images/logo-light.svg" alt="France Student" width="380">
  </picture>
</p>

<h1 align="center">France Student pour Antigravity (<code>fs-atg</code> v2.3.0)</h1>

<p align="center">
  <strong>Orchestrateur France Student &amp; serveur MCP <code>stdio</code> (15 outils) pour Antigravity</strong><br>
  Exécution autonome sur le workspace, Computer Use (écran, fenêtres, souris, clavier), Navigateur CDP (<code>/browse</code>), Lecture &amp; Recherche Web (<code>/web</code>), sauvegarde atomique <code>/undo</code>, contrôle par modèle (Oui / À demander / Non) et cascade de résilience 502/429.
</p>

<p align="center">
  <a href="plugin/plugin.json"><img src="https://img.shields.io/badge/version-2.3.0-2563eb?style=flat-square" alt="Version 2.3.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-334155?style=flat-square" alt="Licence MIT"></a>
  <a href="#commandes-slash-officielles"><img src="https://img.shields.io/badge/commandes-11%20slash-2563eb?style=flat-square" alt="11 commandes slash"></a>
  <a href="#securite-et-permissions"><img src="https://img.shields.io/badge/MCP-15%20outils-475569?style=flat-square" alt="15 outils MCP"></a>
</p>

---

## Aperçu de l'interface

L'interface du panneau latéral adopte un thème monochrome/slate et bleu unifié sans surcharge visuelle, structuré en **3 onglets principaux** (**Accueil**, **Modèles**, **Réglages**) avec indicateurs clarifiés : pastilles de gamme (`Fort`, `Équilibré`, `Léger`), badge émeraude `Nouveau` (< 14 jours), barres d'intensité du raisonnement et sélecteur d'autorisation par modèle.

| Accueil (jauge unique, permissions &amp; raisonnement) | Modèles (contrôle Oui / À demander / Non &amp; badges) |
| :---: | :---: |
| ![Accueil](docs/images/screen-accueil.png) | ![Modèles](docs/images/screen-modeles.png) |

| Réglages (connexion &amp; comportement) | Journal &amp; Avancé (logs &amp; diagnostics) |
| :---: | :---: |
| ![Réglages](docs/images/screen-reglages.png) | ![Journal](docs/images/screen-journal.png) |

---

## Nouveautés v2.3 — Computer Use, Navigateur CDP, Web &amp; Système

- **`fs_computer` (`/computer` — Computer Use Windows)** : capture d'écran PNG (`screenshot`, avec protection des surfaces DirectX plein écran), topologie multi-écrans et position du curseur (`screen_info`), liste et focus des fenêtres (`windows`, `focus_window`), actions souris (`mouse_move`, `click`, `double_click`, `right_click`, `drag`, `scroll`), saisie clavier et raccourcis (`type`, `key`, `hotkey` avec blocage des combinaisons système critiques) et presse-papiers (`clipboard_get`, `clipboard_set`).
- **`fs_browser` (`/browse` — Automatisation Chrome/Edge par CDP)** : pilote Chrome ou Edge en mode headless ou visible sans dépendance externe via Chrome DevTools Protocol (`open`, `snapshot` DOM interactif compact, `screenshot`, `click`, `fill`, `press`, `scroll`, `eval`, `console`, `close`).
- **`fs_web` (`/web` — Lecture Web Markdown &amp; Recherche)** : convertit toute page ou documentation en Markdown propre sans bruit HTML (`fetch`), effectue des recherches web (`search`), et peut déléguer la lecture d'une longue documentation à France Student (`question`) pour ne renvoyer qu'une synthèse courte à Antigravity.
- **`fs_system` (Inspection Système, Processus &amp; Ports TCP)** : bilan CPU/RAM/OS (`overview`), top processus par mémoire (`processes`), propriétaires des ports TCP en écoute (`ports`) et notifications bureau (`notify`).
- **Timeout SSE glissant** : le timeout de génération se réarme à chaque frame SSE reçue et à chaque tour d'outil local.

---

## Nouveautés v2.2

- **Télémétrie par modèle (7 jours)** : mesure le débit réel (`tok/s`), le délai avant premier token (`TTFT`), le taux de succès et le nombre de replis `429/502`, affichés sur chaque carte de l'onglet **Modèles** avec alerte d'instabilité.
- **Configuration portable** : export et import JSON sans secret dans **Réglages -> Avancé** (politiques modèles, profils, permissions, seuils).
- **Cache de lecture (60 s)** : met en cache `list_directory` et `search_files`, invalidé automatiquement à chaque écriture ou commande.
- **Commande `/model <nom>`** : force un modèle précis directement depuis le prompt.
- **Diff avant `/undo`**, **jauge de contexte**, **notifications de fin de tâche (> 15 s)** et **trousseau système macOS / Linux** (`security` / `secret-tool`).
- **Optimisation gros jobs (`v2.2.1`)** : `waitSeconds` porté à `120 s` (`180 s` max), timeout stream outils à `240 s`, cooldown groupé sur saturation `openai_v2` et maintien de `clientTools` sur erreur réseau transitoire.

---

## Nouveautés v2.1

- **Connexion navigateur en 1 clic (session longue durée)** : depuis l'accueil ou **Réglages -> Essentiel**, clique sur *Se connecter avec France Student* pour ouvrir la page officielle de connexion, te connecter avec tes identifiants habituels, puis laisser l'extension chiffrer la session dans le **Trousseau Windows** (`Windows Credential Manager`) et renouveler automatiquement tes jetons d'accès (`/api/auth/api-token`) avant expiration ou sur HTTP 401. Une option repliable *Connexion manuelle* reste disponible.
- **Contrôle individuel par modèle (`Oui` / `À demander` / `Non`)** : autorise, bloque ou exige une confirmation utilisateur explicite avant qu'Antigravity ou le panneau n'utilise un modèle.
- **Interface unifiée en 3 onglets** :
  - **Accueil** : jauge unique interactive (budget chat restant + coupe-circuit réglable de 0 % à 90 %), sélecteurs compacts *Délégation* et *Permissions PC*, barre de commandes rapides (`/fs`, `/max`, `/patch`, `/plan`, `/eco`, `/remember`), sélecteur de raisonnement à 3 niveaux (*Standard*, *Approfondi*, *Maximum*) et historique détaillé avec `/undo`.
  - **Modèles** : catalogue filtrable avec fournisseur, fenêtre de contexte, date de détection, badge `Nouveau` (< 14 jours) et contrôle 3 états sur chaque carte.
  - **Réglages** : sous-onglets *Essentiel*, *Mémoire* (`FRST.md`, notes, pré-prompt) et *Journal &amp; Avancé* avec badge d'erreurs sur l'onglet.
- **Cascade de résilience 502/429 &amp; Cooldown `IA non dispo`** : en cas d'erreur HTTP 502, 503, 504 ou 429, bascule automatique du meilleur modèle au moins fort (`heavy` -> `medium` -> `light`). Si aucun modèle autorisé ne répond, un **cooldown global de 10 minutes (`IA non dispo`)** est activé pour laisser Antigravity travailler en natif sans blocage.
- **8 commandes slash officielles** déclarées dans `plugin/skills/` pour le chat Antigravity.

---

## Contrôle par modèle (Oui / À demander / Non)

Dans l'onglet **Modèles**, chaque modèle dispose d'un sélecteur persistant (`.fsatg_state.json`) qui gouverne à la fois le serveur MCP (`fs_delegate`) et les générations du panneau :

| État | Valeur | Comportement sur le routage, `fs_delegate` et la cascade 502/429 |
| :--- | :--- | :--- |
| **Oui** | `allow` | Utilisable librement par le routeur et par les replis automatiques. |
| **À demander** | `ask` | Si le modèle est choisi ou recommandé, `fs_delegate` retourne `status: "needs_approval"` avec jusqu'à 3 alternatives en `Oui` : Antigravity demande confirmation à l'utilisateur avant de relancer avec `approveModel`. Exclu des bascules silencieuses de la cascade 502/429. |
| **Non** | `deny` | Totalement exclu du routage automatique, de la cascade de secours et des sélections explicites (`Utiliser` masqué, erreur explicite en cas d'appel direct). |

---

## Commandes slash officielles

| Commande | Outil / Paramètre | Effet et économie de quota Antigravity |
| :--- | :--- | :--- |
| **`/fs`** | `fs_delegate` (`workspaceRoot`) | Délégation principale avec lecture/écriture directe sur disque et sauvegarde `/undo` ; seul un bilan court (`filesWritten`) revient à Antigravity. |
| **`/max`** | `reasoningEffort="max"` | Active le protocole de raisonnement maximal et priorise les modèles `Fort`. |
| **`/patch`** | `executionMode="patch"` | Mode lecture seule : renvoie uniquement les blocs `TARGET` / `REPLACE` à appliquer (**-94,9 %** mesurés). |
| **`/plan`** | `executionMode="plan"` | Mode lecture seule : plan d'action télégraphique (<= 15 lignes), zéro écriture disque. |
| **`/eco`** | `routingProfile="eco"` | Profil rapide économe : privilégie les modèles `Léger` (`< 10 s`). |
| **`/undo`** | `fs_undo` | Restaure atomiquement la dernière écriture ou création de fichier de France Student. |
| **`/remember`** | `fs_memory` | Enregistre une règle ou note persistante injectée automatiquement au 1er tour (`FRST.md` + mémoire projet). |
| **`/quota`** | `fs_quota` + `fs_diagnostics` | Affiche le quota restant, l'état du cooldown `IA non dispo`, les modèles disponibles et le diagnostic API. |

---

## Sécurité et permissions

Trois modes de permission PC encadrent les outils locaux de France Student :

- **`plan` (Lecture seule)** : autorise uniquement `list_directory`, `read_file` et `search_files` (idéal pour `/plan` et `/patch`).
- **`acceptEdits` (Édition + Undo, défaut)** : autorise `edit_file` et `write_file` atomiques avec contrôle de fraîcheur anti-écrasement, protection `.env` / `.git` / liens symboliques et pile de restauration `/undo` (jusqu'à 30 entrées par workspace).
- **`full` (Complet + Shell)** : ajoute `run_command` sans interpréteur shell (`shell: false`), filtrage des variables d'environnement sensibles et blocage des commandes destructrices.

---

## Comparatifs mesurés

### Benchmark réel `/usage` Antigravity (3 tâches complètes : API REST, Dashboard Web, Audit sécurité)

Mesuré sur **Gemini 4 Neon Medium** avec la même suite de 3 projets :

| Mode | Livrable produit | Antigravity Weekly | Antigravity 5h | France Student |
| :--- | :--- | :--- | :--- | :--- |
| **SANS extension** (natif pur) | 14 fichiers, **864 lignes**, 7/7 tests | `81 %` -> `79 %` (**`-2 %`**) | `98 %` -> `93 %` (**`-5 %`**) | `0 %` |
| **AVEC extension (`v2.2.1`)** | 14 fichiers, **1 603 lignes**, **45/45 tests** | `73 %` -> `72 %` (**`-1 %`**) | `100 %` -> `94 %` (**`-6 %`**) | `15,55 %` -> `7,60 %` (**`-7,95 %`**) |

- **Coût brut dans un chat déjà chargé** : `-5 %` vs `-6 %` sur la limite 5h (les tours `fs_delegate`/`fs_job_status` repaient l'historique Antigravity en entrée).
- **Coût ramené au volume livré** : **`~35 %` d'économie** (`3,74 %` vs `5,79 %` par 1 000 lignes générées, avec **6,4x** plus de tests).
- **Depuis le panneau latéral** : **100 % d'économie Antigravity** (`0 %` consommé).

### Mesures unitaires par commande / mode

| Exemple de tâche | Mode &amp; Modèle | Résultat mesuré |
| :--- | :--- | :--- |
| **Édition et création autonome (`math.mjs` + `greet.mjs`)** | `acceptEdits` (`claude-sonnet-5-5`) | 2 tours d'outils, bilan de **269 caractères** envoyé à Antigravity (**3 314 tokens** économisés). |
| **Vérification syntaxique directe (`node --check`)** | `full` (`claude-sonnet-5-5`) | Exécution sans shell (`exit 0`, 81 ms), réponse de **299 caractères**. |
| **Patch ciblé sans écriture (`calculator-3d`)** | `/patch` (`claude-sonnet-5-5`) | **371 caractères** transférés au lieu de 7 273 (**-94,9 %**). |
| **Utilitaire court (`formatBytes`)** | `/eco` (`claude-haiku-5-5`) | **433 caractères** en **7,99 s**. |

| Calculatrice 3D (Antigravity vs FS) | Jeu d'Échecs 2D (Antigravity vs FS) |
| :---: | :---: |
| ![Calculatrice Antigravity](docs/images/calc-antigravity.png) ![Calculatrice France Student](docs/images/calc-fs.png) | ![Échecs Antigravity](docs/images/chess-antigravity.png) ![Échecs France Student](docs/images/chess-fs.png) |

---

## Installation

```bash
git clone https://github.com/pierregdc/fs-atg.git
cd fs-atg
node install.mjs
```

1. Rechargez Antigravity puis activez l'extension **France Student [ATG]**.
2. Ouvrez le panneau latéral et cliquez sur **Se connecter** (ou dans **Réglages -> Essentiel -> Se connecter avec France Student**) pour connecter votre compte en 1 clic et activer le renouvellement automatique de session.
3. Ajustez vos permissions et le contrôle **Oui / À demander / Non** de chaque modèle dans l'onglet **Modèles**.
