---
name: plan
description: Obtenir un plan France Student sans écrire de fichier.
---

# /plan

Appelle immédiatement `fs_delegate` avec `/plan ` + la demande exacte, `workspaceRoot`, `files` relatifs sans `read_file` préalable si besoin, `contextMode="minimal"` et `waitSeconds=45`. Retourne un plan télégraphique (≤ 15 lignes) sans écriture fichier. N’appelle `fs_job_status` (`waitSeconds=45`) que si le job n’est pas encore terminé.
