---
name: mcp
description: Explorer, auto-détecter, activer et appeler les 68+ connecteurs du Hub MCP (stdio, Streamable HTTP, SSE, Blender, Roblox Studio, Firecrawl, Stripe, Qdrant, n8n, Cloud MCP France Student…) via fs_mcp_hub.
---

Appelle immédiatement l'outil MCP `fs_mcp_hub` de France Student (`fs-atg`) :

1. **Explorer, auto-détecter ou sonder les 68+ connecteurs** :
   - `fs_mcp_hub({ action: "list", category: "3d-games" })` (catégories : `3d-games`, `web-search`, `ai-memory`, `databases`, `devops`, `productivity`) ou `action: "search", query: "firecrawl"`.
   - `fs_mcp_hub({ action: "detect_local" })` scanne les serveurs MCP déjà installés dans Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI, Antigravity et VS Code, puis `action: "import_local", connectorId: "all"` les importe en 1 clic.
   - `fs_mcp_hub({ action: "probe" })` détecte les applications locales (`Roblox Studio`, `Blender`, `Unity Hub`, `Godot`, `OBS`, `Python`, `Node/npx`, `Docker`, `Git`, `FFmpeg`) et les ports locaux ouverts.
2. **Ponts directs Blender, Roblox Studio & Cloud France Student** :
   - **Blender** : `fs_mcp_hub({ action: "blender", code: "import bpy; ..." })` sur socket `127.0.0.1:9876` ou `blender --background`.
   - **Roblox Studio / Rojo** : `fs_mcp_hub({ action: "roblox", robloxAction: "status" | "scaffold_rojo" | "execute_luau" })`.
   - **MCP Cloud France Student** : `fs_mcp_hub({ action: "cloud_list" | "cloud_add" | "cloud_delete" })` sur `/mcp/servers`, et `action: "deskdock"` pour le PC virtuel.
3. **Transports complets (stdio, HTTP, SSE) & protocole MCP** :
   - `fs_mcp_hub({ action: "ping" | "tools" | "call" | "resources" | "read_resource" | "prompts", connectorId: "..." })` avec cache schémas 24h.
