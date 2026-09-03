#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const requested = process.argv.slice(2);
const platforms = requested.length ? requested : ['xiaohongshu', 'instagram'];
const probes = {
  xiaohongshu: ['xiaohongshu', 'feed', '--limit', '1', '-f', 'json'],
  instagram: ['instagram', 'explore', '--limit', '1', '-f', 'json'],
};
const results = [];
for (const platform of platforms) {
  if (!probes[platform]) {
    results.push({ platform, ok: false, error: 'unsupported platform' });
    continue;
  }
  const run = spawnSync('opencli', probes[platform], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '120' },
  });
  let count = null;
  let parseError = '';
  if (run.status === 0) {
    try {
      const payload = JSON.parse(run.stdout);
      const items = Array.isArray(payload) ? payload : payload?.items || payload?.data;
      count = Array.isArray(items) ? items.length : null;
    } catch (error) {
      parseError = `invalid JSON: ${error.message}`;
    }
  }
  results.push({
    platform,
    ok: run.status === 0 && !parseError,
    count,
    error: parseError || (run.status === 0 ? '' : (run.stderr || run.stdout || run.error?.message || 'unknown error').trim()),
  });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exit(results.every((item) => item.ok) ? 0 : 1);
