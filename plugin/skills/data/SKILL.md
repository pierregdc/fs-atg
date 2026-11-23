---
name: data
description: Code Interpreter, profilage statistique CSV/JSON et génération de graphiques SVG via fs_data.
---

# `/data` — Code Interpreter & Data Analyst (`fs_data`)

Utilise `fs_data` du serveur MCP `fs-atg` pour analyser un jeu de données sans charger le fichier brut dans le contexte Antigravity :

1. **Profilage statistique (`action="profile"`)** : types de colonnes, valeurs manquantes, min/max/moyenne/médiane/écart-type, top catégories (`filePath` ou `data`).
2. **Requêtes & agrégations (`action="query"`)** : filtre (`filterColumn`, `filterOp`, `filterValue`), regroupement (`groupBy`, `aggColumn`, `aggOp`: `count`/`sum`/`avg`/`min`/`max`) et tri (`sortBy`, `sortOrder`).
3. **Graphiques SVG (`action="chart"`)** : génère un graphique `bar` ou `line` autonome en `.svg`.
4. **Exécution sandbox (`action="run_js"` / `action="run_python"`)** : exécute un script d'analyse Node.js ou Python isolé avec timeout.
