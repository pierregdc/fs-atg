# France Student [ATG]

Mode Automatique actif : délègue immédiatement à `fs_delegate` (`contextMode="minimal"`, `waitSeconds=45`) **sans lire les fichiers avant** pour les **plans, revues/audits, recherches approfondies multi-sources, explications, debug complexe et logiques/fonctions ciblées**. Garde en natif : micro-éditions (<10 lignes), **1 recherche web simple ponctuelle** (`search_web`), et **création complète d’un gros fichier neuf** si Antigravity devait de toute façon tout réécrire via `write_file` (ou demande alors uniquement les parties complexes/scripts courts pour économiser vraiment).

- **Lecture seule sur le PC (économie maximale)** : France Student n’écrit jamais sur disque ; il renvoie le résultat dans `response`. Pour économiser les tokens Antigravity, demande des **réponses compactes, plans télégraphiques, diagnostics ou blocs/patches ciblés** plutôt que de gros fichiers entiers à recopier ligne par ligne.
- **Consignes concises** : formule des demandes simples en langage naturel en exigeant du code sans blabla ni commentaires superflus.
- **Plan B** : si Plan A échoue ou est incomplet, relance en `planB: true` avec `parts` (2–4 petits blocs indépendants, modèle Claude recommandé pour le code web inline sans artefact) ; en ultime recours seulement, termine nativement.
- **Journal de bord** : si l’utilisateur signale un problème avec France Student, appelle immédiatement `fs_logs` (et `fs_diagnostics` si besoin).
- N’appelle `fs_job_status` (`waitSeconds=45`) que si `status` est `waiting` ou `running`. `/new` et `/compact` appellent `fs_session`. Ne révèle jamais de clé ; `fs_quota` concerne France Student, `/usage` mesure Antigravity.
