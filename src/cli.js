#!/usr/bin/env node
import { getQuota, captureClaude } from './quota.js';
import { serve } from './mcp.js';

const args = process.argv.slice(2);
const command = args.shift() || 'get';
if (command === 'mcp') serve();
else if (command === 'claude-statusline') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  try { const result = await captureClaude(JSON.parse(input)); console.log(result.windows.map(w => `${w.name}: ${w.remainingPercent}% remaining`).join(' | ') || 'Claude quota unavailable'); }
  catch { console.error('Could not capture Claude status-line data.'); process.exitCode = 1; }
} else if (command === 'get') {
  const provider = args[0] || 'all';
  if (!['all', 'codex', 'claude'].includes(provider) || args.length > 1) { console.error('Usage: agent-quota get [all|codex|claude]'); process.exitCode = 2; }
  else console.log(JSON.stringify(await getQuota(provider), null, 2));
} else { console.error('Usage: agent-quota [get [all|codex|claude] | mcp | claude-statusline]'); process.exitCode = 2; }
