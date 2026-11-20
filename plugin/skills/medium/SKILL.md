---
name: medium
description: Déléguer à France Student en privilégiant un modèle équilibré.
---

# /medium

Appelle immédiatement `fs_delegate` avec `/medium ` + la demande exacte (`claude-sonnet-5-5` prioritaire), `workspaceRoot`, `contextMode="minimal"` et `waitSeconds=45` sans `read_file` préalable. En `acceptEdits`/`full`, utilise les outils autonomes avec `/undo` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
