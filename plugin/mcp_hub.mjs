import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_TARGET, readCredential, writeCredential } from './credential_store.mjs';
import {
  addCloudMcpServer,
  CONNECTOR_VERSION,
  controlDeskDock,
  deleteCloudMcpServer,
  fetchCloudMcpServers,
  loadState,
} from './fs_core.mjs';
import { logEvent } from './logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MCP_HUB_CONFIG_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_mcp_hub.json');
export const MCP_HUB_CACHE_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_mcp_cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const MCP_HUB_CATEGORIES = Object.freeze({
  '3d-games': '3D, Jeux & Création',
  'web-search': 'Web, Scraping & Média',
  'ai-memory': 'Mémoire IA, Raisonnement & Graphes',
  databases: 'Bases de données & Backend',
  devops: 'Code, Git & Cloud DevOps',
  productivity: 'Productivité, Business & Domotique',
});

/**
 * 66 verified GitHub & official MCP connectors + local application bridges across 6 categories.
 * Supports stdio, Streamable HTTP, SSE, and native Blender/Roblox bridges.
 */
export const MCP_HUB_CATALOG = Object.freeze([
  // --- 3D, Jeux & Création (13) ---
  {
    id: 'blender',
    name: 'Blender 3D',
    category: '3d-games',
    description: 'Pilote Blender (création de scènes 3D, maillages, matériaux, rendus Python bpy via socket 9876 ou CLI).',
    command: 'uvx',
    args: ['blender-mcp'],
    defaultPort: 9876,
    bridgeType: 'blender',
    repo: 'https://github.com/ahujasid/blender-mcp',
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
    repo: 'https://github.com/gmh5225/vibe-blocks-mcp',
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
    repo: 'https://github.com/IvanMurzak/Unity-MCP',
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
    repo: 'https://github.com/chongdashu/unreal-mcp',
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
    repo: 'https://github.com/Coding-Solo/godot-mcp',
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
    repo: 'https://github.com/GLips/Figma-Context-MCP',
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
    repo: 'https://github.com/diivi/aseprite-mcp',
    envKeys: [],
  },
  {
    id: 'minecraft',
    name: 'Minecraft Bot & Builder',
    category: '3d-games',
    description: 'Contrôle un bot Minecraft (Mineflayer) : construction 3D, inventaire, chat et exploration serveur.',
    command: 'npx',
    args: ['-y', 'minecraft-mcp-server'],
    defaultPort: 25565,
    bridgeType: 'stdio',
    repo: 'https://github.com/yuniko-software/minecraft-mcp-server',
    envKeys: [],
  },
  {
    id: 'obs-studio',
    name: 'OBS Studio WebSocket',
    category: '3d-games',
    description: 'Pilote OBS Studio via WebSocket (scènes, sources, enregistrement, streaming et transitions sur port 4455).',
    command: 'npx',
    args: ['-y', 'obs-mcp'],
    defaultPort: 4455,
    bridgeType: 'stdio',
    repo: 'https://github.com/royshil/obs-mcp',
    envKeys: ['OBS_WEBSOCKET_PASSWORD'],
  },
  {
    id: 'canva',
    name: 'Canva Design Studio',
    category: '3d-games',
    description: 'Crée, redimensionne, commente et exporte des designs Canva directement via le serveur MCP officiel.',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.canva.com/mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/canva/canva-mcp',
    envKeys: [],
  },
  {
    id: 'excalidraw',
    name: 'Excalidraw Diagrammes',
    category: '3d-games',
    description: 'Crée et édite des schémas d’architecture, wireframes et tableaux blancs Excalidraw en JSON/SVG.',
    command: 'npx',
    args: ['-y', 'excalidraw-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/yctimlin/mcp_excalidraw',
    envKeys: [],
  },
  {
    id: 'sketchfab',
    name: 'Sketchfab 3D Assets',
    category: '3d-games',
    description: 'Recherche et télécharge des modèles 3D glTF/FBX/OBJ depuis Sketchfab pour Blender, Unity ou Roblox.',
    command: 'uvx',
    args: ['sketchfab-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: ['SKETCHFAB_API_TOKEN'],
  },
  {
    id: 'mermaid-mcp',
    name: 'Mermaid Charts',
    category: '3d-games',
    description: 'Génère et valide des diagrammes Mermaid (flowcharts, séquences, ERD, Gantt) en SVG/PNG.',
    command: 'npx',
    args: ['-y', '@peng-shawn/mermaid-mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/peng-shawn/mermaid-mcp-server',
    envKeys: [],
  },

  // --- Web, Scraping & Média (12) ---
  {
    id: 'playwright',
    name: 'Playwright Testing',
    category: 'web-search',
    description: 'Tests E2E multi-navigateurs, assertions DOM, traces réseau et captures Playwright.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/microsoft/playwright-mcp',
    envKeys: [],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer Headless',
    category: 'web-search',
    description: 'Automatisation Chromium et génération de PDF/captures via Puppeteer.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: [],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl Web Scraper',
    category: 'web-search',
    description: 'Crawl profond, extraction Markdown propre, recherche structurée et scraping anti-JS Firecrawl.',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/mendableai/firecrawl-mcp-server',
    envKeys: ['FIRECRAWL_API_KEY'],
  },
  {
    id: 'exa',
    name: 'Exa Neural Search',
    category: 'web-search',
    description: 'Moteur de recherche sémantique IA ultra-précis pour articles techniques, GitHub, papers et entreprises.',
    command: 'npx',
    args: ['-y', 'exa-mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/exa-labs/exa-mcp-server',
    envKeys: ['EXA_API_KEY'],
  },
  {
    id: 'tavily',
    name: 'Tavily AI Search',
    category: 'web-search',
    description: 'Recherche web temps réel optimisée pour agents IA avec extraction de réponses sourcées.',
    command: 'npx',
    args: ['-y', 'tavily-mcp@latest'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/tavily-ai/tavily-mcp',
    envKeys: ['TAVILY_API_KEY'],
  },
  {
    id: 'perplexity',
    name: 'Perplexity Sonar',
    category: 'web-search',
    description: 'Interroge les modèles Perplexity Sonar (recherche web + citations en direct).',
    command: 'npx',
    args: ['-y', 'server-perplexity-ask'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/ppl-ai/modelcontextprotocol',
    envKeys: ['PERPLEXITY_API_KEY'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search API',
    category: 'web-search',
    description: 'Recherche web, images et actualités via l’API officielle Brave Search.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: ['BRAVE_API_KEY'],
  },
  {
    id: 'fetch',
    name: 'Fetch Officiel MCP',
    category: 'web-search',
    description: 'Serveur de référence officiel MCP : télécharge des pages web et les convertit en Markdown propre.',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: [],
  },
  {
    id: 'browserbase',
    name: 'Browserbase Cloud',
    category: 'web-search',
    description: 'Navigateurs cloud isolés avec Stagehand pour automatisation web résiliente à grande échelle.',
    command: 'npx',
    args: ['-y', '@browserbasehq/mcp-server-browserbase'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/browserbase/mcp-server-browserbase',
    envKeys: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
  },
  {
    id: 'context7',
    name: 'Context7 Live Docs',
    category: 'web-search',
    description: 'Documentation à jour des librairies et frameworks (React, Next, Tailwind, Three.js, etc.).',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/upstash/context7',
    envKeys: [],
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg Audio & Vidéo',
    category: 'web-search',
    description: 'Conversion vidéo/audio, découpage, extraction de pistes et compression FFmpeg.',
    command: 'uvx',
    args: ['ffmpeg-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/video-creator/ffmpeg-mcp',
    envKeys: [],
  },
  {
    id: 'youtube',
    name: 'YouTube Transcripts',
    category: 'web-search',
    description: 'Récupère et résume les sous-titres et chapitres de vidéos YouTube.',
    command: 'npx',
    args: ['-y', '@kimtaeyoon83/mcp-server-youtube-transcript'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/kimtaeyoon83/mcp-server-youtube-transcript',
    envKeys: [],
  },

  // --- Mémoire IA, Raisonnement & Graphes (8) ---
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    category: 'ai-memory',
    description: 'Serveur officiel MCP de raisonnement structuré étape par étape avec révision d’hypothèses.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: [],
  },
  {
    id: 'memory',
    name: 'Knowledge Graph Memory',
    category: 'ai-memory',
    description: 'Mémoire persistante en graphe de connaissances (entités, relations, observations) entre sessions.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: [],
  },
  {
    id: 'filesystem',
    name: 'Filesystem Officiel MCP',
    category: 'ai-memory',
    description: 'Lecture, écriture, recherche et gestion sécurisée de dossiers locaux autorisés.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: [],
  },
  {
    id: 'qdrant',
    name: 'Qdrant Vector Memory',
    category: 'ai-memory',
    description: 'Base vectorielle sémantique Qdrant pour mémoire long-terme et recherche RAG haute vitesse.',
    command: 'uvx',
    args: ['mcp-server-qdrant'],
    defaultPort: 6333,
    bridgeType: 'stdio',
    repo: 'https://github.com/qdrant/mcp-server-qdrant',
    envKeys: ['QDRANT_URL', 'QDRANT_API_KEY'],
  },
  {
    id: 'neo4j',
    name: 'Neo4j Graph DB',
    category: 'ai-memory',
    description: 'Requêtes Cypher, modélisation et exploration de graphes dans Neo4j.',
    command: 'uvx',
    args: ['mcp-neo4j-cypher'],
    defaultPort: 7687,
    bridgeType: 'stdio',
    repo: 'https://github.com/neo4j-contrib/mcp-neo4j',
    envKeys: ['NEO4J_URI', 'NEO4J_USERNAME', 'NEO4J_PASSWORD'],
  },
  {
    id: 'duckdb',
    name: 'DuckDB Analytics SQL',
    category: 'ai-memory',
    description: 'Requêtes SQL analytiques ultra-rapides directement sur fichiers Parquet, CSV et JSON locaux.',
    command: 'uvx',
    args: ['mcp-server-duckdb'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/ktanaka101/mcp-server-duckdb',
    envKeys: [],
  },
  {
    id: 'chroma',
    name: 'ChromaDB Embeddings',
    category: 'ai-memory',
    description: 'Stockage et recherche vectorielle locale/cloud sur collections ChromaDB.',
    command: 'uvx',
    args: ['chroma-mcp'],
    defaultPort: 8000,
    bridgeType: 'stdio',
    repo: 'https://github.com/chroma-core/chroma-mcp',
    envKeys: [],
  },
  {
    id: 'time',
    name: 'Time & Fuseaux Horaires',
    category: 'ai-memory',
    description: 'Serveur officiel MCP de conversion d’heures et fuseaux horaires IANA exacts.',
    command: 'uvx',
    args: ['mcp-server-time'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: [],
  },

  // --- Bases de données & Backend (9) ---
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'databases',
    description: 'Inspection de schéma, tables, index et requêtes SQL sécurisées sur PostgreSQL.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    defaultPort: 5432,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
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
    repo: 'https://github.com/modelcontextprotocol/servers',
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
    repo: 'https://github.com/benborla/mcp-server-mysql',
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
    repo: 'https://github.com/mongodb-js/mongodb-mcp-server',
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
    repo: 'https://github.com/redis/mcp-redis',
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
    repo: 'https://github.com/supabase-community/supabase-mcp',
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
    repo: 'https://github.com/firebase/firebase-tools',
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
    repo: 'https://github.com/prisma/prisma',
    envKeys: [],
  },
  {
    id: 'neon',
    name: 'Neon Serverless Postgres',
    category: 'databases',
    description: 'Crée des branches Postgres instantanées, migrations SQL et projets Neon.',
    command: 'npx',
    args: ['-y', '@neondatabase/mcp-server-neon'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/neondatabase/mcp-server-neon',
    envKeys: ['NEON_API_KEY'],
  },

  // --- Code, Git & Cloud DevOps (10) ---
  {
    id: 'github',
    name: 'GitHub Officiel',
    category: 'devops',
    description: 'Gère dépôts, Pull Requests, Issues, Actions CI/CD et revues de code GitHub.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/github/github-mcp-server',
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
    repo: 'https://github.com/modelcontextprotocol/servers',
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
    repo: 'https://github.com/modelcontextprotocol/servers',
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
    repo: 'https://github.com/QuantGeekDev/docker-mcp',
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
    repo: 'https://github.com/Flux159/mcp-server-kubernetes',
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
    repo: 'https://github.com/cloudflare/mcp-server-cloudflare',
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
    repo: 'https://github.com/vercel/mcp-vercel',
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
    repo: 'https://github.com/getsentry/sentry-mcp',
    envKeys: ['SENTRY_AUTH_TOKEN'],
  },
  {
    id: 'aws',
    name: 'AWS Cloud & Docs',
    category: 'devops',
    description: 'Documentation AWS temps réel, S3, Lambda, CloudFormation et CDK via serveurs AWS Labs MCP.',
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/awslabs/mcp',
    envKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  },
  {
    id: 'terraform',
    name: 'Terraform Registry IaC',
    category: 'devops',
    description: 'Recherche de providers, modules et documentation officielle HashiCorp Terraform.',
    command: 'npx',
    args: ['-y', '@hashicorp/terraform-mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/hashicorp/terraform-mcp-server',
    envKeys: [],
  },

  // --- Productivité, Business & Domotique (14) ---
  {
    id: 'notion',
    name: 'Notion Workspace',
    category: 'productivity',
    description: 'Recherche, lecture et édition de pages et bases de données Notion.',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/makenotion/notion-mcp-server',
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
    repo: 'https://github.com/MarkusPfundstein/mcp-obsidian',
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
    repo: 'https://github.com/v-3/discordmcp',
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
    repo: 'https://github.com/modelcontextprotocol/servers',
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
    repo: 'https://github.com/jerhadf/linear-mcp-server',
    envKeys: ['LINEAR_API_KEY'],
  },
  {
    id: 'stripe',
    name: 'Stripe Paiements',
    category: 'productivity',
    description: 'Clients, factures, abonnements, remboursements et produits via le MCP officiel Stripe.',
    command: 'npx',
    args: ['-y', '@stripe/mcp', '--tools=all'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/stripe/agent-toolkit',
    envKeys: ['STRIPE_SECRET_KEY'],
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant Domotique',
    category: 'productivity',
    description: 'Contrôle lumières, capteurs, scènes et automatisations de votre maison connectée Home Assistant.',
    command: 'uvx',
    args: ['mcp-server-home-assistant'],
    defaultPort: 8123,
    bridgeType: 'stdio',
    repo: 'https://github.com/allenporter/mcp-server-home-assistant',
    envKeys: ['HASS_URL', 'HASS_TOKEN'],
  },
  {
    id: 'spotify',
    name: 'Spotify Musique',
    category: 'productivity',
    description: 'Lecture/pause, playlists, recherche de titres et files d’attente Spotify.',
    command: 'uvx',
    args: ['spotify-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/varunneal/spotify-mcp',
    envKeys: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive & Docs',
    category: 'productivity',
    description: 'Recherche, lecture et export de fichiers Google Drive, Docs et Sheets.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/modelcontextprotocol/servers',
    envKeys: ['GDRIVE_CREDENTIALS_PATH'],
  },
  {
    id: 'gmail',
    name: 'Gmail Messagerie',
    category: 'productivity',
    description: 'Lecture, recherche, brouillons, labels et envoi d’e-mails Gmail.',
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    envKeys: ['GMAIL_CREDENTIALS_PATH'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar Agenda',
    category: 'productivity',
    description: 'Consultation, création et gestion d’événements et disponibilités Google Calendar.',
    command: 'npx',
    args: ['-y', '@cocal/google-calendar-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/nspady/google-calendar-mcp',
    envKeys: ['GOOGLE_OAUTH_CREDENTIALS'],
  },
  {
    id: 'atlassian',
    name: 'Jira & Confluence',
    category: 'productivity',
    description: 'Tickets Jira, sprints, pages Confluence et wikis d’équipe Atlassian.',
    command: 'uvx',
    args: ['mcp-atlassian'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/sooperset/mcp-atlassian',
    envKeys: ['JIRA_URL', 'JIRA_API_TOKEN'],
  },
  {
    id: 'n8n',
    name: 'n8n Workflows Auto',
    category: 'productivity',
    description: 'Crée, déclenche et inspecte des workflows d’automatisation n8n (400+ intégrations).',
    command: 'npx',
    args: ['-y', 'n8n-mcp'],
    defaultPort: 5678,
    bridgeType: 'stdio',
    repo: 'https://github.com/czlonkowski/n8n-mcp',
    envKeys: ['N8N_API_URL', 'N8N_API_KEY'],
  },
  {
    id: 'telegram',
    name: 'Telegram Bot & Chats',
    category: 'productivity',
    description: 'Envoi de messages, alertes et lecture de canaux/groupes Telegram.',
    command: 'uvx',
    args: ['telegram-mcp'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/chigwell/telegram-mcp',
    envKeys: ['TELEGRAM_BOT_TOKEN'],
  },
  {
    id: 'airtable',
    name: 'Airtable Bases',
    category: 'productivity',
    description: 'Lit, filtre et met à jour les tables, vues et enregistrements Airtable.',
    command: 'npx',
    args: ['-y', 'airtable-mcp-server'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/domdomegg/airtable-mcp-server',
    envKeys: ['AIRTABLE_API_KEY'],
  },
  {
    id: 'trello',
    name: 'Trello Kanban',
    category: 'productivity',
    description: 'Gestion des tableaux, listes, cartes et checklists Trello.',
    command: 'npx',
    args: ['-y', '@delorenj/mcp-server-trello'],
    defaultPort: null,
    bridgeType: 'stdio',
    repo: 'https://github.com/delorenj/mcp-server-trello',
    envKeys: ['TRELLO_API_KEY', 'TRELLO_TOKEN'],
  },
]);

export function loadHubConfig(filePath = MCP_HUB_CONFIG_PATH) {
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          enabled: Array.isArray(parsed.enabled) ? parsed.enabled.map(String) : ['blender', 'roblox', 'context7', 'git', 'sqlite', 'playwright', 'sequential-thinking', 'firecrawl'],
          overrides: (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
          customConnectors: Array.isArray(parsed.customConnectors) ? parsed.customConnectors : [],
        };
      }
    }
  } catch {}
  return {
    enabled: ['blender', 'roblox', 'context7', 'git', 'sqlite', 'playwright', 'sequential-thinking', 'firecrawl'],
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

function loadSchemaCache() {
  try {
    if (existsSync(MCP_HUB_CACHE_PATH)) {
      const parsed = JSON.parse(readFileSync(MCP_HUB_CACHE_PATH, 'utf-8').replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
}

function saveSchemaCache(cache) {
  try {
    mkdirSync(dirname(MCP_HUB_CACHE_PATH), { recursive: true });
    writeFileSync(MCP_HUB_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {}
}

export function allHubConnectors(filePath = MCP_HUB_CONFIG_PATH) {
  const cfg = loadHubConfig(filePath);
  const enabledSet = new Set(cfg.enabled);
  const list = [...MCP_HUB_CATALOG, ...(cfg.customConnectors || [])];
  return list.map((item) => {
    const ov = cfg.overrides?.[item.id] || {};
    const transport = ov.transport || (ov.url || item.url ? (ov.type === 'sse' || item.type === 'sse' ? 'sse' : 'http') : (item.bridgeType || 'stdio'));
    return {
      ...item,
      command: ov.command || item.command || '',
      args: Array.isArray(ov.args) ? ov.args : (item.args || []),
      url: ov.url || item.url || null,
      headers: ov.headers || item.headers || null,
      defaultPort: ov.port ?? item.defaultPort ?? null,
      nativeBridge: item.id === 'blender' || item.id === 'roblox',
      transport,
      package: ov.url || item.url || (item.args && item.args.length ? item.args[item.args.length - 1] : item.command),
      enabled: enabledSet.has(item.id),
      configuredEnvKeys: Object.keys(ov.env || {}),
    };
  });
}

/**
 * Auto-discovers MCP servers already configured on the user's PC across
 * Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI, Antigravity & VS Code
 * (inspired by x3vren/fs-mcp-cli).
 */
export function detectLocalMcpServers(workspaceRoot = '') {
  const home = os.homedir();
  const appData = process.env.APPDATA || join(home, '.config');
  const macSupport = join(home, 'Library', 'Application Support');
  const claudeDir = process.platform === 'win32'
    ? join(appData, 'Claude')
    : (process.platform === 'darwin' ? join(macSupport, 'Claude') : join(home, '.config', 'Claude'));
  const codeDir = process.platform === 'win32'
    ? join(appData, 'Code', 'User')
    : (process.platform === 'darwin' ? join(macSupport, 'Code', 'User') : join(home, '.config', 'Code', 'User'));

  const sources = [
    ['Claude Desktop', join(claudeDir, 'claude_desktop_config.json')],
    ['Claude Code', join(home, '.claude.json')],
    ['Cursor', join(home, '.cursor', 'mcp.json')],
    ['Windsurf', join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    ['Gemini CLI', join(home, '.gemini', 'settings.json')],
    ['Antigravity', join(home, '.gemini', 'antigravity', 'mcp_config.json')],
    ['VS Code', join(codeDir, 'mcp.json')],
  ];
  if (workspaceRoot) {
    sources.push(
      ['Projet (.mcp.json)', join(workspaceRoot, '.mcp.json')],
      ['Cursor (projet)', join(workspaceRoot, '.cursor', 'mcp.json')],
      ['VS Code (projet)', join(workspaceRoot, '.vscode', 'mcp.json')],
    );
  }

  const servers = {};
  const found = [];
  for (const [source, file] of sources) {
    if (!existsSync(file)) continue;
    let json;
    try { json = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')); } catch { continue; }
    const block = json?.mcpServers || json?.servers || {};
    const names = [];
    for (const [rawName, entry] of Object.entries(block)) {
      if (!entry || typeof entry !== 'object' || entry.disabled === true || entry.enabled === false) continue;
      if (/^fs-atg$/i.test(rawName)) continue;
      const url = entry.url || entry.serverUrl || entry.httpUrl || null;
      const normalized = url
        ? {
          id: rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
          name: rawName,
          source,
          transport: (entry.type === 'sse' || (entry.serverUrl && !entry.httpUrl && /\/sse\/?$/.test(url))) ? 'sse' : 'http',
          url,
          headers: entry.headers || null,
        }
        : (entry.command
          ? {
            id: rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            name: rawName,
            source,
            transport: 'stdio',
            command: entry.command,
            args: Array.isArray(entry.args) ? entry.args.map(String) : [],
            envKeys: Object.keys(entry.env || {}),
          }
          : null);
      if (!normalized) continue;
      names.push(rawName);
      if (!servers[normalized.id]) servers[normalized.id] = normalized;
    }
    if (names.length) found.push({ source, file, count: names.length, names });
  }
  return {
    totalDiscovered: Object.keys(servers).length,
    sourcesScanned: sources.length,
    found,
    servers: Object.values(servers),
  };
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

function findBlenderDynamic(pf) {
  const base = join(pf, 'Blender Foundation');
  if (existsSync(base)) {
    try {
      const dirs = readdirSync(base)
        .filter((d) => /^blender/i.test(d))
        .sort((a, b) => b.localeCompare(a));
      for (const d of dirs) {
        const exe = join(base, d, 'blender.exe');
        if (existsSync(exe)) return exe;
      }
    } catch {}
  }
  return findLocalBinary([
    join(pf, 'Blender Foundation', 'Blender 4.4', 'blender.exe'),
    join(pf, 'Blender Foundation', 'Blender 4.3', 'blender.exe'),
    join(pf, 'Blender Foundation', 'Blender 4.2', 'blender.exe'),
  ]);
}

export function detectLocalApps() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || '';
  const blenderPath = findBlenderDynamic(pf);

  let robloxPath = null;
  const robloxVersionsDir = local ? join(local, 'Roblox', 'Versions') : '';
  if (robloxVersionsDir && existsSync(robloxVersionsDir)) {
    robloxPath = robloxVersionsDir;
  }

  const unityHubPath = findLocalBinary([
    join(pf, 'Unity Hub', 'Unity Hub.exe'),
    local ? join(local, 'Programs', 'Unity Hub', 'Unity Hub.exe') : '',
  ]);
  const obsPath = findLocalBinary([
    join(pf, 'obs-studio', 'bin', '64bit', 'obs64.exe'),
  ]);

  const hasCmd = (cmd) => {
    try {
      return spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch { return false; }
  };

  return {
    npx: hasCmd('npx'),
    uvx: hasCmd('uvx'),
    python: hasCmd('python'),
    git: hasCmd('git'),
    docker: hasCmd('docker'),
    ffmpeg: hasCmd('ffmpeg'),
    blender: Boolean(blenderPath) || hasCmd('blender'),
    blenderPath,
    robloxStudio: Boolean(robloxPath),
    unity: Boolean(unityHubPath),
    godot: hasCmd('godot') || hasCmd('godot4'),
    obs: Boolean(obsPath),
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
 * Calls a Streamable HTTP MCP server via JSON-RPC 2.0 (POST).
 */
export async function queryHttpMcpServer(connector, { method = 'tools/list', params = {}, timeoutMs = 15_000 } = {}) {
  const url = String(connector.url || '').trim();
  if (!url) throw new Error(`URL MCP manquante pour ${connector.id}.`);
  const baseHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(connector.headers || {}),
  };

  const rpcPost = async (payload, sessionId = null) => {
    const headers = sessionId ? { ...baseHeaders, 'Mcp-Session-Id': sessionId } : baseHeaders;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const nextSession = res.headers.get('mcp-session-id') || sessionId;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} (${connector.id}) : ${text.slice(0, 180)}`);
    let data = null;
    if (text.trim().startsWith('{')) {
      data = JSON.parse(text);
    } else {
      // Parse SSE streamable response frames (`data: {...}`)
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          try {
            const parsed = JSON.parse(line.slice(5).trim());
            if (parsed?.result !== undefined || parsed?.error) data = parsed;
          } catch {}
        }
      }
    }
    return { data, sessionId: nextSession };
  };

  const init = await rpcPost({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fs-atg-hub', version: CONNECTOR_VERSION },
    },
  });
  await rpcPost({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, init.sessionId).catch(() => {});
  const call = await rpcPost({ jsonrpc: '2.0', id: 2, method, params }, init.sessionId);
  if (call.data?.error) throw new Error(call.data.error.message || 'Erreur JSON-RPC HTTP MCP');
  return call.data?.result ?? {};
}

/**
 * Calls any stdio MCP server via JSON-RPC 2.0 (`ping`, `tools/list`, `tools/call`,
 * `resources/list`, `resources/read`, `prompts/list`).
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
        clientInfo: { name: 'fs-atg-hub', version: CONNECTOR_VERSION },
      },
    }) + '\n');
  });
}

/** Dispatches JSON-RPC call across stdio or Streamable HTTP / SSE transport. */
export async function queryMcpServer(connector, opts = {}) {
  if (connector.url && (connector.transport === 'http' || connector.transport === 'sse')) {
    return await queryHttpMcpServer(connector, opts);
  }
  return await queryStdioMcpServer(connector, opts);
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
      if (q && !`${c.id} ${c.name} ${c.description} ${c.category} ${c.repo || ''}`.toLowerCase().includes(q)) return false;
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

  if (action === 'detect_local') {
    const discovered = detectLocalMcpServers(params.workspaceRoot || '');
    return { ok: true, action: 'detect_local', ...discovered };
  }

  if (action === 'import_local') {
    const discovered = detectLocalMcpServers(params.workspaceRoot || '');
    const targetId = String(params.connectorId || params.id || 'all').trim().toLowerCase();
    const toImport = targetId === 'all'
      ? discovered.servers
      : discovered.servers.filter((s) => s.id === targetId || s.name.toLowerCase() === targetId);
    if (!toImport.length) {
      return { ok: false, action: 'import_local', imported: [], message: 'Aucun serveur MCP local correspondant trouvé.' };
    }
    const cfg = loadHubConfig(effectivePath);
    const existingIds = new Set([...MCP_HUB_CATALOG.map((c) => c.id), ...cfg.customConnectors.map((c) => c.id)]);
    const imported = [];
    for (const srv of toImport) {
      if (!existingIds.has(srv.id)) {
        cfg.customConnectors.push({
          id: srv.id,
          name: `${srv.name} (${srv.source})`,
          category: 'devops',
          description: `Importé automatiquement depuis ${srv.source} (${srv.transport}).`,
          command: srv.command || '',
          args: srv.args || [],
          url: srv.url || null,
          headers: srv.headers || null,
          defaultPort: null,
          bridgeType: srv.transport || 'stdio',
          envKeys: srv.envKeys || [],
        });
        existingIds.add(srv.id);
      }
      if (!cfg.enabled.includes(srv.id)) cfg.enabled.push(srv.id);
      imported.push({ id: srv.id, name: srv.name, source: srv.source, transport: srv.transport });
    }
    saveHubConfig(cfg, effectivePath);
    logEvent('info', 'mcp_hub', 'hub.import_local', `${imported.length} serveur(s) MCP locaux importés.`, { count: imported.length });
    return { ok: true, action: 'import_local', importedCount: imported.length, imported };
  }

  if (action === 'probe') {
    const apps = detectLocalApps();
    const withPorts = connectors.filter((c) => c.defaultPort);
    const portResults = {};
    await Promise.all(withPorts.map(async (c) => {
      portResults[c.id] = { port: c.defaultPort, listening: await checkPortOpen(c.defaultPort) };
    }));
    const localMcp = detectLocalMcpServers(params.workspaceRoot || '');
    return {
      ok: true,
      action: 'probe',
      totalCatalog: connectors.length,
      localApps: apps,
      bridges: portResults,
      localMcpDiscovered: localMcp.totalDiscovered,
      localMcpSources: localMcp.found,
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
          installed: apps.unity,
          mcpBridgeOpen: Boolean(portResults.unity?.listening),
        },
        godot: {
          installed: apps.godot,
          mcpBridgeOpen: Boolean(portResults.godot?.listening),
        },
        obs: {
          installed: apps.obs,
          websocketOpen: Boolean(portResults['obs-studio']?.listening),
        },
        cli: {
          node: true,
          npx: apps.npx,
          python: apps.python,
          uvx: apps.uvx,
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
    const transport = ['stdio', 'http', 'sse'].includes(params.transport) ? params.transport : (params.url ? 'http' : 'stdio');
    if (!connectors.some((c) => c.id === id)) {
      if (!params.command && !params.url) throw new Error(`Connecteur "${id}" inconnu : fournis "command" ou "url" pour ajouter un connecteur personnalisé.`);
      cfg.customConnectors.push({
        id,
        name: String(params.name || id),
        category: String(params.category || 'devops'),
        description: String(params.description || 'Connecteur MCP personnalisé.'),
        command: params.command ? String(params.command) : '',
        args: Array.isArray(params.args) ? params.args.map(String) : [],
        url: params.url ? String(params.url) : null,
        headers: params.headers && typeof params.headers === 'object' ? params.headers : null,
        defaultPort: Number(params.port) || null,
        bridgeType: transport,
        envKeys: [],
      });
    }
    const ov = { ...(cfg.overrides[id] || {}) };
    if (params.command) ov.command = String(params.command);
    if (Array.isArray(params.args)) ov.args = params.args.map(String);
    if (params.url) ov.url = String(params.url);
    if (params.transport) ov.transport = transport;
    if (params.headers && typeof params.headers === 'object') ov.headers = params.headers;
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
    return { ok: true, action: 'configure', connectorId: id, transport, enabled: true };
  }

  if (action === 'export_config') {
    const enabled = connectors.filter((c) => c.enabled);
    const mcpServers = {};
    for (const c of enabled) {
      mcpServers[c.id] = c.url
        ? { url: c.url, type: c.transport === 'sse' ? 'sse' : 'http', ...(c.headers ? { headers: c.headers } : {}) }
        : { command: c.command, args: c.args };
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

  if (action === 'cloud_list') {
    const st = loadState();
    const servers = await fetchCloudMcpServers(st);
    return { ok: true, action: 'cloud_list', count: servers.length, servers };
  }

  if (action === 'cloud_add') {
    const st = loadState();
    const label = String(params.name || params.connectorId || '').trim();
    const url = String(params.url || '').trim();
    if (!label || !url) throw new Error('Paramètres "name" (server_label) et "url" (server_url) requis pour cloud_add.');
    const created = await addCloudMcpServer(st, {
      server_label: label.slice(0, 64),
      server_url: url,
      server_description: String(params.description || `Serveur MCP ${label}`).slice(0, 500),
      enabled: true,
      ...(params.headers ? { headers: params.headers } : {}),
    });
    return { ok: true, action: 'cloud_add', server: created };
  }

  if (action === 'cloud_delete') {
    const st = loadState();
    const serverId = String(params.serverId || params.connectorId || '').trim();
    if (!serverId) throw new Error('Paramètre "serverId" requis pour cloud_delete.');
    const deleted = await deleteCloudMcpServer(st, serverId);
    return { ok: true, action: 'cloud_delete', deleted };
  }

  if (action === 'deskdock') {
    const st = loadState();
    const res = await controlDeskDock(st, params.deskdockAction || 'status');
    return { ok: res.available, action: 'deskdock', ...res };
  }

  if (['ping', 'tools', 'call', 'resources', 'read_resource', 'prompts'].includes(action)) {
    const id = String(params.connectorId || params.id || '').trim().toLowerCase();
    const conn = connectors.find((c) => c.id === id);
    if (!conn) throw new Error(`Connecteur MCP inconnu : "${id}".`);

    if (action === 'ping') {
      const t0 = Date.now();
      await queryMcpServer(conn, { method: 'ping', params: {}, timeoutMs: 10_000 });
      return { ok: true, action: 'ping', connectorId: id, transport: conn.transport, latencyMs: Date.now() - t0 };
    }

    if (action === 'tools') {
      const cache = loadSchemaCache();
      const cached = cache[id];
      if (!params.forceRefresh && cached && (Date.now() - Number(cached.at || 0) < CACHE_TTL_MS)) {
        return { ok: true, connectorId: id, cached: true, tools: cached.tools || [] };
      }
      const res = await queryMcpServer(conn, { method: 'tools/list', params: {} });
      const tools = res?.tools || [];
      cache[id] = { at: Date.now(), tools };
      saveSchemaCache(cache);
      return { ok: true, connectorId: id, cached: false, tools };
    }

    if (action === 'resources') {
      const res = await queryMcpServer(conn, { method: 'resources/list', params: {} });
      return { ok: true, connectorId: id, resources: res?.resources || [] };
    }

    if (action === 'read_resource') {
      const uri = String(params.uri || '').trim();
      if (!uri) throw new Error('Paramètre "uri" requis pour read_resource.');
      const res = await queryMcpServer(conn, { method: 'resources/read', params: { uri } });
      return { ok: true, connectorId: id, uri, contents: res?.contents || [] };
    }

    if (action === 'prompts') {
      const res = await queryMcpServer(conn, { method: 'prompts/list', params: {} });
      return { ok: true, connectorId: id, prompts: res?.prompts || [] };
    }

    const toolName = String(params.toolName || '').trim();
    if (!toolName) throw new Error('Paramètre "toolName" requis pour call.');
    const res = await queryMcpServer(conn, {
      method: 'tools/call',
      params: { name: toolName, arguments: params.toolArgs || {} },
    });
    return { ok: true, connectorId: id, toolName, result: res };
  }

  throw new Error(`Action fs_mcp_hub inconnue : "${action}".`);
}
