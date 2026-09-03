#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const platform = argv.shift();
const mode = argv.shift();
const target = argv.shift();

function option(name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const output = option('output');
const limit = Math.max(1, Number(option('limit', '60')));
const dryRun = argv.includes('--dry-run');
if (!platform || !mode || !target || !output) {
  fail('Usage: node scripts/collect-social.mjs <platform> <mode> <target> --output FILE [--limit N] [--dry-run]');
}

const commands = {
  xiaohongshu: {
    account: ['xiaohongshu', 'user-video-details', target, '--limit', String(limit), '-f', 'json'],
    search: ['xiaohongshu', 'search', target, '--limit', String(limit), '-f', 'json'],
  },
  instagram: {
    account: ['instagram', 'user-full', target, '--limit', String(limit), '-f', 'json'],
    search: ['instagram', 'search', target, '--limit', String(limit), '-f', 'json'],
  },
};

const command = commands[platform]?.[mode];
if (!command) fail(`Unsupported platform/mode: ${platform}/${mode}`);
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ executable: 'opencli', args: command }, null, 2)}\n`);
  process.exit(0);
}

const run = spawnSync('opencli', command, {
  encoding: 'utf8',
  timeout: Number(process.env.VIDEO_MEDIA_SEARCH_CAPTURE_TIMEOUT_MS || 900000),
  env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT || '900' },
});
if (run.error) fail(`${platform} collection failed: ${run.error.message}`);
if (run.status !== 0) fail(`${platform} collection failed: ${(run.stderr || run.stdout).trim()}`);
let payload;
try {
  payload = JSON.parse(run.stdout);
} catch (error) {
  fail(`${platform} returned invalid JSON: ${error.message}`);
}
const envelope = {
  platform,
  mode,
  target,
  collected_at: new Date().toISOString(),
  items: Array.isArray(payload) ? payload : payload?.items || payload?.data || payload,
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
fs.renameSync(temporary, output);
process.stdout.write(`${JSON.stringify({ platform, mode, target, output, count: Array.isArray(envelope.items) ? envelope.items.length : null }, null, 2)}\n`);
