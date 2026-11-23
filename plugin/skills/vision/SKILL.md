---
name: vision
description: Vision d'écran et reconnaissance de texte OCR native Windows WinRT hors-ligne via fs_vision.
---

# `/vision` — Vision & OCR Écran Natif (`fs_vision`)

Utilise `fs_vision` du serveur MCP `fs-atg` pour lire le texte visible à l'écran ou dans une image sans coût de tokens :

- **`action="ocr_screen"`** : capture l'écran (ou `region: {x, y, width, height}`) et extrait toutes les lignes de texte via le moteur OCR natif Windows (`Windows.Media.Ocr`).
- **`action="ocr_image"`** : extrait le texte d'un fichier image (`.png`, `.jpg`, `.bmp`) via `path`.
- **`action="inspect_image"`** : retourne les dimensions, le format, la taille et l'empreinte SHA-256 d'une image.
