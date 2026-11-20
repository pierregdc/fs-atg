# Mesurer l'économie de contexte (`fs-atg` v2.0.0 — honnêteté et limites)

Avec la **v2.0.0**, `fs-atg` prend en charge deux architectures complémentaires selon le mode de permission :

## 1. Mode autonome (`acceptEdits` / `full`, par défaut)

Lorsque `workspaceRoot` est fourni et que les outils client (`clientTools`) sont actifs :
- France Student exécute directement `list_directory`, `search_files`, `read_file`, `edit_file`, `write_file` et (en mode `full`) `run_command` sans shell sur le workspace, avec contrôle de fraîcheur (`FreshnessTracker`) et pile d'annulation `/undo`.
- Antigravity **n'a plus besoin** d'appeler `read_file` ni de réécrire les fichiers dans `write_file` / `edit_file`.
- En retour, `mcpCompactView` ne renvoie à Antigravity qu'un résumé court (`filesWritten`, `commandsRun`, et `response` finale — **269 à 299 car.** mesurés en live sur notre sandbox `v2.0.0`).
- Le gain réel vient donc aussi bien sur la création de fichiers neufs que sur les refactorings multi-fichiers.

## 2. Mode lecture seule (`plan` / `/patch`)

- **`/patch`** (`executionMode: "patch"`) : France Student lit les fichiers côté serveur MCP et renvoie uniquement les extraits à modifier (**`-52,2 %` à `-94,9 %`** de volume mesuré par rapport au fichier complet).
- **`/plan`** (`executionMode: "plan"`) : plan télégraphique ≤ 15 lignes, zéro écriture disque.
- **À garder en natif Antigravity (`~0 %` d'économie)** : micro-édition `< 10` lignes déjà visible dans l'éditeur, et `1` recherche web ponctuelle (`search_web`).

## 3. Protection de la consommation côté France Student

- `enableCanvas: false` et envoi des annexes après `---` (`buildTurn1Annex`) sur la requête initiale, préservant le prompt cache.
- Déduplication `read_file` lorsque le fichier complet n'a pas changé.
- Compression TAP (`digestCommandOutput`) sur `node --test` pour ne conserver que les échecs et le résumé au lieu de milliers de lignes réussies.
- Cooldown automatique sur `HTTP 429` et bascule automatique sur stubs `create_artifact` ou réponses tronquées.

## 4. Vérifier votre quota Antigravity réel

Le connecteur n'a pas accès au compteur interne d'Antigravity (`ANTIGRAVITY_QUOTA_VISIBILITY.available = false`). Utilisez **`/usage`** avant et après une tâche comparable pour mesurer la baisse réelle sur votre compte Antigravity.
