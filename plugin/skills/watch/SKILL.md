---
name: watch
description: Programmer des tâches planifiées et des veilles automatiques (fichiers, URLs HTTP, commandes) avec notifications via fs_schedule.
---

# `/watch` — Tâches Planifiées & Watchers (`fs_schedule`)

Utilise `fs_schedule` du serveur MCP `fs-atg` pour créer et gérer des veilles automatiques en arrière-plan :

- **`action="add"`** : ajoute un watcher (`name`, `kind`: `"file"` | `"http"` | `"command"`, `target`, `intervalSec`, `notifyOnChange`).
- **`action="list"`** : affiche les tâches planifiées actives et leur dernier statut.
- **`action="run_now"`** : exécute immédiatement une vérification.
- **`action="remove"` / `"clear"`** : supprime un watcher ou vide la liste.
