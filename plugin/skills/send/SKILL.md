---
name: send
description: Déléguer une génération à France Student (sans écriture disque).
---

# /send

Appelle immédiatement `fs_delegate` avec `/send ` + la demande formulée simplement, `workspaceRoot`, `files` relatifs si un fichier existant est concerné (sans `read_file` préalable), `contextMode="minimal"` et `waitSeconds=45` (`executionMode="patch"` pour modifier un fichier existant). Applique le bloc retourné dans `response` (ou relance en `planB: true` + `parts` sur modèle Claude si échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
