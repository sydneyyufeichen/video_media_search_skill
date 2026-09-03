import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const outputDir = process.argv[2] || '/tmp/video_media_search_xhs_manifests';
fs.mkdirSync(outputDir, { recursive: true });

const defaultAccounts = [
  { account: '阿飞泡枸杞', target: '65086f960000000017023c45' },
  { account: '欧阳会食养', target: '5e4e14f2000000000100745e' },
  { account: '肖食儿', target: '6513f54a00000000230244b0' },
  { account: '养生小禾', target: '65afb335000000000e001062' },
  { account: '袁姐姐全息健康笔记', target: '65ddc0f60000000005008e49' },
  { account: '是小琼啊', target: '5a1075134eacab60b17c74b1' },
  { account: '艾先生讲思路', target: '5f3a20220000000001002380' },
  { account: 'JIN聊养生', target: '61d16bdb0000000010006f59' },
];
const configuredAccounts = String(process.env.XHS_ACCOUNTS_JSON ?? '').trim();
const allAccounts = configuredAccounts ? JSON.parse(configuredAccounts) : defaultAccounts;
if (!Array.isArray(allAccounts) || allAccounts.some((item) => !item?.account || !item?.target)) {
  throw new Error('XHS_ACCOUNTS_JSON must be a JSON array of {account,target} objects');
}
const accountFilter = String(process.env.XHS_ACCOUNT ?? '').trim();
const siteSession = String(process.env.XHS_SITE_SESSION ?? 'ephemeral').trim();
const maxAttempts = String(process.env.XHS_MAX_ATTEMPTS ?? '400').trim();
const stableLimit = String(process.env.XHS_STABLE_LIMIT ?? '20').trim();
const scrollDelayMs = String(process.env.XHS_SCROLL_DELAY_MS ?? '2500').trim();
const profileTimeoutMs = Math.max(600_000, Number(process.env.XHS_PROFILE_TIMEOUT_MS ?? 3_600_000));
const accounts = accountFilter ? allAccounts.filter((item) => item.account === accountFilter) : allAccounts;

const results = [];
for (const item of accounts) {
  const slug = Buffer.from(item.account, 'utf8').toString('hex');
  const dataPath = path.join(outputDir, `${slug}.json`);
  process.stdout.write(`START ${item.account}\n`);
  const run = spawnSync('opencli', [
    'xiaohongshu', 'user-all-notes', item.target,
    '--limit', '5000', '-f', 'json',
    '--max-attempts', maxAttempts, '--stable-limit', stableLimit, '--scroll-delay-ms', scrollDelayMs,
    '--window', 'foreground', '--site-session', siteSession, '--keep-tab', 'false',
  ], {
    encoding: 'utf8',
    timeout: profileTimeoutMs,
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
