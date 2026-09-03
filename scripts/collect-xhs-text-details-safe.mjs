import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [account, userId, manifestPath, outputPath] = process.argv.slice(2);
if (!account || !userId || !manifestPath || !outputPath) {
  throw new Error('Usage: node collect-xhs-text-details-safe.mjs <account> <user-id> <manifest.json> <output.json>');
}

const batchSize = Math.max(1, Math.min(40, Number(process.env.XHS_DETAIL_BATCH_SIZE ?? 1)));
const batchDelayMs = Math.max(2_000, Number(process.env.XHS_DETAIL_BATCH_DELAY_MS ?? 2_000));
const limit = Math.max(0, Number(process.env.XHS_DETAIL_LIMIT ?? 0));
const mediaIdFilter = String(process.env.XHS_DETAIL_MEDIA_ID ?? '').trim();
const siteSession = String(process.env.XHS_SITE_SESSION ?? 'persistent');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const saveJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
};
const validSignedRow = (row) => {
  const id = String(row?.media_id ?? '');
  const url = String(row?.url ?? '');
  return /^[0-9a-f]{24}$/i.test(id)
    && id !== userId
    && (url.includes(`/user/profile/${userId}/${id}`) || url.includes(`/explore/${id}`))
    && url.includes('xsec_token=');
};
const isRiskFailure = (status) => /failed:.*(?:401|403|429|risk control|访问频繁|操作频繁|验证码|安全验证)/i.test(String(status));

let rows = readJson(manifestPath, []).filter(validSignedRow);
rows = rows.filter((row) => String(row.type ?? '') === 'normal');
if (mediaIdFilter) rows = rows.filter((row) => String(row.media_id ?? '') === mediaIdFilter);
if (limit) rows = rows.slice(0, limit);

const existingRows = readJson(outputPath, []);
const existing = new Map(existingRows.map((row) => [String(row.media_id ?? ''), row]));
const complete = (row) => row?.detail_status === 'complete';
const pending = rows.filter((row) => !complete(existing.get(String(row.media_id ?? ''))));
process.stdout.write(`START_TEXT ${account} candidates=${rows.length} complete=${rows.length - pending.length} pending=${pending.length}\n`);

for (let offset = 0; offset < pending.length; offset += batchSize) {
  const batch = pending.slice(offset, offset + batchSize);
  const run = spawnSync('opencli', [
    'xiaohongshu', 'note-details-batch', JSON.stringify(batch),
    '-f', 'json', '--window', 'foreground', '--site-session', siteSession, '--keep-tab', 'false',
  ], {
    encoding: 'utf8',
    timeout: 180_000 + batch.length * 10_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: String(180 + batch.length * 10) },
  });
  let results = [];
  try { results = JSON.parse(run.stdout || '[]'); } catch { results = []; }
  if (run.status !== 0 || !Array.isArray(results) || !results.length) {
    throw new Error(`text detail batch failed at offset ${offset}: ${(run.stderr || run.stdout || '').trim().slice(-500)}`);
  }
  for (const result of results) {
    if (result?.media_id) existing.set(String(result.media_id), result);
  }
  saveJson(outputPath, [...existing.values()]);
  const failed = results.filter((result) => String(result?.detail_status ?? '').startsWith('failed:'));
  const riskFailure = failed.find((result) => isRiskFailure(result.detail_status));
  if (riskFailure) throw new Error(`risk stop: ${riskFailure.detail_status}`);
  process.stdout.write(`CHECKPOINT_TEXT ${account} offset=${offset} returned=${results.length} total=${existing.size} failed=${failed.length}\n`);
  const failureLimit = Math.max(3, Math.ceil(results.length * 0.2));
  if (failed.length >= failureLimit) throw new Error(`text detail stop: failed ${failed.length}/${results.length}`);
  if (offset + batch.length < pending.length) await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
}

process.stdout.write(`DONE_TEXT ${account} details=${existing.size}\n`);
