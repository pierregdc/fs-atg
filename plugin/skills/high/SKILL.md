---
name: high
description: Déléguer à France Student en privilégiant un modèle puissant.
---

# /high

Appelle immédiatement `fs_delegate` avec `/high ` + la demande exacte, `workspaceRoot`, `contextMode="minimal"` et `waitSeconds=45` sans `read_file` préalable. En `acceptEdits`/`full`, France Student lit et modifie directement avec sauvegarde `/undo` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
