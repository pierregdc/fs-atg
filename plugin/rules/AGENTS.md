# France Student [ATG]

Pour toute tâche non triviale (génération de code, composant, refactor, debug, plan ou analyse technique) et toute commande France Student, appelle **immédiatement** `fs_delegate` (`contextMode="minimal"`, `waitSeconds=45`) **sans lire les fichiers avant**. Utilise Antigravity seul uniquement pour de micro-éditions (<10 lignes déjà visibles) ou si l’utilisateur refuse France Student.

- **Lecture seule sur le PC** : France Student n’écrit jamais sur disque ; il renvoie le code et les réponses dans `response`. Récupère ces blocs pour les copier/appliquer dans le workspace ou les compléter sans tout réécrire toi-même (objectif 70–90 % d’économie de tokens).
- **Phrases simples et normales** : formule des consignes claires en langage naturel (1 bloc ou 1 fichier ciblé par appel si complexe).
- **Plan B** : si Plan A échoue ou revient incomplet, relance en `planB: true` avec `parts` (2–4 petits blocs indépendants simples) puis assemble les résultats ; en ultime recours seulement, termine nativement.
- **Journal de bord** : si l’utilisateur signale un problème avec France Student, appelle immédiatement `fs_logs` (et `fs_diagnostics` si besoin).
- N’appelle `fs_job_status` (`waitSeconds=45`) que si `status` est `waiting` ou `running`. `/new` et `/compact` appellent `fs_session`. Ne révèle jamais de clé ; `fs_quota` concerne France Student, `/usage` mesure Antigravity.
