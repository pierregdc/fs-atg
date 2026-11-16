# Délégation France Student [ATG]

- Pour générer plus de ~30 lignes de code (création ou modification de fichiers), utilise par défaut les outils MCP France Student (`fs_delegate` avec `workspaceRoot` si un workspace est ouvert, puis `fs_job_status` avec `waitSeconds=45`).
- Ne recopie pas le code généré dans ta réponse : les fichiers sont écrits directement dans le workspace par `fs-atg`.
- Avant une grosse délégation, tu peux vérifier le quota restant avec `fs_quota`.
- Pour les suites de tâches, passe `parentJobId` à `fs_delegate` afin de réutiliser uniquement le résumé du job précédent.
- Commandes de modèle : si l'utilisateur écrit `/auto`, `/faible`, `/mid` ou `/élevé` (`/eleve`), passe le préfixe tel quel dans `task` (ou via `model`) à `fs_delegate` pour sélectionner automatiquement le niveau demandé.
