import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [account, userId, outputPath] = process.argv.slice(2);
if (!account || !userId || !outputPath) {
  throw new Error('Usage: node scripts/collect-xhs-browser-checkpoints.mjs <account> <user-id> <output.json>');
}

const maxChunks = Math.max(1, Number(process.env.XHS_MAX_CHUNKS ?? 80));
const scrollsPerChunk = Math.max(1, Number(process.env.XHS_SCROLLS_PER_CHUNK ?? 12));
const delayMs = Math.max(500, Number(process.env.XHS_SCROLL_DELAY_MS ?? 1400));
const stableChunksLimit = Math.max(1, Number(process.env.XHS_STABLE_CHUNKS ?? 4));
const browserWindow = String(process.env.XHS_WINDOW ?? 'foreground');
const session = `xhs_${Buffer.from(account).toString('hex').slice(0, 16)}_${process.pid}`;

const runBrowser = (args, timeout = 180_000) => spawnSync('opencli', ['browser', session, ...args], {
  encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024,
  env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '180' },
});

const clean = (value) => value == null ? '' : String(value).trim();
const seedPath = String(process.env.XHS_SEED_PATH ?? '').trim();
const load = () => {
  for (const candidate of [outputPath, seedPath].filter(Boolean)) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {}
  }
  return [];
};
const save = (rows) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(rows, null, 2));
  fs.renameSync(temp, outputPath);
};

const open = runBrowser(['open', `https://www.xiaohongshu.com/user/profile/${userId}`, '--window', browserWindow]);
if (open.status !== 0) throw new Error(`browser open failed: ${clean(open.stderr || open.stdout)}`);
runBrowser(['wait', 'time', '3'], 60_000);
const ready = runBrowser(['wait', 'selector', `a[href*="/user/profile/${userId}/"]`], 120_000);
if (ready.status !== 0) throw new Error(`profile notes did not become ready: ${clean(ready.stderr || ready.stdout)}`);

const byId = new Map(load().map((row) => [String(row.media_id || ''), row]));
const seedCount = byId.size;
let stableChunks = 0;
let lastSnapshotCount = 0;
for (let chunk = 1; chunk <= maxChunks && stableChunks < stableChunksLimit; chunk += 1) {
  const js = `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
    const stash = window.__codexXhsRows || (window.__codexXhsRows = {});
    const collect = () => {
      const user = unwrap(window.__INITIAL_STATE__?.user) || {};
      const groups = unwrap(user.notes) || [];
      const flat = [];
      for (const group of Array.isArray(groups) ? groups : []) Array.isArray(group) ? flat.push(...group) : group && flat.push(group);
      const dom = [...document.querySelectorAll('a[href*="/user/profile/"]')].map((anchor) => {
        try {
          const url = new URL(anchor.href, location.origin);
          const parts = url.pathname.split('/').filter(Boolean);
          if (parts.length < 4 || parts[0] !== 'user' || parts[1] !== 'profile' || parts[2] !== '${userId}') return null;
          const id = parts[3] || '';
          if (!/^[0-9a-f]{24}$/i.test(id) || id === '${userId}') return null;
          const image = anchor.querySelector('img');
          return { id, title: (anchor.title || image?.alt || anchor.textContent || '').trim(), type: anchor.querySelector('video,[class*="play"],[class*="video"]') ? 'video' : '', cover_url: image?.currentSrc || image?.src || '', url: url.toString() };
        } catch { return null; }
      }).filter(Boolean);
      for (const entry of [...flat, ...dom]) {
        const card = entry?.noteCard ?? entry?.note_card ?? entry;
        const id = String(card?.noteId ?? card?.note_id ?? entry?.id ?? '').trim();
        if (!/^[0-9a-f]{24}$/i.test(id)) continue;
        const previous = stash[id] || {};
        stash[id] = {
          ...previous,
          id,
          title: String(card?.displayTitle ?? card?.display_title ?? card?.title ?? entry?.title ?? previous.title ?? '').trim(),
          type: String(card?.type ?? entry?.type ?? previous.type ?? '').trim(),
          likes: card?.interactInfo?.likedCount ?? card?.interact_info?.liked_count ?? previous.likes ?? null,
          published_at: card?.time ?? card?.publishTime ?? card?.publish_time ?? previous.published_at ?? null,
          cover_url: String(card?.cover?.urlDefault ?? card?.cover?.urlPre ?? card?.cover?.url ?? entry?.cover_url ?? previous.cover_url ?? '').trim(),
          url: String(entry?.url ?? previous.url ?? '').trim(),
          xsec_token: String(entry?.xsecToken ?? entry?.xsec_token ?? card?.xsecToken ?? card?.xsec_token ?? previous.xsec_token ?? '').trim(),
        };
      }
    };
    collect();
    for (let index = 0; index < ${scrollsPerChunk}; index += 1) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await wait(${delayMs});
      window.scrollBy(0, -240);
      await wait(150);
      window.scrollTo(0, document.documentElement.scrollHeight);
      await wait(350);
      collect();
    }
    const user = unwrap(window.__INITIAL_STATE__?.user) || {};
    const bodyText = String(document.body?.innerText || '');
    return {
      path: location.pathname,
      loggedIn: !location.pathname.startsWith('/login'),
      riskText: ['访问频繁', '操作频繁', '验证码', '安全验证'].find((item) => bodyText.includes(item)) || '',
      height: document.documentElement.scrollHeight,
      entries: Object.values(stash),
    };
  })()`;
  const result = runBrowser(['eval', js], Math.max(180_000, scrollsPerChunk * (delayMs + 800)));
  if (result.status !== 0) throw new Error(`chunk ${chunk} failed: ${clean(result.stderr || result.stdout)}`);
  let snapshot;
  try { snapshot = JSON.parse(result.stdout); } catch { throw new Error(`chunk ${chunk} returned invalid JSON`); }
  if (!snapshot?.loggedIn || String(snapshot?.path || '').startsWith('/login')) throw new Error('Xiaohongshu login required');
  if (snapshot?.riskText) throw new Error(`Xiaohongshu risk control: ${snapshot.riskText}`);
  const before = byId.size;
  const snapshotIds = new Set();
  for (const entry of snapshot.entries || []) {
    const card = entry?.noteCard ?? entry?.note_card ?? entry;
    const id = clean(card?.noteId ?? card?.note_id ?? entry?.id);
    if (!/^[0-9a-f]{24}$/i.test(id)) continue;
    snapshotIds.add(id);
    let token = clean(entry?.xsecToken ?? entry?.xsec_token ?? card?.xsecToken ?? card?.xsec_token);
    if (!token && entry?.url) { try { token = new URL(entry.url).searchParams.get('xsec_token') || ''; } catch {} }
    const url = new URL(`https://www.xiaohongshu.com/user/profile/${userId}/${id}`);
    if (token) { url.searchParams.set('xsec_token', token); url.searchParams.set('xsec_source', 'pc_user'); }
    const previous = byId.get(id) || {};
    byId.set(id, {
      ...previous,
      media_id: id,
      published_at: card?.time ?? card?.publishTime ?? card?.publish_time ?? previous.published_at ?? null,
      title: clean(card?.displayTitle ?? card?.display_title ?? card?.title ?? entry?.title) || previous.title || '',
      type: clean(card?.type ?? entry?.type) || previous.type || '',
      likes: card?.interactInfo?.likedCount ?? card?.interact_info?.liked_count ?? previous.likes ?? null,
      url: url.toString(),
      cover_url: clean(card?.cover?.urlDefault ?? card?.cover?.urlPre ?? card?.cover?.url ?? entry?.cover_url) || previous.cover_url || '',
    });
  }
  save([...byId.values()]);
  stableChunks = snapshotIds.size === lastSnapshotCount ? stableChunks + 1 : 0;
  lastSnapshotCount = snapshotIds.size;
  process.stdout.write(`CHECKPOINT ${account} chunk=${chunk} visible=${snapshotIds.size} rows=${byId.size} added=${byId.size - before} height=${snapshot.height} stable=${stableChunks}\n`);
}

runBrowser(['close'], 60_000);
process.stdout.write(`${JSON.stringify({ account, userId, rows: byId.size, outputPath, stableChunks }, null, 2)}\n`);
