import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [account, userId, manifestPath, detailsPath, transcriptsDir] = process.argv.slice(2);
if (!account || !userId || !manifestPath || !detailsPath || !transcriptsDir) {
  throw new Error('Usage: node scripts/run-xhs-safe-transcription.mjs <account> <user-id> <manifest.json> <details.json> <transcripts-dir>');
}

const python = process.env.VIDEO_MEDIA_SEARCH_PYTHON || path.resolve('work/qwen3-asr-venv/bin/python');
const mediaLimit = Math.max(0, Number(process.env.XHS_MEDIA_LIMIT ?? 0));
const slug = Buffer.from(account, 'utf8').toString('hex');
const transcriptPath = path.join(transcriptsDir, `xiaohongshu_${slug}.json`);
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const validSignedRow = (row) => {
  const id = String(row?.media_id ?? '');
  const url = String(row?.url ?? '');
  return /^[0-9a-f]{24}$/i.test(id)
    && id !== userId
    && url.includes(`/user/profile/${userId}/${id}`)
    && url.includes('xsec_token=')
    && String(row.type ?? '') !== 'normal';
};

let manifest = readJson(manifestPath, []).filter(validSignedRow);
if (mediaLimit) manifest = manifest.slice(0, mediaLimit);
process.stdout.write(`START ${account} candidates=${manifest.length}\n`);

for (let index = 0; index < manifest.length; index += 1) {
  const item = manifest[index];
  const mediaId = String(item.media_id);
  const completed = readJson(transcriptPath, {})[mediaId];
  if (['complete', 'no_speech'].includes(completed?.status)) {
    process.stdout.write(`SKIP ${account} ${index + 1}/${manifest.length} ${mediaId} status=${completed.status}\n`);
    continue;
  }

  const detailRun = spawnSync(process.execPath, [
    path.resolve('scripts/collect-xhs-details-safe.mjs'),
    account, userId, manifestPath, detailsPath,
  ], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      XHS_DETAIL_MEDIA_ID: mediaId,
      XHS_DETAIL_BATCH_SIZE: '1',
      XHS_DETAIL_BATCH_DELAY_MS: '30000',
      XHS_SITE_SESSION: 'persistent',
    },
  });
  if (detailRun.stdout) process.stdout.write(detailRun.stdout);
  if (detailRun.stderr) process.stderr.write(detailRun.stderr);
  if (detailRun.status !== 0) throw new Error(`detail collection stopped for ${mediaId}`);

  const detail = readJson(detailsPath, []).find((row) => String(row.media_id ?? '') === mediaId);
  if (!detail || detail.detail_status !== 'complete') throw new Error(`missing complete detail for ${mediaId}`);
  if (!detail.is_video || !detail.media_url) {
    process.stdout.write(`SKIP ${account} ${index + 1}/${manifest.length} ${mediaId} not-video\n`);
    continue;
  }

  const asrRun = spawnSync(python, [
    path.resolve('scripts/transcribe-xhs-qwen3-cloud.py'),
    '--account', account,
    '--details-dir', path.dirname(detailsPath),
    '--output-dir', transcriptsDir,
    '--media-id', mediaId,
  ], {
    encoding: 'utf8',
    timeout: Number(process.env.XHS_ASR_TIMEOUT_MS ?? 21_600_000),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
  if (asrRun.stdout) process.stdout.write(asrRun.stdout);
  if (asrRun.stderr) process.stderr.write(asrRun.stderr);
  const result = readJson(transcriptPath, {})[mediaId];
  if (asrRun.status !== 0 || !['complete', 'no_speech'].includes(result?.status)) {
    throw new Error(`ASR stopped for ${mediaId}: ${result?.error || `exit ${asrRun.status}`}`);
  }
  process.stdout.write(`DONE_ITEM ${account} ${index + 1}/${manifest.length} ${mediaId} status=${result.status}\n`);
}

process.stdout.write(`DONE ${account}\n`);
