---
name: low
description: Déléguer à France Student en privilégiant un modèle léger.
---

# /low

Appelle immédiatement `fs_delegate` avec `/low ` + la demande exacte, `contextMode="minimal"`, `waitSeconds=45` et le workspace courant. Récupère `response` pour l’appliquer si besoin. N’appelle `fs_job_status` que si le job n’est pas encore terminé.
