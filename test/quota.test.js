import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCodex, normalizeClaude, normalizeClaudeSdk, captureClaude, readClaude } from '../src/quota.js';

test('normalizes multiple Codex buckets without treating missing values as zero', () => {
  const result = normalizeCodex({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, resetsAt: 1700000000, windowDurationMins: 300 }, secondary: null }, extra: { primary: { usedPercent: 80 } } } });
  assert.deepEqual(result.windows.map(w => [w.name, w.remainingPercent]), [['codex:primary', 75], ['extra:primary', 20]]);
  assert.equal(normalizeCodex({}).status, 'unavailable');
});
test('Claude captures only quota and preserves the last useful observation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-quota-')); process.env.AGENT_QUOTA_CLAUDE_SNAPSHOT = join(dir, 'snapshot.json');
  try {
    assert.equal(normalizeClaude({}).status, 'unavailable');
    await captureClaude({ secret: 'must-not-save', rate_limits: { five_hour: { used_percentage: 30, resets_at: 1700000000 } } });
    await captureClaude({});
    const reading = await readClaude(0, Date.now() + 2000);
    assert.equal(reading.status, 'stale'); assert.equal(reading.windows[0].remainingPercent, 70); assert.equal(JSON.stringify(reading).includes('must-not-save'), false);
  } finally { delete process.env.AGENT_QUOTA_CLAUDE_SNAPSHOT; await rm(dir, { recursive: true, force: true }); }
});
test('normalizes experimental Claude usage windows and ignores unrelated data', () => {
  const result = normalizeClaudeSdk({ rate_limits: { five_hour: { utilization: 43, resets_at: '2026-11-02T18:30:00Z' }, seven_day_opus: null, spend: { amount: 20 } } });
  assert.equal(result.windows.length, 1); assert.equal(result.windows[0].remainingPercent, 57);
});
test('MCP initializes, lists and calls the tool over stdio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-quota-mcp-'));
  const snapshot = join(dir, 'snapshot.json');
  await writeFile(snapshot, JSON.stringify(normalizeClaude({ rate_limits: { five_hour: { used_percentage: 30 } } })));
  const proc = spawn(process.execPath, ['src/cli.js', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_QUOTA_CLAUDE_SNAPSHOT: snapshot } });
  let out = ''; proc.stdout.on('data', chunk => out += chunk);
  for (const request of [{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_quota',arguments:{provider:'claude'}}}]) proc.stdin.write(JSON.stringify(request)+'\n');
  proc.stdin.end(); await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
  const messages = out.trim().split('\n').map(JSON.parse);
  assert.equal(messages.find(m => m.id === 1).result.protocolVersion, '2025-06-18');
  assert.equal(messages.find(m => m.id === 2).result.tools[0].name, 'get_quota');
  assert.equal(JSON.parse(messages.find(m => m.id === 3).result.content[0].text).providers[0].provider, 'claude');
  await rm(dir, { recursive: true, force: true });
});
