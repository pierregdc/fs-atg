---
name: max
description: Déléguer à France Student avec raisonnement maximal (reasoningEffort="max") et modèle Fort.
---

# /max

Appelle immédiatement `fs_delegate` avec `/max ` + la demande exacte, `reasoningEffort="max"`, `workspaceRoot`, `contextMode="minimal"` et `waitSeconds=45` **sans appeler `read_file` avant**. `/max` force le palier Fort (`heavy`) ; en cas d’erreur 502/503/429, la cascade `heavy` → `medium` → `light` s’applique. Réserve `/max` aux tâches complexes (architecture, débogage difficile, sécurité). N’appelle `fs_job_status` que si `status` est `waiting` ou `running`.
