---
name: low
description: Déléguer à France Student en privilégiant un modèle léger.
---

# /low

Appelle immédiatement `fs_delegate` avec `/low ` + la demande exacte (`claude-haiku-5-5` prioritaire), `workspaceRoot`, `files` relatifs sans `read_file` préalable si besoin, `contextMode="minimal"` et `waitSeconds=45` (`executionMode="patch"` pour modifier un fichier existant). N’appelle `fs_job_status` que si le job n’est pas encore terminé.
