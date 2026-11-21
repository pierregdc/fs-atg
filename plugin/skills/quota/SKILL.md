---
name: quota
description: Vérifier le quota France Student, le cooldown « IA non dispo » et le diagnostic de connexion en lecture seule.
---

# /quota

Appelle `fs_quota` (pourcentage restant `remainingPct`, seuil du coupe-circuit `cutoff`, `resetAt`), puis `fs_diagnostics` (connexion, modèles, cooldown `IA non dispo` éventuel). Rends uniquement les états réellement retournés, y compris la limite : le quota du compte Antigravity n’est pas lisible par le connecteur (le mesurer avec `/usage`). Si `remainingPct` est sous `cutoff` ou si un cooldown est actif, signale-le en 1 ligne. Ne révèle jamais de clé ni de jeton.
