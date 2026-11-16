# France Student pour Antigravity (`fs-atg`)

Extension IDE (`.vsix`) et plugin Antigravity 2.0 (side panel + serveur MCP stdio + règle par défaut) permettant de déléguer la génération de code aux modèles **France Student** (ChatGPT & Claude).

## Fonctionnalités

- **Double compatibilité** :
  - **Clé API développeur** (`/v1/responses` + `/v1/models`)
  - **Jeton de session** (`/chats/stream` + `/chats/agents` + `clientTools`)
- **Outils client natifs (`2026_11_client_tools`)** : `list_directory`, `read_file`, `search_files`, `edit_file`, `write_file` exécutés localement dans le workspace (`.git/` et `.env*` protégés).
- **Routage local (0 token)** par catégories :
  - **Auto**
  - **Modèle faible** (`gpt-5.6-luna`, `GPT 6 Luna`, `Claude Haiku 5.5`)
  - **Modèle équilibré** (`gpt-5.6-terra`, `gpt-5.6-sol`, `GPT-6.1 Terra`, `Claude Sonnet 5.5`)
  - **Modèle fort** (`GPT 6 Sol`, `GPT 6.1 Sol`, `GPT-6 Astra`, `Claude Opus 5.5`, `Claude Fable 5.2`)
- **Protection du budget** : suivi temps réel de `chatBudget.remainingPercent`, coupe-circuit configurable (défaut `15 %`), modes **Éco** (1 agent) / **Rapide** (multi-agents).
- **Historique clair** : icône `✓` si des fichiers ont été écrits, `!` ambré si la tâche s'est terminée sans écriture de fichier, `✕` en cas d'erreur.

## Structure du dépôt

- `src/` : extension Antigravity IDE / VS Code (TypeScript, esbuild, serveur MCP HTTP local)
- `plugin/` : plugin Antigravity 2.0 (`plugin.json`, `mcp_config.json`, `mcp_server.mjs`, `fs_core.mjs`, `rules/AGENTS.md`, `sidecars/fs_atg_panel/`)

## Build de l'extension (`.vsix`)

```bash
npm install
npx tsc --noEmit
npm run build
npx @vscode/vsce package --allow-missing-repository
```

## Installation du plugin Antigravity 2.0

Copiez le dossier `plugin/` vers `~/.gemini/config/plugins/fs-atg/` puis installez ses dépendances MCP :

```bash
cd ~/.gemini/config/plugins/fs-atg
npm install
```

Configurez ensuite votre clé API ou `sessionToken` dans l'onglet **Paramètres** du panneau **France Student [ATG]**.
