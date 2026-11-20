---
name: plan
description: Obtenir un plan France Student en lecture seule sans écrire de fichier.
---

# /plan

Appelle immédiatement `fs_delegate` avec `/plan ` + la demande exacte, `workspaceRoot`, `files` relatifs si besoin sans `read_file` préalable, `executionMode="plan"`, `contextMode="minimal"` et `waitSeconds=45`. Retourne un plan télégraphique (≤ 15 lignes) sans écriture disque. N’appelle `fs_job_status` (`waitSeconds=45`) que si `status` est `waiting` ou `running`.
