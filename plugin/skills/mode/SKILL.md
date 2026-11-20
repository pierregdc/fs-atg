---
name: mode
description: Changer ou forcer le mode de permission France Student (plan, acceptEdits, full).
---

# /mode

Si une tâche suit (`/mode full lance les tests`, `/mode plan ...`, `/mode acceptEdits ...`), appelle immédiatement `fs_delegate` avec `workspaceRoot`, `permissionMode` correspondant (`plan`, `acceptEdits` ou `full`) et `waitSeconds=45`. Si aucun texte ne suit, indique comment basculer durablement le mode dans les boutons **Permissions PC** du panneau France Student [ATG].
