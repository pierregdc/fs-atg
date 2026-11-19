---
name: medium
description: Déléguer à France Student en privilégiant un modèle équilibré.
---

# /medium

Appelle immédiatement `fs_delegate` avec `/medium ` + la demande exacte, `contextMode="minimal"`, `waitSeconds=45` et le workspace courant. Récupère `response` pour l’appliquer si besoin (Plan B via `planB: true` + `parts` si échec). N’appelle `fs_job_status` que si le job n’est pas encore terminé.
