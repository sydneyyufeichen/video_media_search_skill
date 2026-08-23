import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [manifestDir = '/tmp/allmedia_xhs_manifests', outputDir = '/tmp/allmedia_xhs_details'] = process.argv.slice(2);
fs.mkdirSync(outputDir, { recursive: true });

const allAccounts = JSON.parse(fs.readFileSync(path.join(manifestDir, 'manifest.json'), 'utf8'));
const accountFilter = String(process.env.XHS_ACCOUNT ?? '').trim();
const accounts = accountFilter ? allAccounts.filter((item) => item.account === accountFilter) : allAccounts;
const batchSize = Math.max(1, Number(process.env.XHS_DETAIL_BATCH_SIZE ?? 20));
const summary = [];

for (const account of accounts) {
  const source = JSON.parse(fs.readFileSync(account.dataPath, 'utf8'));
  const slug = Buffer.from(account.account, 'utf8').toString('hex');
  const outputPath = path.join(outputDir, `${slug}.json`);
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(outputPath, 'utf8')); } catch { saved = []; }
  const byId = new Map(saved.map((row) => [row.media_id, row]));

  for (let pass = 1; pass <= 3; pass += 1) {
    const pending = source.filter((row) => {
      const savedRow = byId.get(row.media_id);
      return savedRow?.detail_status !== 'complete' || (savedRow?.is_video && !savedRow?.media_url);
    });
    if (!pending.length) break;
    process.stdout.write(`ACCOUNT ${account.account} pass=${pass} pending=${pending.length}\n`);
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const run = spawnSync('opencli', [
        'xiaohongshu', 'note-details-batch', JSON.stringify(batch),
        '-f', 'json', '--window', 'foreground', '--site-session', 'ephemeral',
      ], {
        encoding: 'utf8',
        timeout: 240_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '180' },
      });
      let rows = [];
      try {
        const parsed = JSON.parse(run.stdout || '[]');
        rows = Array.isArray(parsed) ? parsed : [];
      } catch {
        rows = [];
      }
      for (const row of rows) byId.set(row.media_id, row);
      if (!rows.length) {
        for (const row of batch) byId.set(row.media_id, { ...row, detail_status: `batch_failed: exit ${run.status}` });
      }
      fs.writeFileSync(outputPath, JSON.stringify([...byId.values()], null, 2));
      process.stdout.write(`BATCH ${account.account} ${Math.min(offset + batch.length, pending.length)}/${pending.length} rows=${rows.length} exit=${run.status}\n`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  const rows = [...byId.values()];
  const result = {
    account: account.account,
    manifestRows: source.length,
    detailedRows: rows.filter((row) => row.detail_status === 'complete').length,
    videoRows: rows.filter((row) => row.detail_status === 'complete' && row.is_video).length,
    mediaUrls: rows.filter((row) => row.detail_status === 'complete' && row.is_video && row.media_url).length,
    failedRows: rows.filter((row) => row.detail_status !== 'complete').length,
    outputPath,
  };
  summary.push(result);
  process.stdout.write(`DONE ${JSON.stringify(result)}\n`);
}

fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(summary, null, 2));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
