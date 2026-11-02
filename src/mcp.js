import { createInterface } from 'node:readline';
import { getQuota } from './quota.js';

const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];
export function serve() {
  const write = obj => process.stdout.write(JSON.stringify(obj) + '\n');
  createInterface({ input: process.stdin }).on('line', async line => {
    let request; try { request = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (!Object.hasOwn(request, 'id')) return;
    const respond = result => write({ jsonrpc: '2.0', id: request.id, result });
    const error = (code, message) => write({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    if (request.method === 'initialize') return respond({ protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'local-agent-quota', version: '0.1.0' } });
    if (request.method === 'ping') return respond({});
    if (request.method === 'tools/list') return respond({ tools: [{ name: 'get_quota', description: 'Read Codex and Claude quota windows, reset times, and freshness. Missing or stale data is not available capacity.', inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['all', 'codex', 'claude'], default: 'all' }, maxAgeSeconds: { type: 'integer', minimum: 0, maximum: 86400, default: 600 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }] });
    if (request.method === 'tools/call' && request.params?.name === 'get_quota') {
      const a = request.params.arguments ?? {};
      if (typeof a !== 'object' || a === null || Array.isArray(a) || Object.keys(a).some(k => !['provider', 'maxAgeSeconds'].includes(k)) || !['all', 'codex', 'claude'].includes(a.provider ?? 'all') || (a.maxAgeSeconds !== undefined && (!Number.isInteger(a.maxAgeSeconds) || a.maxAgeSeconds < 0 || a.maxAgeSeconds > 86400))) return error(-32602, 'Invalid arguments');
      try { return respond({ content: [{ type: 'text', text: JSON.stringify(await getQuota(a.provider, a.maxAgeSeconds), null, 2) }] }); } catch { return respond({ isError: true, content: [{ type: 'text', text: 'Quota read failed.' }] }); }
    }
    return error(-32601, 'Method not found');
  });
}
