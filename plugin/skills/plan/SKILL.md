---
name: plan
description: Obtenir un plan de modification France Student sans écrire de fichier.
---

# /plan

Appelle immédiatement `fs_delegate` avec `/plan ` + la demande exacte, `contextMode="minimal"` et le workspace courant. Appelle une fois `fs_job_status` (`waitSeconds=45`) ; indique seulement le plan retourné et qu’aucun fichier n’est écrit.
