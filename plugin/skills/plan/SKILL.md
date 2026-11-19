---
name: plan
description: Obtenir un plan France Student sans écrire de fichier.
---

# /plan

Appelle immédiatement `fs_delegate` avec `/plan ` + la demande exacte, `contextMode="minimal"`, `waitSeconds=45` et le workspace courant. N’appelle `fs_job_status` (`waitSeconds=45`) que si le job n’est pas encore terminé ; indique le plan retourné dans `response` et qu’aucun fichier n’est écrit.
