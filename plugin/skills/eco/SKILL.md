---
name: eco
description: Déléguer à France Student avec le profil Éco.
---

# /eco

Appelle immédiatement `fs_delegate` avec `/eco ` + la demande exacte (privilégie `claude-haiku-5-5` / `claude-sonnet-5-5` rapides en 1 appel), `workspaceRoot`, `files` relatifs sans `read_file` préalable si un fichier est concerné, `contextMode="minimal"` et `waitSeconds=45` (utilise `executionMode="patch"` pour modifier un fichier existant). Applique `response` (`planB: true` + `parts` si échec). N’appelle `fs_job_status` que si le job n’est pas encore terminé.
