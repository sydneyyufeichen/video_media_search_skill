import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const outputDir = process.argv[2] || '/tmp/allmedia_full_capture';
fs.mkdirSync(outputDir, { recursive: true });

const accounts = [
  { platform: 'instagram', account: 'wellness.with.gloria', target: 'wellness.with.gloria' },
  { platform: 'instagram', account: 'tcmbycheehee', target: 'tcmbycheehee' },
  { platform: 'instagram', account: 'dr.franktcm', target: 'dr.franktcm' },
  { platform: 'instagram', account: 'yourtcmguide', target: 'yourtcmguide' },
  { platform: 'xiaohongshu', account: '阿飞泡枸杞', target: '65086f960000000017023c45' },
  { platform: 'xiaohongshu', account: '欧阳会食养', target: '5e4e14f2000000000100745e' },
  { platform: 'xiaohongshu', account: '小七养生说', target: '65853f56000000001d001fb8' },
  { platform: 'xiaohongshu', account: '肖食儿', target: '6513f54a00000000230244b0' },
  { platform: 'xiaohongshu', account: '养生小禾', target: '65afb335000000000e001062' },
  { platform: 'xiaohongshu', account: '袁姐姐全息健康笔记', target: '65ddc0f60000000005008e49' },
];

const manifest = [];
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

for (const item of accounts) {
  const command = item.platform === 'instagram' ? 'user-full' : 'user-video-details';
  const timeout = item.platform === 'instagram' ? 300_000 : 900_000;
  const slug = item.platform === 'instagram'
    ? item.account
    : Buffer.from(item.account, 'utf8').toString('hex');
  const dataPath = path.join(outputDir, `${item.platform}_${slug}.json`);
  if (fs.existsSync(dataPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (Array.isArray(existing) && existing.length > 0) {
        const status = { ...item, command, exitCode: 0, timedOut: false, rowCount: existing.length, dataPath, resumed: true };
        manifest.push(status);
        process.stdout.write(`SKIP ${item.platform} ${item.account} rows=${existing.length}\n`);
        continue;
      }
    } catch {
      // Re-run malformed or empty captures.
    }
  }
  const args = [
    item.platform,
    command,
    item.target,
    '--limit',
    '1000',
    '-f',
    'json',
    '--window',
    'background',
    '--site-session',
    'persistent',
  ];
  process.stdout.write(`START ${item.platform} ${item.account}\n`);
  const result = spawnSync('opencli', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: item.platform === 'instagram' ? '600' : '1200' },
  });
  let rows = [];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    rows = [];
  }
  fs.writeFileSync(dataPath, JSON.stringify(rows, null, 2));
  if (result.stderr) fs.writeFileSync(`${dataPath}.stderr.txt`, result.stderr);
  const status = {
    ...item,
    command,
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    rowCount: rows.length,
    dataPath,
  };
  manifest.push(status);
  process.stdout.write(`DONE ${item.platform} ${item.account} rows=${rows.length} exit=${result.status}\n`);
  await wait(3_000);
}

const manifestPath = path.join(outputDir, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
process.stdout.write(`MANIFEST ${manifestPath}\n`);
