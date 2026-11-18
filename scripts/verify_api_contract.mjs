/**
 * Opt-in, read-only API contract probe. It deliberately never reads a local
 * state file or prints a credential. Run with FS_ATG_CONTRACT_TOKEN set.
 */
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isListLike = (value) => Array.isArray(value)
  || (isRecord(value) && ['data', 'items', 'results', 'models', 'files'].some((key) => Array.isArray(value[key])));

export const API_CONTRACTS = [
  {
    name: 'usage', path: '/user/usage', required: true,
    validate: (value) => isRecord(value),
  },
  {
    name: 'tokenUsage', path: '/user/tokenusage', required: false,
    validate: (value) => isRecord(value),
  },
  {
    name: 'chatAgents', path: '/chats/agents', required: false,
    validate: (value) => Array.isArray(value),
  },
  {
    name: 'models', path: '/models', required: false,
    validate: isListLike,
  },
  {
    name: 'openAiModels', path: '/v1/models', required: false,
    validate: (value) => isRecord(value) && Array.isArray(value.data),
  },
  {
    name: 'streamMetrics', path: '/metrics/chat-streams', required: false,
    validate: (value) => isRecord(value) || Array.isArray(value),
  },
  {
    name: 'skills', path: '/skills', required: false,
    validate: isListLike,
  },
  {
    name: 'projects', path: '/projects', required: false,
    validate: isListLike,
  },
  {
    name: 'mcpServers', path: '/mcp/servers', required: false,
    validate: isListLike,
  },
  {
    name: 'files', path: '/filesv2', required: false,
    validate: isListLike,
  },
];

export function contractResult(contract, status, payload) {
  if (status === 404 && !contract.required) return { name: contract.name, status, available: false, valid: true };
  return {
    name: contract.name,
    status,
    available: status >= 200 && status < 300,
    valid: status >= 200 && status < 300 ? Boolean(contract.validate(payload)) : false,
  };
}

async function probe(baseUrl, token, contract) {
  const response = await fetch(`${baseUrl}${contract.path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* contractResult marks invalid for a successful non-JSON reply */ }
  return contractResult(contract, response.status, payload);
}

export async function verifyApiContract({
  baseUrl = process.env.FS_ATG_CONTRACT_BASE_URL || 'https://api.francestudent.ai',
  token = process.env.FS_ATG_CONTRACT_TOKEN,
} = {}) {
  if (!String(token || '').trim()) return { skipped: true, reason: 'FS_ATG_CONTRACT_TOKEN absent' };
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Le probe de contrat exige HTTPS, sauf pour localhost.');
  }
  const root = url.toString().replace(/\/+$/, '');
  const results = await Promise.all(API_CONTRACTS.map(async (contract) => {
    try { return await probe(root, token, contract); }
    catch { return { name: contract.name, status: null, available: false, valid: false }; }
  }));
  const requiredOk = results.filter((result) => API_CONTRACTS.find((item) => item.name === result.name)?.required)
    .every((result) => result.available && result.valid);
  const models = results.filter((result) => result.name === 'models' || result.name === 'openAiModels');
  const modelsOk = models.some((result) => result.available && result.valid);
  return { skipped: false, ok: requiredOk && modelsOk, results };
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  const report = await verifyApiContract();
  console.log(JSON.stringify(report));
  if (!report.skipped && !report.ok) process.exitCode = 1;
}
