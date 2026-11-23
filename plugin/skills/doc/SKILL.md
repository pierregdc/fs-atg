---
name: doc
description: Extraire et rechercher localement dans des documents PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) et ZIP via fs_doc.
---

# `/doc` — Lecteur Universel de Documents (`fs_doc`)

Utilise `fs_doc` du serveur MCP `fs-atg` pour lire ou interroger de gros documents (`.pdf`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.zip`, `.md`, `.txt`) sans saturer le contexte Antigravity :

- **`action="search"`** : découpe le document (`path`) en paragraphes et retourne uniquement les `topK` extraits les plus pertinents pour `query`.
- **`action="extract"`** : extrait le texte propre du document (ou la liste des entrées d'une archive `.zip`).
