---
name: patch
description: Modifier un fichier existant via un patch minimal TARGET/REPLACE sans le réécrire (économie maximale).
---

# /patch

Appelle immédiatement `fs_delegate` avec `/patch ` + la modification demandée, `workspaceRoot`, `files` (chemins relatifs à lire côté France Student **sans appeler `read_file` avant**), `executionMode="patch"`, `contextMode="minimal"` et `waitSeconds=45`. Applique ensuite uniquement les paires `TARGET` / `REPLACE` reçues avec `edit_file` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
