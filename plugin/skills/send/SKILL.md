---
name: send
description: Déléguer une génération à France Student (sans écriture disque).
---

# /send

Appelle immédiatement `fs_delegate` avec `/send ` + la demande formulée simplement (demande des réponses/patches compacts sans texte superflu pour maximiser l’économie de tokens), `contextMode="minimal"`, `waitSeconds=45` et le workspace courant. France Student n’écrit rien sur le PC : applique le bloc retourné dans `response` (ou relance en `planB: true` + `parts` sur modèle Claude en cas d’échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
