---
name: high
description: Déléguer à France Student en privilégiant un modèle puissant.
---

# /high

Appelle immédiatement `fs_delegate` avec `/high ` + la demande exacte, `workspaceRoot`, `files` relatifs sans `read_file` préalable si besoin, `contextMode="minimal"` et `waitSeconds=45` (`executionMode="patch"` pour modifier un fichier existant). Applique `response` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si le job n’est pas encore terminé.
