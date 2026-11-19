# France Student [ATG]

Mode Automatique actif : délègue immédiatement à `fs_delegate` (`contextMode="minimal"`, `waitSeconds=45`) **sans lire les fichiers avant** (passe `workspaceRoot` + `files` relatifs à `fs_delegate`) pour : **modifications de fichiers existants (`executionMode="patch"`), plans (`executionMode="plan"`), revues/audits, recherches multi-sources, debug et fonctions ciblées**. Garde en natif uniquement : micro-éditions (<10 lignes déjà en contexte), **1 recherche web simple** (`search_web`), ou gros fichier neuf complet réécrit via `write_file` (sauf logique complexe / découpage).

- **Boost économie maximal** : passe `files` en lecture seule à `fs_delegate` (évite les `read_file` Antigravity), utilise `executionMode="patch"` sur fichier existant (-52 % à -70 % mesurés) et `executionMode="plan"` pour cadrer en ≤ 15 lignes, et vise 1 seul appel `< 45s` (`claude-haiku-5-5` / `claude-sonnet-5-5` rapides sans artefact).
- **Lecture seule sur le PC** : France Student n’écrit jamais sur disque ; applique ses blocs/patches courts avec `edit_file`.
- **Plan B** : si Plan A échoue ou est incomplet, relance en `planB: true` avec `parts` (2–4 petits blocs indépendants, modèles Claude inline) ; en ultime recours seulement, termine nativement.
- **Journal & état** : `/logs` → `fs_logs`, `/diagnostics` → `fs_diagnostics`, `/new` ou `/compact` → `fs_session` (côté France Student). `/usage` mesure Antigravity.
