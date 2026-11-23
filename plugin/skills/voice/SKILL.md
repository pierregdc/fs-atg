---
name: voice
description: Faire parler l'assistant à voix haute (synthèse TTS Windows) ou générer un fichier audio WAV via fs_voice.
---

# `/voice` — Mode Vocal & Synthèse TTS (`fs_voice`)

Utilise `fs_voice` du serveur MCP `fs-atg` pour la synthèse vocale locale Windows (`System.Speech.Synthesis`) :

- **`action="speak"`** : lit `text` à voix haute en arrière-plan (`rate` de `-5` à `+5`).
- **`action="to_wav"`** : génère un fichier audio `.wav` à partir de `text` (`outputPath` optionnel).
- **`action="voices"`** : liste les voix système installées.
