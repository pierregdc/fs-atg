# Mesurer l'économie de contexte (honnêteté et limites)

`fs-atg` fonctionne en **lecture seule sur le PC** : il ne modifie jamais les fichiers du disque directement et renvoie ses réponses dans `response`. Le gain réel pour **Antigravity** dépend donc directement du type de tâche déléguée.

## Ce qui économise réellement (~50 % à 80 %)

- **Plans télégraphiques (`executionMode: "plan"`)** : France Student produit le plan complet (≤ 15 lignes) en 1 appel ; Antigravity évite plusieurs tours d'exploration et de rédaction.
- **Diagnostics, revues, comparatifs et recherche multi-sources** : toute la synthèse se fait côté France Student sans polluer le contexte Antigravity avec des pages brutes.
- **Blocs ou patches ciblés** : France Student génère uniquement la fonction ou logique complexe sans bavardage autour ; Antigravity l'applique avec un `edit_file` court.

## Ce qui n'économise pas (~0 %)

- **Création complète d'un gros fichier neuf via `write_file`** : comme `fs-atg` est en lecture seule sur le PC, Antigravity doit relire `response` puis réémettre tout le fichier dans `write_file`. Mieux vaut déléguer uniquement la logique difficile ou garder les petits fichiers neufs en natif.
- **Une recherche web simple en 1 requête** : `search_web` natif ne coûte qu'un aller-retour léger ; passer par MCP pour 1 requête simple n'apporte pas de gain net.

## Estimation affichée (`Éco. ATG`)

- `estimateAntigravityJobSavings` ([plugin/fs_core.mjs](../plugin/fs_core.mjs)) utilise un calcul conservateur qui **déduit le coût de lecture** de `response` côté Antigravity (`Math.round(chars / 4)`), au lieu d'un forfait fixe gonflé.
- L'API fournisseur (`usage.input_tokens`, `output_tokens`, `total_tokens`, `reasoning_tokens`) reste tracée telle quelle dans le journal (`fs_logs`) sans extrapolation.

## Résumé simple : où tu gagnes vs où tu ne gagnes pas

- **Gros gain** : `/patch` (**`-94,9 %`** mesurés sur un fichier de `7 273` car. ramené à `371` car., **`-52,2 %`** sur un petit fichier de ~150 lignes), `/plan` (8 à 19 lignes en 8–16 s), `/eco` / `/low` (`433–683` car. en 5–8 s), `/medium` (`~800–2 300` car. en 6–14 s), `/high` (analyses/comparatifs en `2 478` car.), et discussions directes dans le panneau latéral (**`0` token Antigravity**).
- **Pas de gain (`0 %` voire perte)** : créer un gros fichier neuf complet recopié ensuite via `write_file`, faire `1` recherche web simple (`search_web`), ou modifier `< 10` lignes déjà visibles.

## Vérifier votre consommation Antigravity réelle

Le connecteur n'a pas accès au compteur interne d'Antigravity (`ANTIGRAVITY_QUOTA_VISIBILITY.available = false`). Pour vérifier l'impact réel sur votre quota Antigravity, utilisez la commande `/usage` avant et après une tâche comparable.
