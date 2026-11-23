---
name: web
description: Lire une documentation ou URL en Markdown propre ou rechercher sur le web via fs_web, avec synthèse France Student optionnelle.
---

Appelle immédiatement l'outil MCP `fs_web` de France Student (`fs-atg`) :

- **Lire une URL / documentation** : `fs_web({ action: "fetch", url: "https://...", question: "..." })`. Si `question` est renseigné, France Student lit la page et renvoie directement une synthèse courte pour économiser le quota Antigravity.
- **Rechercher sur le web** : `fs_web({ action: "search", query: "...", limit: 6 })`.
