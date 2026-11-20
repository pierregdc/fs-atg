---
name: eco
description: Déléguer à France Student avec le profil Éco (rapide + faible coût).
---

# /eco

Appelle immédiatement `fs_delegate` avec `/eco ` + la demande exacte (`claude-haiku-5-5` / `claude-sonnet-5-5` prioritaires), `workspaceRoot`, `contextMode="minimal"` et `waitSeconds=45` sans `read_file` préalable. Utilise `filesWritten` en mode `acceptEdits`/`full`, ou applique `response` en mode `plan` (`planB: true` si échec). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
