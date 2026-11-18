---
name: send
description: Déléguer une tâche de code à France Student.
---

# /send

Appelle immédiatement `fs_delegate` avec `/send ` + la demande exacte, `contextMode="minimal"` et le workspace courant. Sans lire de fichier ni analyser, appelle ensuite une fois `fs_job_status` (`waitSeconds=45`) et rends uniquement son résultat.
