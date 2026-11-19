---
name: send
description: Déléguer une génération à France Student (sans écriture disque).
---

# /send

Appelle immédiatement `fs_delegate` avec `/send ` + la demande formulée simplement, `contextMode="minimal"`, `waitSeconds=45` et le workspace courant. France Student n’écrit rien sur le PC : récupère le code/la réponse retournée dans `response` pour l’appliquer dans le workspace (ou relance en `planB: true` + `parts` en cas d’échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
