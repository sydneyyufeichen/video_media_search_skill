import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [workbookPath, requestedRunDir = ''] = process.argv.slice(2);
if (!workbookPath) {
  throw new Error('Usage: node scripts/run-incremental-capture.mjs <existing.xlsx> [run-dir]');
}

const runDir = path.resolve(requestedRunDir || `/tmp/allmedia_incremental_${Date.now()}`);
const captureDir = path.join(runDir, 'capture');
const transcriptDir = path.join(runDir, 'transcripts');
const statePath = path.join(runDir, 'state.json');
const rowsPath = path.join(runDir, 'rows.json');
const instagramCookieFile = path.join(runDir, 'instagram.cookies.txt');
fs.mkdirSync(runDir, { recursive: true });

const python = process.env.ALLMEDIA_PYTHON || 'python3';
const node = process.execPath;

function run(label, command, args, options = {}) {
  process.stdout.write(`\n[${label}]\n`);
  const result = spawnSync(command, args, {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: options.timeout ?? 3_600_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

run('extract workbook state', python, ['scripts/extract-incremental-state.py', workbookPath, statePath], { timeout: 300_000 });
run('collect recent posts', node, ['scripts/collect-incremental.mjs', statePath, captureDir]);
run('write temporary Instagram cookie jar', node, ['scripts/write-cookie-jar.mjs', '.env', 'instagram', instagramCookieFile], { timeout: 30_000 });
run('transcribe only new videos', python, [
  'scripts/transcribe-datasets.py',
  '--platform', 'all',
  '--instagram-capture-dir', captureDir,
  '--instagram-cookie-file', instagramCookieFile,
  '--xhs-details-dir', captureDir,
  '--output-dir', transcriptDir,
], { timeout: 24 * 60 * 60 * 1000 });
run('normalize incremental rows', node, ['scripts/prepare-incremental-rows.mjs', captureDir, transcriptDir, rowsPath]);

fs.chmodSync(instagramCookieFile, 0o600);
process.stdout.write(`${JSON.stringify({ rowsPath, runDir, statePath, captureDir, transcriptDir }, null, 2)}\n`);
