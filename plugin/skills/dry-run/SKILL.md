---
name: dry-run
description: Générer un aperçu de code France Student sans écrire sur le PC.
---

# /dry-run

Appelle immédiatement `fs_delegate` avec `/dry-run ` + la demande exacte, `workspaceRoot`, `files` relatifs sans `read_file` préalable si besoin, `contextMode="minimal"` et `waitSeconds=45`. Présente l’aperçu retourné sans écrire sur disque et demande confirmation avant toute application. N’appelle `fs_job_status` que si le job n’est pas encore terminé.
