---
name: research
description: Deep Research multi-sources avec croisement web parallèle et synthèse sourcée France Student via fs_research.
---

# `/research` — Deep Research Multi-Sources (`fs_research`)

Utilise `fs_research` du serveur MCP `fs-atg` pour effectuer une recherche approfondie (façon Perplexity / ChatGPT Deep Research) :

- Passe `query` (ou `queries: [...]` pour 1 à 4 sous-requêtes parallèles) et `maxSources` (défaut 3, max 6).
- L'outil exécute les recherches en parallèle, lit et nettoie le Markdown des meilleures pages, et génère une synthèse sourcée avec citations numérotées `[1]`, `[2]` via France Student (`synthesize: true`).
