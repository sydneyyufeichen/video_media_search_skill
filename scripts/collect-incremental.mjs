import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [statePath, outputDir = '/tmp/allmedia_incremental_capture'] = process.argv.slice(2);
if (!statePath) throw new Error('Usage: node scripts/collect-incremental.mjs <state.json> [output-dir]');
fs.mkdirSync(outputDir, { recursive: true });

const accounts = [
  { platform: 'xiaohongshu', account: '阿飞泡枸杞', target: '65086f960000000017023c45' },
  { platform: 'xiaohongshu', account: '欧阳会食养', target: '5e4e14f2000000000100745e' },
  { platform: 'xiaohongshu', account: '小七养生说', target: '65853f56000000001d001fb8' },
  { platform: 'xiaohongshu', account: '肖食儿', target: '6513f54a00000000230244b0' },
  { platform: 'xiaohongshu', account: '养生小禾', target: '65afb335000000000e001062' },
  { platform: 'instagram', account: 'tcmbycheehee', target: 'tcmbycheehee' },
  { platform: 'instagram', account: 'wellness.with.gloria', target: 'wellness.with.gloria' },
  { platform: 'instagram', account: 'dr.franktcm', target: 'dr.franktcm' },
  { platform: 'instagram', account: 'yourtcmguide', target: 'yourtcmguide' },
];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const recentLimit = Math.max(12, Number(process.env.INCREMENTAL_RECENT_LIMIT ?? 60));
const maxLimit = Math.max(recentLimit, Number(process.env.INCREMENTAL_MAX_LIMIT ?? 500));
const siteSession = String(process.env.OPENCLI_SITE_SESSION ?? 'persistent');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseRows(run) {
  try {
    const parsed = JSON.parse(run.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function runOpenCli(args, timeout = 300_000) {
  return spawnSync('opencli', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: String(Math.ceil(timeout / 1000) - 20) },
  });
}

function saveDiagnostic(account, suffix, value) {
  const safe = Buffer.from(account, 'utf8').toString('hex');
  fs.writeFileSync(path.join(outputDir, `${safe}.${suffix}`), value || '');
}

const doctor = spawnSync('agent-reach', ['doctor', '--json'], { encoding: 'utf8', timeout: 120_000 });
if (doctor.status !== 0) {
  throw new Error(`agent-reach doctor failed: ${(doctor.stderr || doctor.stdout || '').trim().slice(-800)}`);
}
fs.writeFileSync(path.join(outputDir, 'agent-reach-doctor.json'), doctor.stdout);

const report = [];
for (const item of accounts) {
  const accountState = state.accounts?.[item.account];
  if (!accountState) throw new Error(`Workbook state missing account: ${item.account}`);
  const known = new Set(accountState.known_media_ids ?? []);
  let captured = [];
  let overlap = false;
  let limit = recentLimit;
  let lastRun;

  while (limit <= maxLimit) {
    const command = item.platform === 'instagram' ? 'user-full' : 'user-all-notes';
    lastRun = runOpenCli([
      item.platform, command, item.target,
      '--limit', String(limit), '-f', 'json',
      '--window', item.platform === 'instagram' ? 'background' : 'foreground',
      '--site-session', siteSession, '--keep-tab', 'false',
    ], item.platform === 'instagram' ? 300_000 : 600_000);
    captured = parseRows(lastRun);
    overlap = captured.some((row) => known.has(String(row.media_id ?? '')));
    if (lastRun.status === 0 && (overlap || captured.length < limit)) break;
    if (limit === maxLimit) break;
    limit = Math.min(maxLimit, limit * 2);
    await wait(3_000);
  }

  if (lastRun?.stderr) saveDiagnostic(item.account, 'stderr.txt', lastRun.stderr);
  if (lastRun?.status !== 0 || !captured.length) {
    throw new Error(`${item.platform} ${item.account} recent fetch failed (exit ${lastRun?.status}, rows ${captured.length})`);
  }
  if (!overlap && captured.length >= limit) {
    throw new Error(`${item.account} has no overlap within the newest ${limit} posts; run the full backfill path before appending`);
  }

  const unseen = captured.filter((row) => row.media_id && !known.has(String(row.media_id)));
  let rows = unseen;
  if (item.platform === 'xiaohongshu' && unseen.length) {
    const detailed = [];
    for (let offset = 0; offset < unseen.length; offset += 20) {
      const batch = unseen.slice(offset, offset + 20);
      const detailRun = runOpenCli([
        'xiaohongshu', 'note-details-batch', JSON.stringify(batch),
        '-f', 'json', '--window', 'foreground', '--site-session', siteSession, '--keep-tab', 'false',
      ], 240_000);
      const detailRows = parseRows(detailRun);
      if (detailRun.stderr) saveDiagnostic(item.account, `details-${offset}.stderr.txt`, detailRun.stderr);
      if (detailRun.status !== 0 || !detailRows.length) {
        throw new Error(`XHS detail batch failed for ${item.account} at offset ${offset}`);
      }
      detailed.push(...detailRows);
      await wait(2_500);
    }
    rows = detailed.filter((row) => row.detail_status === 'complete' && row.is_video);
  }

  const slug = item.platform === 'instagram' ? item.account : Buffer.from(item.account, 'utf8').toString('hex');
  const dataPath = path.join(outputDir, `${item.platform}_${slug}.json`);
  fs.writeFileSync(dataPath, JSON.stringify(rows, null, 2));
  report.push({ ...item, scannedRows: captured.length, overlap, unseenRows: unseen.length, videoRows: rows.length, dataPath });
  process.stdout.write(`DONE ${item.platform} ${item.account} scanned=${captured.length} new=${rows.length}\n`);
  await wait(2_500);
}

fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ outputDir, report }, null, 2)}\n`);
