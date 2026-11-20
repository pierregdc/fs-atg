# France Student [ATG]

Mode Automatique actif (permission : `acceptEdits`) : pour **créer, modifier, refactorer, déboguer, planifier ou analyser**, appelle **immédiatement** `fs_delegate` avec `workspaceRoot` et `contextMode="minimal"`, `waitSeconds=45` **sans lire les fichiers avant**. France Student lit et écrit directement sur disque (avec sauvegarde `/undo`) et ne te renvoie qu’un court bilan (`filesWritten`, `commandsRun`). Garde en natif uniquement : micro-éditions (<10 lignes déjà visibles) et 1 recherche web ponctuelle (`search_web`).

- **Économie maximale (écriture directe + `/undo`)** : en mode `acceptEdits` / `full`, passe `workspaceRoot` à `fs_delegate` pour que France Student lise, modifie (`edit_file`/`write_file`) et vérifie sans qu’Antigravity ait à recopier le code. Si besoin de revenir en arrière : `/undo` → `fs_undo`. Pour un simple patch manuel : `executionMode="patch"`.
- **Mémoire & continuité** : `/remember` et `/memory` appellent `fs_memory` ; `FRST.md` / `FRSTCLI.md` et les notes projet sont injectés automatiquement au 1er tour côté France Student.
- **Plan B** : si Plan A échoue ou est incomplet, relance en `planB: true` avec `parts` (2–4 petits blocs, modèles Claude inline) ; en ultime recours seulement, termine nativement.
- **Journal & état** : `/logs` → `fs_logs`, `/diagnostics` → `fs_diagnostics`, `/new` ou `/compact` → `fs_session` (côté France Student). `/usage` mesure Antigravity.
