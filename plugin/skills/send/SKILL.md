---
name: send
description: Déléguer à France Student (exécution directe en acceptEdits/full ou réponse inline).
---

# /send

Appelle immédiatement `fs_delegate` avec `/send ` + la demande formulée simplement, `workspaceRoot`, `contextMode="minimal"` et `waitSeconds=45` **sans appeler `read_file` avant**. En mode `acceptEdits`/`full`, France Student lit/écrit directement sur disque avec `/undo` ; en mode `plan`, applique les blocs retournés via `edit_file` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
