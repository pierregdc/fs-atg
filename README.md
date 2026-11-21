<p align="center">
  <img src="media/icon.svg" width="96" height="96" alt="France Student ATG Logo">
</p>

<h1 align="center">France Student pour Antigravity (<code>fs-atg</code> v2.1.0)</h1>

<p align="center">
  <strong>Orchestrateur France Student & intégration MCP native pour Antigravity</strong><br>
  Exécution autonome sur disque, sauvegarde atomique <code>/undo</code>, raisonnement boosté et cascade de résilience 502/429.
</p>

<p align="center">
  <a href="plugin/plugin.json"><img src="https://img.shields.io/badge/version-2.1.0-blue.svg" alt="Version 2.1.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="Licence"></a>
  <a href="#commandes-slash-officielles-8-commandes"><img src="https://img.shields.io/badge/slash%20commands-8%20intégrées-007acc.svg" alt="8 Slash Commands"></a>
  <a href="#sécurité-et-permissions-3-modes"><img src="https://img.shields.io/badge/permissions-3%20niveaux-orange.svg" alt="Permissions 3 niveaux"></a>
</p>

---

## 📸 Interface v2.1 unifiée & épurée

L'interface du panneau latéral a été entièrement revue : design sobre et professionnel monochrome/bleu sans surcharge visuelle, structuration en **3 onglets principaux** et indicateurs visuels clarifiés (pastilles de gamme, badge vert émeraude *Nouveau* et barres d'intensité du raisonnement).

| 🏠 Accueil (Jauge unique, permissions & raisonnement) | 🤖 Modèles (14 modèles FS, dates & badges) |
| :---: | :---: |
| ![Accueil](docs/images/screen-accueil.png) | ![Modèles](docs/images/screen-modeles.png) |

| ⚙️ Réglages (Connexion & comportement) | 📋 Journal & Avancé (Logs & diagnostics) |
| :---: | :---: |
| ![Réglages](docs/images/screen-reglages.png) | ![Journal](docs/images/screen-journal.png) |

---

## ⚡ Nouveautés majeures `v2.1.0`

1. **Design unifié & 3 onglets fluides** :
   - **Accueil** : Jauge unique interactive (budget + coupe-circuit), sélecteur compact *Délégation* / *Permissions*, sélecteur de raisonnement avec barres d'intensité (`Désactivé`, `Standard`, `Élevé`, `Max`), badges de commandes rapides (`/fs`, `/max`, `/patch`, etc.) et historique d'exécution.
   - **Modèles** : Vue aérée avec filtrage instantané, pastilles de gamme sobres (*Fort*, *Équilibré*, *Léger*) et badge émeraude *Nouveau* pour les modèles de moins de 14 jours.
   - **Réglages** : Organisation par sous-onglets (*Essentiel* et *Journal & Avancé*) avec pastille d'alerte en cas d'erreur.

2. **Cascade de résilience 502/429 & Cooldown automatique** :
   - En cas d'erreur réseau ou d'indisponibilité (HTTP 502, 503, 429), bascule intelligente en cascade du **meilleur au moins fort** (`heavy` ➔ `medium` ➔ `light`).
   - Si aucun modèle ne répond : activation automatique d'un **cooldown de 10 minutes** avec comme motif clair : `IA non dispo`, permettant à Antigravity de continuer en natif sans bloquer l'utilisateur.

3. **8 Commandes `/` officielles intégrées au chat Antigravity** :
   - Commandes déclarées nativement dans `skills/` pour un accès immédiat depuis l'éditeur.

---

## 💬 Commandes slash officielles (8 commandes)

| Commande | Action / Rôle | Économie & Effet |
| :--- | :--- | :--- |
| **`/fs`** | Délégation principale avec écriture directe dans `workspaceRoot` | Antigravity ne lit ni ne réécrit les fichiers modifiés (`filesWritten` court) |
| **`/max`** | Mode raisonnement maximal (`reasoningEffort="max"`) | Pour les architectures complexes et les débogages pointus |
| **`/patch`** | Patch ciblé en lecture seule | Génère un patch précis sans modifier le disque directement (**-94,9 %** de tokens) |
| **`/plan`** | Plan d'action en lecture seule | Plan télégraphique structuré en 0 écriture disque |
| **`/eco`** | Profil Éco ultra-rapide | Modèle léger prioritaire avec exécution en moins de 10 secondes |
| **`/undo`** | Restauration atomique (`fs_undo`) | Annule instantanément la dernière modification de France Student |
| **`/remember`** | Mémoire projet persistante (`fs_memory`) | Mémorise des consignes injectées automatiquement dès le premier tour |
| **`/quota`** | Diagnostic et quota en temps réel | Affiche le solde restant, l'état du cooldown `IA non dispo` et la connectivité |

---

## 🛡️ Sécurité et Permissions (3 modes)

- **`plan` (Lecture seule)** : France Student inspecte le code sans jamais écrire sur le disque (`list_directory`, `read_file`, `search_files`).
- **`acceptEdits` (Édition + Undo, défaut)** : Modifications et créations directes de fichiers avec sauvegarde atomique dans la pile `/undo`. Protection stricte des fichiers sensibles (`.env`, `.git`).
- **`full` (Complet + Shell)** : Ajoute l'exécution sécurisée de commandes système (`run_command`, pas de shell arbitraire, filtrage des variables d'environnement).

---

## 📊 Comparatifs de performance mesurés

| Exemple de tâche | Mode & Modèle | Résultat mesuré |
| :--- | :--- | :--- |
| **Création & correction autonome** | `v2.1` `acceptEdits` (`claude-sonnet-5-5`) | 2 tours d'outils, résumé de **269 caractères** envoyé à Antigravity (**3 314 tokens** économisés) |
| **Vérification shell directe** | `v2.1` `full` (`claude-sonnet-5-5`) | Exécution directe (`node --check`, 81 ms), réponse courte de **299 car.** |
| **Patch chirurgical** | `/patch` (`claude-sonnet-5-5`) | **371 car.** au lieu de 7 273 (**-94,9 %** de volume transféré) |
| **Génération rapide** | `/eco` (`claude-haiku-5-5`) | Réponse concise en **7,99 s** |

| Calculatrice 3D (Antigravity vs FS) | Jeu d'Échecs 2D (Antigravity vs FS) |
| :---: | :---: |
| ![Calculatrice Antigravity](docs/images/calc-antigravity.png) ![Calculatrice France Student](docs/images/calc-fs.png) | ![Échecs Antigravity](docs/images/chess-antigravity.png) ![Échecs France Student](docs/images/chess-fs.png) |

---

## 🚀 Installation & Utilisation

```bash
git clone https://github.com/pierregdc/fs-atg.git
cd fs-atg
node install.mjs
```

1. Activez le plugin dans Antigravity.
2. Ouvrez le panneau **France Student [ATG]** depuis la barre latérale.
3. Renseignez votre clé API ou jeton dans l'onglet **Réglages**.
