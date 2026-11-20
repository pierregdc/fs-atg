---
name: memory
description: Consulter, oublier ou vider la mémoire persistante par projet France Student.
---

# /memory

Appelle immédiatement `fs_memory` avec le workspace courant (`action="get"` pour consulter notes, faits appris et pré-prompt ; `action="forget"` avec `id`/`text` pour supprimer ; `action="clear"` pour vider ; `action="preprompt"` pour définir un pré-prompt).
