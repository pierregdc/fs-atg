---
name: low
description: Déléguer à France Student en privilégiant un modèle léger.
---

# /low

Appelle immédiatement `fs_delegate` avec `/low ` + la demande exacte (`claude-haiku-5-5` prioritaire), `workspaceRoot`, `contextMode="minimal"` et `waitSeconds=45` sans `read_file` préalable. N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
