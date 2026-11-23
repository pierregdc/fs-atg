---
name: computer
description: Piloter l'écran, les fenêtres, la souris, le clavier et les captures d'écran façon Computer Use via fs_computer.
---

Appelle immédiatement l'outil MCP `fs_computer` de France Student (`fs-atg`) :

1. **Inspection ou capture d'écran** :
   - `fs_computer({ action: "screen_info" })` pour obtenir la résolution des écrans, la position du curseur et la fenêtre active.
   - `fs_computer({ action: "screenshot" })` pour capturer l'écran (ou une `region: { x, y, width, height }`) en PNG.
   - `fs_computer({ action: "windows" })` pour lister les fenêtres ouvertes, puis `fs_computer({ action: "focus_window", title: "..." })` pour activer une fenêtre.
2. **Actions souris et clavier** (nécessitent le mode `acceptEdits` ou `full` avec Computer Use activé) :
   - Souris : `click`, `double_click`, `right_click`, `mouse_move`, `drag`, `scroll` avec coordonnées `x`, `y`.
   - Clavier : `type` (`text`), `key` ou `hotkey` (`key: "Enter"`, `"Ctrl+C"`, `"Alt+Tab"`).
   - Presse-papiers : `clipboard_get`, `clipboard_set`.
