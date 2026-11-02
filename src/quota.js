import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const snapshotPath = () => process.env.AGENT_QUOTA_CLAUDE_SNAPSHOT || join(homedir(), '.agent-quota', 'claude.json');
const pct = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
function windowData(name, used, reset, minutes = null) {
  used = pct(used);
  if (used === null) return null;
  const date = typeof reset === 'number' ? new Date(reset * 1000) : null;
  return { name, usedPercent: used, remainingPercent: 100 - used, resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, windowMinutes: minutes };
}
export function normalizeCodex(result, now = new Date()) {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length ? result.rateLimitsByLimitId : result.rateLimits ? { [result.rateLimits.limitId || 'codex']: result.rateLimits } : {};
  const windows = [];
  for (const [id, bucket] of Object.entries(buckets)) for (const key of ['primary', 'secondary']) {
    const w = bucket?.[key]; if (!w) continue;
    const item = windowData(`${id}:${key}`, w.usedPercent, w.resetsAt, w.windowDurationMins ?? null); if (item) windows.push(item);
  }
  return { provider: 'codex', status: windows.length ? 'ok' : 'unavailable', source: 'codex-app-server', observedAt: now.toISOString(), windows };
}
export function normalizeClaude(data, now = new Date()) {
  const rates = data?.rate_limits || {};
  const windows = [['five_hour', 300], ['seven_day', 10080], ['spend_limit', null]].map(([name, minutes]) => windowData(name, rates[name]?.used_percentage, rates[name]?.resets_at, minutes)).filter(Boolean);
  return { provider: 'claude', status: windows.length ? 'ok' : 'unavailable', source: 'claude-statusline', observedAt: now.toISOString(), windows };
}
async function saveClaude(snapshot) {
  // Never replace a useful observation with a status update lacking quota fields.
  if (snapshot.status === 'ok') {
    const path = snapshotPath(); await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 }); await rename(temp, path); }
    finally { await import('node:fs/promises').then(fs => fs.rm(temp, { force: true })).catch(() => {}); }
  }
  return snapshot;
}
export async function captureClaude(data) { return saveClaude(normalizeClaude(data)); }
export function normalizeClaudeSdk(data, now = new Date()) {
  const rates = data?.rate_limits || {};
  const windows = Object.entries(rates).flatMap(([name, value]) => {
    if (!value || typeof value !== 'object' || pct(value.utilization) === null) return [];
    const reset = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) / 1000 : null;
    return [windowData(name, value.utilization, reset, name === 'five_hour' ? 300 : name.startsWith('seven_day') ? 10080 : null)];
  });
  return { provider: 'claude', status: windows.length ? 'ok' : 'unavailable', source: 'claude-sdk-experimental', observedAt: now.toISOString(), windows };
}
export async function probeClaude(timeoutMs = 15000) {
  let q, timer;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    async function* idle() { await new Promise(() => {}); }
    const options = {};
    if (process.env.AGENT_QUOTA_CLAUDE) options.pathToClaudeCodeExecutable = process.env.AGENT_QUOTA_CLAUDE;
    q = query({ prompt: idle(), options });
    const data = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), timeoutMs); })]);
    return await saveClaude(normalizeClaudeSdk(data));
  } catch { return { provider: 'claude', status: 'unavailable', source: 'claude-sdk-experimental', observedAt: null, windows: [], message: 'Claude usage probe failed or timed out.' }; }
  finally { clearTimeout(timer); q?.close(); }
}
export async function readClaude(maxAgeSeconds = 600, now = Date.now()) {
  try {
    const data = JSON.parse(await readFile(snapshotPath(), 'utf8'));
    const time = Date.parse(data.observedAt);
    if (data.provider !== 'claude' || !Number.isFinite(time) || !Array.isArray(data.windows) || !data.windows.length) throw Error('invalid snapshot');
    const ageSeconds = Math.max(0, Math.floor((now - time) / 1000));
    return { ...data, status: ageSeconds > maxAgeSeconds ? 'stale' : 'ok', ageSeconds };
  } catch { return { provider: 'claude', status: 'unavailable', source: 'claude-statusline', observedAt: null, windows: [], message: 'No usable Claude status-line snapshot. See README.' }; }
}
export function readCodex({ command = process.env.AGENT_QUOTA_CODEX || 'codex', timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    let child, done = false, timer;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); child?.kill(); resolve(value); };
    const fail = message => finish({ provider: 'codex', status: 'unavailable', source: 'codex-app-server', observedAt: null, windows: [], message });
    try { child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return fail('Could not start codex app-server.'); }
    timer = setTimeout(() => fail('Codex app-server timed out.'), timeoutMs);
    child.on('error', () => fail('Could not start codex app-server.'));
    child.on('exit', () => fail('Codex app-server exited before returning limits.'));
    child.stdin.on('error', () => fail('Could not communicate with codex app-server.'));
    const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
    createInterface({ input: child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) { if (msg.error) return fail('Codex initialization failed.'); send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
      if (msg.id === 2) { if (msg.error || !msg.result) return fail('Codex could not read account limits.'); finish(normalizeCodex(msg.result)); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'local_agent_quota', version: '0.1.0' } } });
  });
}
export async function getQuota(provider = 'all', maxAgeSeconds = 600) {
  const claude = async () => { const cached = await readClaude(maxAgeSeconds); if (cached.status === 'ok') return cached; const live = await probeClaude(); return live.status === 'ok' ? live : cached.status === 'stale' ? { ...cached, message: 'Live refresh failed; showing stale observation.' } : live; };
  const jobs = []; if (provider !== 'claude') jobs.push(readCodex()); if (provider !== 'codex') jobs.push(claude());
  return { providers: await Promise.all(jobs) };
}
