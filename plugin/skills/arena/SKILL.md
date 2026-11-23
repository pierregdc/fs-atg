---
name: arena
description: Interroger 2 ou 3 modèles France Student en parallèle pour obtenir un consensus critique via fs_arena.
---

# `/arena` — Consensus & Comparatif Multi-Modèles (`fs_arena`)

Utilise `fs_arena` du serveur MCP `fs-atg` pour soumettre un bug complexe, un choix d'architecture ou une revue de sécurité à **2 ou 3 modèles France Student en parallèle** :

- Passe `prompt` et optionnellement `models: [...]` ou `count: 2` (jusqu'à 3).
- L'outil exécute les générations en parallèle, mesure la latence de chaque modèle et renvoie leurs réponses côte-à-côte (`consensusPreview`).
