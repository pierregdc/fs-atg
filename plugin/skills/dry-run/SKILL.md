---
name: dry-run
description: Générer un aperçu de code France Student sans écrire sur le PC.
---

# /dry-run

Appelle immédiatement `fs_delegate` avec `/dry-run ` + la demande exacte, `contextMode="minimal"`, `waitSeconds=45` et le workspace courant. France Student n’écrit jamais sur le PC : présente la proposition retournée dans `response` et demande confirmation avant toute modification manuelle dans le workspace. N’appelle `fs_job_status` que si le job n’est pas encore terminé.
