---
name: patch
description: Modifier un fichier existant en lecture seule via patch ciblé (sans écriture autonome).
---

# /patch

Appelle immédiatement `fs_delegate` avec `/patch ` + la modification demandée, `workspaceRoot`, `files` (chemins relatifs lus directement côté France Student **sans appeler `read_file` avant**), `executionMode="patch"`, `contextMode="minimal"` et `waitSeconds=45`. Applique ensuite uniquement les modifications ciblées avec `edit_file`. N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
