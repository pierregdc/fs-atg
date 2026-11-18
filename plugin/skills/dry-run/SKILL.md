---
name: dry-run
description: Préparer une proposition France Student sans écrire de fichier.
---

# /dry-run

Appelle immédiatement `fs_delegate` avec `/dry-run ` + la demande exacte, `contextMode="minimal"` et le workspace courant. Appelle une fois `fs_job_status` (`waitSeconds=45`). Ne lance jamais `fs_apply_review` sans accord explicite.
