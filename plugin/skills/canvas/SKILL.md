---
name: canvas
description: Créer et prévisualiser en direct des artifacts interactifs HTML/SVG/Mermaid/3D via fs_canvas.
---

# `/canvas` — Artifacts & Live Canvas (`fs_canvas`)

Utilise `fs_canvas` du serveur MCP `fs-atg` pour créer et servir en direct des composants visuels interactifs (façon Claude Artifacts / ChatGPT Canvas) :

- **`action="create"` / `"update"`** : enregistre un artifact (`type`: `"html"`, `"svg"` ou `"mermaid"`, `title`, `content`) et démarre un serveur HTTP local de prévisualisation (`previewUrl`).
- **`action="list"` / `"get"` / `"clear"`** : liste, récupère ou nettoie les artifacts Canvas.
