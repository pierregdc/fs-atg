# Mesurer l'économie de contexte

L'extension vise à réduire le contexte que **Antigravity doit transporter ou relire**. Elle ne promet pas de réduire à elle seule la facture interne du fournisseur : un fournisseur peut compter son propre message système, l'historique du chat et les appels outils.

## Méthode

L'estimation locale est volontairement simple : `ceil(nombre_de_caractères / 4)`. Elle sert à comparer deux stratégies pour la même demande ; ce n'est pas une mesure de facturation France Student.

Le test `test/mini_project.integration.test.mjs` utilise la mini-app `test/fixtures/mini-app` : trois fichiers, 1 861 caractères de code et une demande de persistance `localStorage`.

| Stratégie | Contenu transmis avant le travail | Caractères | Estimation locale | Économie vs. recopie complète |
|---|---|---:|---:|---:|
| Ancienne approche | Demande + trois fichiers complets | 2 037 | 510 tokens | — |
| `targeted` | Demande + trois chemins | 131 | 33 tokens | 93,5 % |
| `minimal` | Demande seule | 76 | 19 tokens | 96,3 % |

Après le premier tour, le chat direct persistant utilise `POST /chats/{chatId}` et n'envoie à nouveau ni les règles initiales, ni les fichiers, ni le résumé complet du parent. Le modèle demande les lignes nécessaires avec `read_file` ou `search_files` et écrit directement dans le workspace.

Le mode `smart` ajoute seulement un index local borné (chemins, noms de symboles
et imports) lorsque cette information aide à choisir les premiers fichiers. Il ne
remplace pas le mode minimal pour une tâche simple. Si les outils client sont
indisponibles, une session persistante peut recevoir un diff plutôt que le fichier
complet, mais seulement si ce diff est plus court et que le chat possède déjà la
version de base ; sinon l’intégration envoie le fichier complet.

## Ce que les chiffres signifient

- Ils mesurent un gain de **prompt transporté par l'intégration** et, surtout, de contexte qui ne revient pas dans la conversation Antigravity.
- Les résultats réels dépendent du nombre de fichiers, de leur taille et des appels outils du modèle.
- Le gain est faible pour une demande d'une ligne sans fichier ; il devient important dès qu'une ancienne intégration aurait recopié des sources, un README ou un document entier.
- Le panneau distingue l’**estimation locale avant envoi** de l’**usage fourni par le fournisseur** après réponse. Les champs d’usage absents restent absents : ils ne sont pas remplacés par zéro ni par une estimation.
- Les champs fournisseur (par exemple `input_tokens`, `output_tokens` ou `total_tokens`) restent la seule référence de consommation quand l’API les fournit ; leur absence ne permet aucune déduction sur la facturation.
- La reprise après un refus est limitée à une tentative sur un modèle de la même gamme : elle ne doit pas être interprétée comme une économie de tokens et ne boucle jamais.

## Vérifier le quota Antigravity sans inventer de gain

Le quota Antigravity n’est pas accessible au connecteur et ne doit jamais être déduit des tokens France Student, d’une estimation locale ou d’un nombre de caractères. Pour mesurer un gain réel, relève `/usage`, lance exactement la même tâche dans une nouvelle conversation avec le même modèle et les mêmes permissions, puis relève `/usage` de nouveau.

Une comparaison est valable seulement si les deux essais atteignent réellement France Student et finissent le travail. Exclure les essais bloqués avant l’appel MCP, les refus, les reprises et les tours de correction : ils peuvent consommer du quota Antigravity sans mesurer la délégation. Tant qu’un essai de référence et un essai avec délégation n’ont pas été réalisés dans ces conditions, aucun facteur « 3× », « 4× » ou « 10× » ne peut être annoncé.

La conception vise cependant à minimiser le travail natif : une commande slash appelle d’abord `fs_delegate`, avec `contextMode="minimal"`; elle ne demande ni exploration ni résumé du projet à Antigravity. Le code, les itérations et le contexte de fichier restent côté France Student. Ce sont des propriétés testables de l’intégration, pas une promesse chiffrée sur le quota Antigravity.
