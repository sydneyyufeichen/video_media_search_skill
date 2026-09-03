import fs from 'node:fs/promises';
import path from 'node:path';

const [captureDir, transcriptDir, outputPath] = process.argv.slice(2);
if (!captureDir || !transcriptDir || !outputPath) {
  throw new Error('Usage: node scripts/prepare-incremental-rows.mjs <capture-dir> <transcript-dir> <rows.json>');
}

const defaultAccounts = [
  { platform: 'xiaohongshu', account: '阿飞泡枸杞' },
  { platform: 'xiaohongshu', account: '欧阳会食养' },
  { platform: 'xiaohongshu', account: '小七养生说' },
  { platform: 'xiaohongshu', account: '肖食儿' },
  { platform: 'xiaohongshu', account: '养生小禾' },
  { platform: 'instagram', account: 'tcmbycheehee' },
  { platform: 'instagram', account: 'wellness.with.gloria' },
  { platform: 'instagram', account: 'dr.franktcm' },
  { platform: 'instagram', account: 'yourtcmguide' },
];
const envXhs = String(process.env.XHS_ACCOUNTS_JSON ?? '').trim();
const xhsAccounts = envXhs
  ? JSON.parse(envXhs).map((item) => ({
      platform: 'xiaohongshu',
      account: typeof item === 'string' ? item : item.account,
    }))
  : defaultAccounts.filter((item) => item.platform === 'xiaohongshu');
const accounts = [...xhsAccounts, ...defaultAccounts.filter((item) => item.platform === 'instagram')];

async function readJsonFirst(dir, names, fallback) {
  for (const name of names) {
    const value = await readJson(path.join(dir, name), fallback);
    if (Array.isArray(value) && value.length) return value;
  }
  return fallback;
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; }
}

function shortcode(url) {
  return String(url ?? '').match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/i)?.[1] ?? '';
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value).trim().replace(/,/g, '');
  const match = text.match(/^([\d.]+)\s*(万|亿|k|m)?$/i);
  if (!match) return null;
  const multipliers = { '': 1, '万': 10_000, '亿': 100_000_000, k: 1_000, m: 1_000_000 };
  return Math.round(Number(match[1]) * multipliers[(match[2] ?? '').toLowerCase()]);
}

function duration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 10_000 ? numeric / 1000 : numeric;
}

function xhsDate(mediaId) {
  const prefix = String(mediaId ?? '').slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(prefix)) return '';
  return formatXhsTime(Number.parseInt(prefix, 16) * 1000);
}

function formatXhsTime(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
  }
  const text = String(value).trim();
  if (/^\d{10,}$/.test(text)) {
    return new Date(Number(text)).toISOString().replace('T', ' ').slice(0, 19);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString().replace('T', ' ').slice(0, 19);
}

function xhsCaption(row) {
  const rawTitle = String(row.title ?? '');
  const rawCaption = String(row.caption ?? '');
  if (!rawCaption) return rawTitle;
  if (rawTitle && rawCaption.includes(rawTitle)) return rawCaption;
  return [rawTitle, rawCaption].filter(Boolean).join('\n');
}

const output = { generated_at: new Date().toISOString(), accounts: {} };
const failures = [];
for (const item of accounts) {
  const slug = item.platform === 'instagram' ? item.account : Buffer.from(item.account, 'utf8').toString('hex');
  const captureNames = item.platform === 'instagram'
    ? [`${item.platform}_${slug}.json`]
    : [`${slug}.json`, `${item.platform}_${slug}.json`];
  const rows = await readJsonFirst(captureDir, captureNames, []);
  const transcripts = await readJson(path.join(transcriptDir, `${item.platform}_${slug}.json`), {});
  output.accounts[item.account] = rows.map((row) => {
    const key = item.platform === 'instagram' ? shortcode(row.url) || String(row.media_id ?? '') : String(row.media_id ?? '');
    const transcript = transcripts[key] ?? {};
    const isVideo = item.platform === 'instagram' || row.is_video === true || row.is_video === 'true' || String(row.type ?? '') === 'video';
    let script = String(transcript.script ?? transcript.transcript ?? '').trim();
    if (!script && transcript.status === 'no_speech') script = '【无可识别语音】';
    if (!script && isVideo) failures.push({ account: item.account, media_id: key, status: transcript.status ?? 'missing', error: transcript.error ?? '' });
    if (item.platform === 'xiaohongshu') {
      return {
        account: item.account,
        platform: item.platform,
        media_id: row.media_id,
        published_at: formatXhsTime(row.published_at) || xhsDate(row.media_id),
        caption: xhsCaption(row),
        script,
        likes: numberOrNull(row.likes),
        comments: numberOrNull(row.comments),
        shares: numberOrNull(row.shares),
        duration_seconds: duration(row.duration_seconds) ?? duration(transcript.duration_seconds),
        url: String(row.page_url || row.url || ''),
      };
    }
    return {
      account: item.account,
      platform: item.platform,
      media_id: row.media_id,
      published_at: row.published_at,
      caption: String(row.caption ?? ''),
      script,
      likes: numberOrNull(row.likes),
      comments: numberOrNull(row.comments),
      views: numberOrNull(row.view_count) ?? numberOrNull(row.play_count),
      duration_seconds: duration(row.duration_seconds) ?? duration(transcript.duration_seconds),
      url: String(row.url ?? ''),
    };
  });
}

if (failures.length && process.env.ALLOW_MISSING_TRANSCRIPT !== '1') {
  const failurePath = `${outputPath}.transcript-failures.json`;
  await fs.writeFile(failurePath, JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} new videos are missing Script/Transcript. See ${failurePath}`);
}
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
process.stdout.write(`${JSON.stringify({ outputPath, rows: Object.fromEntries(Object.entries(output.accounts).map(([account, rows]) => [account, rows.length])), transcriptFailures: failures.length }, null, 2)}\n`);
