---
name: browse
description: Automatiser Chrome ou Edge en mode headless ou visible via CDP (fs_browser : open, snapshot, screenshot, click, fill, eval).
---

Appelle immédiatement l'outil MCP `fs_browser` de France Student (`fs-atg`) pour naviguer, inspecter ou automatiser une page web via Chrome DevTools Protocol (CDP) :

1. `fs_browser({ action: "open", url: "https://...", headless: true })` (ou `headless: false` pour ouvrir une fenêtre visible) : ouvre la page et retourne son **snapshot interactif compact** (titre, texte, boutons/champs/liens numérotés avec sélecteurs CSS).
2. `fs_browser({ action: "click", selector: "..." })` (ou `text: "..."`) et `fs_browser({ action: "fill", selector: "...", value: "..." })` pour interagir avec les éléments.
3. `fs_browser({ action: "screenshot" })` pour capturer un rendu PNG exact de la page, `action: "console"` pour lire les erreurs JS de la page, et `action: "close"` en fin de session.
