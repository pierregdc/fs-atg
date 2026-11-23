import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_TARGET, readCredential, writeCredential } from './credential_store.mjs';
import { logEvent } from './logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MCP_HUB_CONFIG_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_mcp_hub.json');

export const MCP_HUB_CATEGORIES = Object.freeze({
  '3d-games': '3D, Jeux & Création',
  databases: 'Bases de données & Backend',
  devops: 'Code, Git & Cloud DevOps',
  'web-media': 'Web, Navigateurs & Média',
  productivity: 'Productivité & Documentation',
});

/**
 * 34 pre-configured MCP connectors & local application bridges (Blender, Roblox Studio,
 * Unity, Unreal, Godot, Figma, DBs, DevOps, Web, Productivity).
 */
export const MCP_HUB_CATALOG = Object.freeze([
  // --- 3D, Jeux & Création (7) ---
  {
    id: 'blender',
    name: 'Blender 3D',
    category: '3d-games',
    description: 'Pilote Blender (création de scènes 3D, maillages, matériaux, rendus Python bpy via socket 9876 ou CLI).',
    command: 'uvx',
    args: ['blender-mcp'],
    defaultPort: 9876,
    bridgeType: 'blender',
    envKeys: [],
  },
  {
    id: 'roblox',
    name: 'Roblox Studio',
    category: '3d-games',
    description: 'Connecteur Roblox Studio & Rojo (scripts Luau, instances DataModel, Workspace, pont HTTP local 44755).',
    command: 'npx',
    args: ['-y', 'robloxstudio-mcp'],
    defaultPort: 44755,
    bridgeType: 'roblox',
    envKeys: ['ROBLOX_API_KEY'],
  },
  {
    id: 'unity',
    name: 'Unity Engine',
    category: '3d-games',
    description: 'Contrôle Unity Editor (GameObjects, scènes, composants C#, compilation et Play Mode via port 6400).',
    command: 'npx',
    args: ['-y', '@unity-mcp/server'],
    defaultPort: 6400,
    bridgeType: 'tcp',
    envKeys: [],
  },
  {
    id: 'unreal',
    name: 'Unreal Engine 5',
    category: '3d-games',
    description: 'Pilote Unreal Editor via Remote Control API (acteurs, Blueprints, matériaux, niveau actif sur port 30010).',
    command: 'uvx',
    args: ['unreal-mcp'],
    defaultPort: 30010,
    bridgeType: 'http',
    envKeys: [],
  },
  {
    id: 'godot',
    name: 'Godot Engine 4',
    category: '3d-games',
    description: 'Inspecte et édite les scènes Godot (.tscn), nœuds et scripts GDScript via LSP/DAP (port 6005).',
    command: 'npx',
    args: ['-y', '@godot-mcp/server'],
    defaultPort: 6005,
    bridgeType: 'tcp',
    envKeys: [],
  },
  {
    id: 'figma',
    name: 'Figma Design',
    category: '3d-games',
    description: 'Lit les maquettes Figma, composants, variables CSS/Design Tokens et exporte les assets SVG/PNG.',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['FIGMA_API_KEY'],
  },
  {
    id: 'aseprite',
    name: 'Aseprite Pixel Art',
    category: '3d-games',
    description: 'Génère et exporte des spritesheets, palettes et animations pixel-art via Aseprite CLI / MCP.',
    command: 'uvx',
    args: ['aseprite-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },

  // --- Bases de données & Backend (8) ---
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'databases',
    description: 'Inspection de schéma, tables, index et requêtes SQL sécurisées sur PostgreSQL.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    defaultPort: 5432,
    bridgeType: 'stdio',
    envKeys: ['POSTGRES_URL'],
  },
  {
    id: 'sqlite',
    name: 'SQLite Local',
    category: 'databases',
    description: 'Explore et interroge les fichiers SQLite (.db, .sqlite) locaux du projet.',
    command: 'npx',
    args: ['-y', 'mcp-server-sqlite'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['SQLITE_DB_PATH'],
  },
  {
    id: 'mysql',
    name: 'MySQL / MariaDB',
    category: 'databases',
    description: 'Exploration des tables et requêtes SQL sur serveurs MySQL et MariaDB.',
    command: 'npx',
    args: ['-y', '@benborla29/mcp-server-mysql'],
    defaultPort: 3306,
    bridgeType: 'stdio',
    envKeys: ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DB'],
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'databases',
    description: 'Inspecte les collections, index BSON et pipelines d’agrégation MongoDB.',
    command: 'npx',
    args: ['-y', 'mongodb-mcp-server'],
    defaultPort: 27017,
    bridgeType: 'stdio',
    envKeys: ['MONGODB_URI'],
  },
  {
    id: 'redis',
    name: 'Redis Cache',
    category: 'databases',
    description: 'Lit et gère les clés, TTL, streams et structures de données Redis.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-redis'],
    defaultPort: 6379,
    bridgeType: 'stdio',
    envKeys: ['REDIS_URL'],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'databases',
    description: 'Gère les projets Supabase, tables Postgres, Edge Functions, Auth et Storage.',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase@latest'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['SUPABASE_ACCESS_TOKEN'],
  },
  {
    id: 'firebase',
    name: 'Firebase',
    category: 'databases',
    description: 'Pilote Firestore, Firebase Auth, Hosting et Cloud Functions.',
    command: 'npx',
    args: ['-y', 'firebase-tools@latest', 'experimental:mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'prisma',
    name: 'Prisma ORM',
    category: 'databases',
    description: 'Introspection schema.prisma, migrations et requêtes typées.',
    command: 'npx',
    args: ['-y', 'prisma', 'mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },

  // --- Code, Git & Cloud DevOps (8) ---
  {
    id: 'github',
    name: 'GitHub',
    category: 'devops',
    description: 'Gère dépôts, Pull Requests, Issues, Actions CI/CD et revues de code GitHub.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: 'devops',
    description: 'Gère Merge Requests, pipelines CI, issues et dépôts GitLab.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'git',
    name: 'Git Local',
    category: 'devops',
    description: 'Historique Git, branches, diff, blame, stash et recherche de commits locaux.',
    command: 'uvx',
    args: ['mcp-server-git'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'docker',
    name: 'Docker & Compose',
    category: 'devops',
    description: 'Inspecte et contrôle conteneurs, images, volumes, réseaux et logs Docker.',
    command: 'npx',
    args: ['-y', '@quantgeekdev/docker-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes (kubectl)',
    category: 'devops',
    description: 'Inspection des pods, déploiements, services, logs et événements Kubernetes.',
    command: 'npx',
    args: ['-y', 'mcp-server-kubernetes'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers',
    category: 'devops',
    description: 'Déploiement et gestion Workers, KV, D1, R2 et DNS Cloudflare.',
    command: 'npx',
    args: ['-y', '@cloudflare/mcp-server-cloudflare'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['CLOUDFLARE_API_TOKEN'],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'devops',
    description: 'Suivi des déploiements, logs de build, domaines et variables d’environnement Vercel.',
    command: 'npx',
    args: ['-y', 'mcp-vercel'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['VERCEL_API_TOKEN'],
  },
  {
    id: 'sentry',
    name: 'Sentry Monitoring',
    category: 'devops',
    description: 'Analyse des stacktraces, erreurs de production et releases Sentry.',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['SENTRY_AUTH_TOKEN'],
  },

  // --- Web, Navigateurs & Média (5) ---
  {
    id: 'playwright',
    name: 'Playwright Testing',
    category: 'web-media',
    description: 'Tests E2E multi-navigateurs, assertions DOM, traces réseau et captures Playwright.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer Headless',
    category: 'web-media',
    description: 'Automatisation Chromium et génération de PDF/captures via Puppeteer.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg Audio & Vidéo',
    category: 'web-media',
    description: 'Conversion vidéo/audio, découpage, extraction de pistes et compression FFmpeg.',
    command: 'uvx',
    args: ['ffmpeg-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'youtube',
    name: 'YouTube Transcripts',
    category: 'web-media',
    description: 'Récupère et résume les sous-titres et chapitres de vidéos YouTube.',
    command: 'npx',
    args: ['-y', '@kimtaeyoon83/mcp-server-youtube-transcript'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'brave-search',
    name: 'Brave Search API',
    category: 'web-media',
    description: 'Recherche web et actualités via l’API officielle Brave Search.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['BRAVE_API_KEY'],
  },

  // --- Productivité & Documentation (6) ---
  {
    id: 'context7',
    name: 'Context7 Live Docs',
    category: 'productivity',
    description: 'Documentation à jour des librairies et frameworks (React, Next, Tailwind, Three.js, etc.).',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: [],
  },
  {
    id: 'notion',
    name: 'Notion Workspace',
    category: 'productivity',
    description: 'Recherche, lecture et édition de pages et bases de données Notion.',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['NOTION_TOKEN'],
  },
  {
    id: 'obsidian',
    name: 'Obsidian Vault',
    category: 'productivity',
    description: 'Navigation, recherche plein-texte et création de notes Markdown dans un coffre Obsidian.',
    command: 'npx',
    args: ['-y', 'mcp-obsidian'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['OBSIDIAN_VAULT_PATH'],
  },
  {
    id: 'discord',
    name: 'Discord Bot & Webhooks',
    category: 'productivity',
    description: 'Lecture de salons, envoi de messages et gestion de serveurs Discord.',
    command: 'npx',
    args: ['-y', 'mcp-discord'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['DISCORD_TOKEN'],
  },
  {
    id: 'slack',
    name: 'Slack Workspace',
    category: 'productivity',
    description: 'Recherche de messages, lecture de canaux et notifications Slack.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['SLACK_BOT_TOKEN'],
  },
  {
    id: 'linear',
    name: 'Linear Project Tracking',
    category: 'productivity',
    description: 'Création, tri et suivi des tickets, sprints et projets Linear.',
    command: 'npx',
    args: ['-y', 'mcp-linear'],
    defaultPort: null,
    bridgeType: 'stdio',
    envKeys: ['LINEAR_API_KEY'],
  },
]);

export function loadHubConfig(filePath = MCP_HUB_CONFIG_PATH) {
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          enabled: Array.isArray(parsed.enabled) ? parsed.enabled.map(String) : ['blender', 'roblox', 'context7', 'git', 'sqlite', 'playwright'],
          overrides: (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
          customConnectors: Array.isArray(parsed.customConnectors) ? parsed.customConnectors : [],
        };
      }
    }
  } catch {}
  return {
    enabled: ['blender', 'roblox', 'context7', 'git', 'sqlite', 'playwright'],
    overrides: {},
    customConnectors: [],
  };
}

export function saveHubConfig(config, filePath = MCP_HUB_CONFIG_PATH) {
  const clean = {
    enabled: [...new Set((config?.enabled || []).map((s) => String(s).trim()).filter(Boolean))],
    overrides: (config?.overrides && typeof config.overrides === 'object') ? config.overrides : {},
    customConnectors: Array.isArray(config?.customConnectors) ? config.customConnectors : [],
  };
  const payload = JSON.stringify(clean, null, 2);
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmp, payload, 'utf-8');
    try { renameSync(tmp, filePath); } catch {
      try { unlinkSync(tmp); } catch {}
      writeFileSync(filePath, payload, 'utf-8');
    }
    return true;
  } catch {
    try { unlinkSync(tmp); } catch {}
    return false;
  }
}

export function allHubConnectors(filePath = MCP_HUB_CONFIG_PATH) {
  const cfg = loadHubConfig(filePath);
  const enabledSet = new Set(cfg.enabled);
  const list = [...MCP_HUB_CATALOG, ...(cfg.customConnectors || [])];
  return list.map((item) => {
    const ov = cfg.overrides?.[item.id] || {};
    return {
      ...item,
      command: ov.command || item.command,
      args: Array.isArray(ov.args) ? ov.args : item.args,
      defaultPort: ov.port ?? item.defaultPort ?? null,
      nativeBridge: item.id === 'blender' || item.id === 'roblox',
      transport: item.bridgeType || 'stdio',
      package: (item.args && item.args.length ? item.args[item.args.length - 1] : item.command),
      enabled: enabledSet.has(item.id),
      configuredEnvKeys: Object.keys(ov.env || {}),
    };
  });
}

function checkPortOpen(port, host = '127.0.0.1', timeoutMs = 450) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function findLocalBinary(candidates = []) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function detectLocalApps() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || '';
  const blenderPath = findLocalBinary([
    join(pf, 'Blender Foundation', 'Blender 4.3', 'blender.exe'),
    join(pf, 'Blender Foundation', 'Blender 4.2', 'blender.exe'),
    join(pf, 'Blender Foundation', 'Blender 4.1', 'blender.exe'),
    join(pf, 'Blender Foundation', 'Blender 4.0', 'blender.exe'),
    join(pf, 'Blender Foundation', 'Blender 3.6', 'blender.exe'),
  ]);

  let robloxPath = null;
  const robloxVersionsDir = local ? join(local, 'Roblox', 'Versions') : '';
  if (robloxVersionsDir && existsSync(robloxVersionsDir)) {
    try {
      robloxPath = robloxVersionsDir;
    } catch {}
  }

  const hasCmd = (cmd) => {
    try {
      return spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch { return false; }
  };

  return {
    npx: hasCmd('npx'),
    uvx: hasCmd('uvx'),
    git: hasCmd('git'),
    docker: hasCmd('docker'),
    ffmpeg: hasCmd('ffmpeg'),
    blender: Boolean(blenderPath) || hasCmd('blender'),
    blenderPath,
    robloxStudio: Boolean(robloxPath),
  };
}

/**
 * Sends a Python expression or command directly to a running Blender MCP socket
 * on 127.0.0.1:9876 (or executes blender --background --python-expr if installed).
 */
export async function executeBlenderBridge({ code, port = 9876, timeoutMs = 10_000 } = {}) {
  const pyCode = String(code || '').trim();
  if (!pyCode) throw new Error('Paramètre "code" (script Python bpy) requis pour Blender.');

  const portOpen = await checkPortOpen(port);
  if (portOpen) {
    return await new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let buf = '';
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch {}
        reject(new Error(`Timeout Blender bridge (port ${port}).`));
      }, timeoutMs);
      sock.connect(port, '127.0.0.1', () => {
        sock.write(JSON.stringify({ type: 'execute_code', params: { code: pyCode } }) + '\n');
      });
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        try {
          const parsed = JSON.parse(buf.trim());
          clearTimeout(timer);
          sock.destroy();
          resolve({ ok: true, mode: 'socket-9876', result: parsed });
        } catch {}
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on('close', () => {
        clearTimeout(timer);
        if (buf.trim()) resolve({ ok: true, mode: 'socket-9876', raw: buf.trim() });
      });
    });
  }

  const apps = detectLocalApps();
  const exe = apps.blenderPath || (apps.blender ? 'blender' : null);
  if (!exe) {
    return {
      ok: false,
      mode: 'offline',
      message: `Blender n'écoute pas sur 127.0.0.1:${port} et blender.exe est introuvable. Ouvre Blender avec l'addon Blender-MCP actif sur le port ${port}.`,
    };
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(exe, ['--background', '--python-expr', pyCode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('Timeout Blender CLI.')); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ ok: exitCode === 0, mode: 'blender-cli', exitCode, stdout: stdout.slice(-2000), stderr: stderr.slice(-1000) });
    });
  });
}

/**
 * Interacts with a running Roblox Studio MCP plugin bridge (127.0.0.1:44755)
 * or generates/validates a Rojo + Luau project structure in workspaceRoot.
 */
export async function executeRobloxBridge({ action = 'status', code = '', workspaceRoot = '', port = 44755 } = {}) {
  const portOpen = await checkPortOpen(port);
  if (portOpen && (action === 'execute_luau' || action === 'query_studio')) {
    const res = await fetch(`http://127.0.0.1:${port}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, mode: 'studio-bridge', port, data };
  }

  if (action === 'scaffold_rojo' && workspaceRoot) {
    mkdirSync(join(workspaceRoot, 'src', 'ServerScriptService'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'src', 'ReplicatedStorage'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'src', 'StarterPlayer', 'StarterPlayerScripts'), { recursive: true });
    const projectJsonPath = join(workspaceRoot, 'default.project.json');
    const projectJson = {
      name: 'RobloxGameATG',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { $path: 'src/ReplicatedStorage' },
        ServerScriptService: { $path: 'src/ServerScriptService' },
        StarterPlayer: {
          StarterPlayerScripts: { $path: 'src/StarterPlayer/StarterPlayerScripts' },
        },
      },
    };
    writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2), 'utf-8');
    const initServer = join(workspaceRoot, 'src', 'ServerScriptService', 'Main.server.luau');
    if (!existsSync(initServer)) {
      writeFileSync(initServer, '--!strict\nlocal Players = game:GetService("Players")\nPlayers.PlayerAdded:Connect(function(player: Player)\n\tprint("Bienvenue dans Roblox ATG :", player.Name)\nend)\n', 'utf-8');
    }
    return {
      ok: true,
      mode: 'rojo-scaffold',
      workspaceRoot,
      filesCreated: ['default.project.json', 'src/ServerScriptService/Main.server.luau'],
    };
  }

  return {
    ok: true,
    mode: portOpen ? 'studio-bridge-online' : 'studio-bridge-standby',
    port,
    studioListening: portOpen,
    hint: portOpen
      ? 'Roblox Studio écoute sur le port 44755.'
      : 'Pont Roblox Studio (port 44755) en veille. Tu peux utiliser action="scaffold_rojo" avec workspaceRoot pour générer un projet Rojo/Luau.',
  };
}

/**
 * Calls any stdio MCP server via JSON-RPC 2.0 (`tools/list` or `tools/call`).
 */
export async function queryStdioMcpServer(connector, { method = 'tools/list', params = {}, timeoutMs = 15_000 } = {}) {
  const cmd = process.platform === 'win32' && ['npx', 'uvx', 'npm'].includes(connector.command)
    ? `${connector.command}.cmd`
    : connector.command;

  const secretEnv = {};
  for (const key of connector.envKeys || []) {
    try {
      const stored = await readCredential(`${CREDENTIAL_TARGET}.MCP.${connector.id}.${key}`);
      if (stored?.value) secretEnv[key] = stored.value;
    } catch {}
  }

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, connector.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...secretEnv },
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Timeout MCP stdio (${connector.id}, ${Math.round(timeoutMs / 1000)}s).`));
    }, timeoutMs);

    const finish = (err, val) => {
      clearTimeout(timer);
      try { if (!child.killed) child.kill(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };

    child.on('error', (err) => finish(err));
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
          } else if (msg.id === 2) {
            if (msg.error) finish(new Error(msg.error.message || 'Erreur JSON-RPC MCP'));
            else finish(null, msg.result);
            return;
          }
        } catch {}
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fs-atg-hub', version: '2.4.0' },
      },
    }) + '\n');
  });
}

export async function executeMcpHubAction(params = {}, { filePath = MCP_HUB_CONFIG_PATH } = {}) {
  const effectivePath = params?.configFilePath || filePath;
  const action = String(params?.action || 'list').trim();
  const connectors = allHubConnectors(effectivePath);

  if (action === 'list' || action === 'search') {
    const category = String(params.category || '').trim();
    const q = String(params.query || '').trim().toLowerCase();
    const onlyEnabled = Boolean(params.onlyEnabled);
    const filtered = connectors.filter((c) => {
      if (onlyEnabled && !c.enabled) return false;
      if (category && c.category !== category) return false;
      if (q && !`${c.id} ${c.name} ${c.description} ${c.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      ok: true,
      action,
      totalCatalog: connectors.length,
      enabledCount: connectors.filter((c) => c.enabled).length,
      count: filtered.length,
      categories: MCP_HUB_CATEGORIES,
      connectors: filtered,
    };
  }

  if (action === 'probe') {
    const apps = detectLocalApps();
    const withPorts = connectors.filter((c) => c.defaultPort);
    const portResults = {};
    await Promise.all(withPorts.map(async (c) => {
      portResults[c.id] = { port: c.defaultPort, listening: await checkPortOpen(c.defaultPort) };
    }));
    return {
      ok: true,
      action: 'probe',
      totalCatalog: connectors.length,
      localApps: apps,
      bridges: portResults,
      detected: {
        blender: {
          installed: apps.blender,
          executable: apps.blenderPath || 'blender',
          mcpSocketOpen: Boolean(portResults.blender?.listening),
        },
        robloxStudio: {
          installed: apps.robloxStudio,
          executable: 'RobloxStudioBeta.exe',
          studioPluginOpen: Boolean(portResults.roblox?.listening),
        },
        unity: {
          installed: false,
          mcpBridgeOpen: Boolean(portResults.unity?.listening),
        },
        godot: {
          installed: false,
          mcpBridgeOpen: Boolean(portResults.godot?.listening),
        },
        cli: {
          node: true,
          npx: apps.npx,
          python: apps.uvx,
          docker: apps.docker,
          git: apps.git,
          ffmpeg: apps.ffmpeg,
        },
      },
    };
  }

  if (action === 'enable' || action === 'disable') {
    const id = String(params.connectorId || params.id || '').trim().toLowerCase();
    const found = connectors.find((c) => c.id === id);
    if (!found) throw new Error(`Connecteur MCP inconnu : "${id}".`);
    const cfg = loadHubConfig(effectivePath);
    const set = new Set(cfg.enabled);
    if (action === 'enable') set.add(id);
    else set.delete(id);
    cfg.enabled = [...set];
    saveHubConfig(cfg, effectivePath);
    logEvent('info', 'mcp_hub', `hub.${action}`, `Connecteur MCP ${id} ${action === 'enable' ? 'activé' : 'désactivé'}.`);
    return {
      ok: true,
      action,
      connectorId: id,
      connector: found,
      enabled: action === 'enable',
      enabledCount: cfg.enabled.length,
      enabledList: cfg.enabled,
    };
  }

  if (action === 'configure') {
    const id = String(params.connectorId || params.id || '').trim().toLowerCase();
    if (!id) throw new Error('Paramètre "connectorId" requis pour configure.');
    const cfg = loadHubConfig(effectivePath);
    if (!connectors.some((c) => c.id === id)) {
      if (!params.command) throw new Error(`Connecteur "${id}" inconnu : fournis "command" et "name" pour ajouter un connecteur personnalisé.`);
      cfg.customConnectors.push({
        id,
        name: String(params.name || id),
        category: String(params.category || 'devops'),
        description: String(params.description || 'Connecteur MCP personnalisé.'),
        command: String(params.command),
        args: Array.isArray(params.args) ? params.args.map(String) : [],
        defaultPort: Number(params.port) || null,
        bridgeType: 'stdio',
        envKeys: [],
      });
    }
    const ov = { ...(cfg.overrides[id] || {}) };
    if (params.command) ov.command = String(params.command);
    if (Array.isArray(params.args)) ov.args = params.args.map(String);
    if (params.port !== undefined) ov.port = Number(params.port) || null;
    if (params.env && typeof params.env === 'object') {
      ov.env = { ...(ov.env || {}) };
      for (const [k, v] of Object.entries(params.env)) {
        const val = String(v ?? '').trim();
        if (!val) continue;
        await writeCredential(val, `${CREDENTIAL_TARGET}.MCP.${id}.${k}`).catch(() => {});
        ov.env[k] = 'stored-in-keychain';
      }
    }
    cfg.overrides[id] = ov;
    if (!cfg.enabled.includes(id)) cfg.enabled.push(id);
    saveHubConfig(cfg, effectivePath);
    return { ok: true, action: 'configure', connectorId: id, enabled: true };
  }

  if (action === 'export_config') {
    const enabled = connectors.filter((c) => c.enabled);
    const mcpServers = {};
    for (const c of enabled) {
      mcpServers[c.id] = {
        command: c.command,
        args: c.args,
      };
    }
    return {
      ok: true,
      action: 'export_config',
      count: enabled.length,
      mcpServers,
      json: JSON.stringify({ mcpServers }, null, 2),
    };
  }

  if (action === 'blender') {
    return await executeBlenderBridge({ code: params.code, port: params.port || 9876 });
  }

  if (action === 'roblox') {
    return await executeRobloxBridge({
      action: params.robloxAction || 'status',
      code: params.code || '',
      workspaceRoot: params.workspaceRoot || '',
      port: params.port || 44755,
    });
  }

  if (action === 'tools' || action === 'call') {
    const id = String(params.connectorId || params.id || '').trim().toLowerCase();
    const conn = connectors.find((c) => c.id === id);
    if (!conn) throw new Error(`Connecteur MCP inconnu : "${id}".`);
    if (action === 'tools') {
      const res = await queryStdioMcpServer(conn, { method: 'tools/list', params: {} });
      return { ok: true, connectorId: id, tools: res?.tools || [] };
    }
    const toolName = String(params.toolName || '').trim();
    if (!toolName) throw new Error('Paramètre "toolName" requis pour call.');
    const res = await queryStdioMcpServer(conn, {
      method: 'tools/call',
      params: { name: toolName, arguments: params.toolArgs || {} },
    });
    return { ok: true, connectorId: id, toolName, result: res };
  }

  throw new Error(`Action fs_mcp_hub inconnue : "${action}".`);
}
