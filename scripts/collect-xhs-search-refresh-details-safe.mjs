import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [account, userId, manifestPath, outputPath] = process.argv.slice(2);
if (!account || !userId || !manifestPath || !outputPath) {
  throw new Error('Usage: node collect-xhs-search-refresh-details-safe.mjs <account> <user-id> <manifest.json> <details.json>');
}

const delayMs = Math.max(2_000, Number(process.env.XHS_REQUEST_DELAY_MS ?? 2_000));
const searchLimit = Math.max(1, Math.min(50, Number(process.env.XHS_SEARCH_LIMIT ?? 20)));
const maxConsecutiveMisses = Math.max(1, Number(process.env.XHS_MAX_CONSECUTIVE_MISSES ?? 3));
const itemLimit = Math.max(0, Number(process.env.XHS_DETAIL_LIMIT ?? 0));
const siteSession = String(process.env.XHS_SITE_SESSION ?? 'persistent');
const riskPattern = /(?:验证码|访问频繁|操作频繁|安全验证|安全限制|risk\s*control|captcha|\b401\b|\b403\b|\b429\b)/i;

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const saveJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const mediaId = (row) => {
  const direct = String(row?.media_id ?? row?.id ?? '');
  if (/^[0-9a-f]{24}$/i.test(direct)) return direct;
  return String(row?.url ?? row?.page_url ?? '').match(/(?:search_result|explore|\/profile\/[0-9a-f]{24})\/([0-9a-f]{24})/i)?.[1] ?? '';
};
const isVideo = (row) => String(row?.type ?? row?.note_type ?? '') !== 'normal';
const isComplete = (row) => row?.detail_status === 'complete' && Boolean(row?.media_url);
const hasFreshSignedUrl = (row) => {
  const url = String(row?.url ?? row?.page_url ?? '');
  return url.includes('xsec_token=') && mediaId(row);
};
const shortenTitle = (title) => {
  const cleaned = String(title ?? '')
    .replace(/#[^#\s]+(?:\[话题\])?#?/g, ' ')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...cleaned].slice(0, 18).join('').trim();
};

let lastRequestAt = 0;
const runOpenCli = async (args, timeout = 180_000) => {
  const remaining = delayMs - (Date.now() - lastRequestAt);
  if (remaining > 0) await wait(remaining);
  const run = spawnSync('opencli', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: String(Math.ceil(timeout / 1_000)) },
  });
  lastRequestAt = Date.now();
  const combined = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (riskPattern.test(combined)) throw new Error(`RISK_STOP ${(combined.trim().slice(-500))}`);
  if (run.status !== 0) throw new Error(`OPENCLI_FAILED status=${run.status} ${(combined.trim().slice(-500))}`);
  try {
    const parsed = JSON.parse(run.stdout || '[]');
    if (!Array.isArray(parsed)) throw new Error('response is not an array');
    return parsed;
  } catch (error) {
    throw new Error(`OPENCLI_INVALID_JSON ${error.message}: ${String(run.stdout ?? '').trim().slice(-500)}`);
  }
};

const manifest = readJson(manifestPath, []);
const existingRows = readJson(outputPath, []);
if (!Array.isArray(manifest) || !Array.isArray(existingRows)) throw new Error('Manifest and details files must contain JSON arrays');

const videos = manifest.filter(isVideo);
const sourceById = new Map(videos.map((row) => [mediaId(row), row]).filter(([id]) => id));
const existing = new Map(existingRows.map((row) => [mediaId(row), row]).filter(([id]) => id));
const unseen = videos.filter((row) => !existing.has(mediaId(row)));
const retry = videos.filter((row) => existing.has(mediaId(row)) && !isComplete(existing.get(mediaId(row))));
let pending = [...unseen, ...retry];
if (itemLimit) pending = pending.slice(0, itemLimit);

const completeCount = () => videos.filter((row) => isComplete(existing.get(mediaId(row)))).length;
process.stdout.write(`START_SEARCH_DETAILS account=${account} candidates=${videos.length} complete=${completeCount()} pending=${pending.length} unseen=${unseen.length} retry=${retry.length}\n`);

let consecutiveMisses = 0;
for (let offset = 0; offset < pending.length; offset += 1) {
  const source = pending[offset];
  const id = mediaId(source);
  const title = String(source.title ?? source.caption ?? '').trim();
  const shortTitle = shortenTitle(title);
  const queries = [...new Set([
    `${account} ${title}`.trim(),
    `${account} ${shortTitle}`.trim(),
  ].filter(Boolean))].slice(0, 2);

  let hit;
  for (const query of queries) {
    const results = await runOpenCli([
      'xiaohongshu', 'search', query, '--limit', String(searchLimit), '-f', 'json',
    ]);
    hit = results.find((row) => mediaId(row) === id && hasFreshSignedUrl(row));
    if (hit) break;
  }

  if (!hit) {
    const previous = existing.get(id) ?? {};
    existing.set(id, {
      ...source,
      ...previous,
      media_id: id,
      detail_status: 'failed: fresh signed link not found',
      detail_source: 'exact_title_search',
    });
    saveJson(outputPath, [...existing.values()]);
    consecutiveMisses += 1;
    process.stdout.write(`CHECKPOINT offset=${offset} id=${id} status=fresh_link_not_found complete=${completeCount()} misses=${consecutiveMisses}\n`);
    if (consecutiveMisses >= maxConsecutiveMisses) {
      throw new Error(`STOP_CONSECUTIVE_FAILURES count=${consecutiveMisses}`);
    }
    continue;
  }

  const fresh = {
    ...source,
    media_id: id,
    title: hit.title || title,
    type: 'video',
    likes: hit.likes ?? source.likes,
    published_at: hit.published_at ?? source.published_at,
    url: hit.url,
  };
  const results = await runOpenCli([
    'xiaohongshu', 'note-details-nav-batch', JSON.stringify([fresh]),
    '-f', 'json', '--window', 'foreground', '--site-session', siteSession, '--keep-tab', 'false',
  ], 240_000);
  const detail = results.find((row) => mediaId(row) === id);
  if (!detail) throw new Error(`DETAIL_EMPTY id=${id}`);
  if (riskPattern.test(String(detail.detail_status ?? ''))) throw new Error(`RISK_STOP id=${id} status=${detail.detail_status}`);

  const merged = {
    ...sourceById.get(id),
    ...existing.get(id),
    ...detail,
    media_id: id,
    detail_source: 'fresh_exact_title_search',
  };
  existing.set(id, merged);
  saveJson(outputPath, [...existing.values()]);
  if (isComplete(merged)) consecutiveMisses = 0;
  else consecutiveMisses += 1;
  process.stdout.write(`CHECKPOINT offset=${offset} id=${id} status=${merged.detail_status ?? 'unknown'} complete=${completeCount()} misses=${consecutiveMisses}\n`);
  if (consecutiveMisses >= maxConsecutiveMisses) {
    throw new Error(`STOP_CONSECUTIVE_FAILURES count=${consecutiveMisses}`);
  }
}

process.stdout.write(`DONE_SEARCH_DETAILS account=${account} complete=${completeCount()} candidates=${videos.length}\n`);
