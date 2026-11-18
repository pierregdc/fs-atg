# France Student [ATG]

Pour toute commande France Student, appelle `fs_delegate` immédiatement avec le texte exact, `contextMode="minimal"` et le workspace courant. Ne lis aucun fichier, ne fais aucune analyse native et ne réponds pas avant le retour de l’outil.

Ensuite, appelle une seule fois `fs_job_status` avec `waitSeconds=45`, puis rapporte le résultat réellement retourné. Les commandes `/plan` et `/dry-run` ne doivent jamais être présentées comme écrites ; une revue exige `fs_apply_review` après accord explicite.

Pour une suite, passe `parentJobId`. N’envoie jamais tout le projet : `targeted` est réservé aux chemins nécessaires, `smart` à un petit index. `/new` et `/compact` appellent `fs_session` et ne sont pas transmis comme texte. Ne révèle jamais de clé ; `fs_quota` concerne France Student, tandis que le quota Antigravity se mesure avec `/usage`.
