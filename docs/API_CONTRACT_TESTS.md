# Test contractuel API

`npm run test:api-contract` est un probe **opt-in** et strictement en lecture :
il vérifie les formats des endpoints GET effectivement utilisés par
l’intégration, sans lire le fichier d’état local et sans afficher le jeton.

```powershell
$env:FS_ATG_CONTRACT_TOKEN = 'votre-jeton'
npm run test:api-contract
```

Optionnellement, `FS_ATG_CONTRACT_BASE_URL` cible un environnement de test en
HTTPS. Les endpoints non offerts par un compte (HTTP 404) sont signalés comme
indisponibles, pas comme une réussite. Le probe exige `/user/usage` et au moins
une des listes de modèles (`/models` ou `/v1/models`) ; les autres capacités
restent optionnelles selon le compte et la version de l’API.

Le rapport JSON distingue `available` (l’endpoint a répondu 2xx) de `valid`
(la forme minimale attendue a été reconnue). Il ne démontre pas que toutes les
fonctions distantes sont autorisées pour le compte : ce test vérifie seulement
les contrats GET consommés par l’intégration, à l’instant où il est lancé.
