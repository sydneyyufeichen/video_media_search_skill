import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const outputDir = process.argv[2] || '/tmp/allmedia_xhs_manifests';
fs.mkdirSync(outputDir, { recursive: true });

const allAccounts = [
  { account: '阿飞泡枸杞', target: '65086f960000000017023c45' },
  { account: '欧阳会食养', target: '5e4e14f2000000000100745e' },
  { account: '小七养生说', target: '65853f56000000001d001fb8' },
  { account: '肖食儿', target: '6513f54a00000000230244b0' },
  { account: '养生小禾', target: '65afb335000000000e001062' },
  { account: '袁姐姐全息健康笔记', target: '65ddc0f60000000005008e49' },
];
const accountFilter = String(process.env.XHS_ACCOUNT ?? '').trim();
const siteSession = String(process.env.XHS_SITE_SESSION ?? 'ephemeral').trim();
const accounts = accountFilter ? allAccounts.filter((item) => item.account === accountFilter) : allAccounts;

const results = [];
for (const item of accounts) {
  const slug = Buffer.from(item.account, 'utf8').toString('hex');
  const dataPath = path.join(outputDir, `${slug}.json`);
  process.stdout.write(`START ${item.account}\n`);
  const run = spawnSync('opencli', [
    'xiaohongshu', 'user-all-notes', item.target,
    '--limit', '5000', '-f', 'json',
    '--window', 'foreground', '--site-session', siteSession, '--keep-tab', 'false',
  ], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '480' },
  });
  let rows = [];
  try {
    const parsed = JSON.parse(run.stdout || '[]');
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    rows = [];
  }
  fs.writeFileSync(dataPath, JSON.stringify(rows, null, 2));
  if (run.stderr) fs.writeFileSync(`${dataPath}.stderr.txt`, run.stderr);
  const result = { ...item, rows: rows.length, exitCode: run.status, dataPath };
  results.push(result);
  process.stdout.write(`DONE ${item.account} rows=${rows.length} exit=${run.status}\n`);
}

fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(results, null, 2));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
