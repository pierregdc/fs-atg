# Couverture API France Student

Cette matrice distingue les capacités intégrées de celles qui sont volontairement
en lecture seule. Une intégration ne doit jamais créer un projet, enregistrer un
serveur MCP distant, ni supprimer un fichier sans action explicite de l'utilisateur.

| Domaine API | Intégration | Politique |
|---|---|---|
| Chats streaming et continuations | `fs_delegate`, sessions persistantes, annulation, compaction | Écriture seulement lors d'une délégation demandée |
| Contexte de chat | contrôle, compaction auto/manuelle | Compactage lancé à la demande ou au seuil configuré |
| Modèles et agents | routage local, `/chats/agents`, `/v1/models`, catalogue `/models` | Lecture seule |
| Quota et rate limits | usage, token usage, power-up configuré | Power-up limité au comportement choisi par l'utilisateur |
| Capacité de flux | catalogue de `/metrics/chat-streams`, limite locale partagée | Lecture seule ; aucune hausse automatique de limite |
| Skills | catalogue `/skills` | Lecture seule tant qu'une interface d'exécution explicitement validée n'est pas définie |
| Projects | catalogue `/projects` | Lecture seule ; aucun projet n'est créé automatiquement |
| MCP distant | catalogue `/mcp/servers` | Lecture seule ; activation/modification nécessite une future confirmation dédiée |
| Fichiers v2 | upload ciblé de gros fichiers dans l'extension IDE ; découverte tolérante `/filesv2` | Les fichiers locaux ne sortent que sur une délégation avec fichiers sélectionnés ; la découverte ne mute rien |

## Comportements locaux associés

Les contrôles ci-dessous ne correspondent pas à de nouveaux endpoints : ils sont
exécutés localement avant ou après l’appel fournisseur.

| Fonction | Données / effet | Garde-fou |
|---|---|---|
| Profils de routage | Choix local d’une préférence `eco`, `fast`, `quality`, `security` ou `refactor` | Ne transforme jamais une liste locale en disponibilité de compte |
| `/plan` | Plan et vérifications proposés | Aucun outil d’écriture n’est offert ni exécuté localement |
| `/dry-run` | Fichiers proposés, diff, application explicite | Aucun fichier workspace n’est écrit avant l’approbation ; application et annulation vérifient les versions locales |
| Index `smart` | Chemins, symboles et imports bornés | Aucun contenu source complet dans l’index |
| Diagnostics | Dernier état observé de connexion, quota, modèles, slots et session | Les valeurs inconnues ou non vérifiées restent signalées comme telles |

## Outil MCP de découverte

`fs_catalog` accepte `all`, `models`, `streams` (ou l'alias `capacity`),
`skills`, `projects`, `mcpServers` et `files`. Les résultats sont bornés avant
de revenir dans Antigravity. Il retourne explicitement si l'endpoint n'est pas
offert par le compte ou la version de l'API, au lieu de masquer l'erreur.

## Données affichées et refus

Une liste de modèles n'est marquée disponible dans le panneau qu'après une
réponse vérifiée du fournisseur. Les identifiants locaux de routage restent un
secours technique et ne sont pas présentés comme l'état du compte. Lors d'un
refus explicitement déclaré par le fournisseur, le motif reçu est conservé ; si
le fournisseur n'en fournit aucun, l'interface indique exactement `motif non
fourni par le fournisseur`. Une seule tentative sur un autre modèle autorisé de
la même gamme est possible, sans reprise après une écriture locale, une
annulation ou une erreur de transport.

## Économie de contexte

Le chemin standard reste `contextMode: "minimal"`. Il transmet seulement la
nouvelle consigne ; le modèle demande les lignes nécessaires par `clientTools`.
`targeted` et `smart` sont des opt-ins, réservés aux tâches pour lesquelles les
chemins sélectionnés ou un petit plan de projet apportent un bénéfice réel.

Lorsque les outils client ne sont pas disponibles, un diff de fichier peut être
réutilisé uniquement avec un chat persistant qui possède déjà une base en mémoire,
et seulement s’il est plus court qu’un fichier complet. Ce cache est local au
processus et non persistant ; une nouvelle session repart avec un contenu complet
si elle en a besoin.

## Contrat vérifiable

La liste d’endpoints ci-dessus est contrôlée par le probe opt-in
[`npm run test:api-contract`](API_CONTRACT_TESTS.md). Il effectue uniquement des
GET avec un jeton fourni explicitement dans l’environnement. Un HTTP 404 sur une
capacité optionnelle est rapporté comme indisponible, jamais comme une réussite.
