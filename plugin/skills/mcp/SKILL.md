---
name: mcp
description: Explorer, activer et appeler les 34+ connecteurs du Hub MCP (Blender, Roblox Studio, Unity, Unreal, Godot, Figma, Postgres, SQLite, Docker, GitHub, Playwright, Context7…) via fs_mcp_hub.
---

Appelle immédiatement l'outil MCP `fs_mcp_hub` de France Student (`fs-atg`) :

1. **Explorer ou sonder les 34+ connecteurs** :
   - `fs_mcp_hub({ action: "list", category: "3d-games" })` (catégories : `3d-games`, `databases`, `devops`, `web-media`, `productivity`) ou `action: "search", query: "roblox"`.
   - `fs_mcp_hub({ action: "probe" })` pour détecter les applications installées (`blender`, `Roblox Studio`, `docker`, `git`, `ffmpeg`, `npx`, `uvx`) et les ports locaux actifs (`9876`, `44755`, `6400`, `30010`, `6005`, `5432`, `6379`, `27017`).
2. **Ponts directs Blender & Roblox Studio** :
   - **Blender** : `fs_mcp_hub({ action: "blender", code: "import bpy; ..." })` exécute du Python `bpy` sur le socket Blender-MCP (`127.0.0.1:9876`) ou via `blender --background`.
   - **Roblox Studio / Rojo** : `fs_mcp_hub({ action: "roblox", robloxAction: "status" })`, `robloxAction: "scaffold_rojo"` (crée `default.project.json` + architecture Luau `ServerScriptService` / `ReplicatedStorage` / `StarterPlayerScripts`), ou `robloxAction: "execute_luau"` sur le pont `127.0.0.1:44755`.
3. **Activer, configurer ou appeler n'importe quel serveur MCP** :
   - `fs_mcp_hub({ action: "enable", connectorId: "blender" })` / `action: "disable"`.
   - `fs_mcp_hub({ action: "tools", connectorId: "context7" })` puis `fs_mcp_hub({ action: "call", connectorId: "...", toolName: "...", toolArgs: { ... } })`.
