---
name: medium
description: Déléguer à France Student en privilégiant un modèle équilibré.
---

# /medium

Appelle immédiatement `fs_delegate` avec `/medium ` + la demande exacte (`claude-sonnet-5-5` prioritaire), `workspaceRoot`, `files` relatifs sans `read_file` préalable si besoin, `contextMode="minimal"` et `waitSeconds=45` (`executionMode="patch"` pour modifier un fichier existant). Applique `response` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si le job n’est pas encore terminé.
