---
name: logs
description: Consulter le journal de bord France Student en cas de problème.
---

# /logs

Appelle immédiatement `fs_logs` (`limit=40`), puis résume clairement les erreurs ou avertissements récents trouvés et propose la correction adaptée (appelle `fs_diagnostics` uniquement si les logs indiquent un problème réseau/API/trousseau).
