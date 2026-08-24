import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';

const SNAPSHOT_JS = `
(() => {
  const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
  const safeClone = (value) => { try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return null; } };
  const user = unwrap(window.__INITIAL_STATE__?.user) || {};
  const notes = unwrap(user.notes) || [];
  const domNotes = [...document.querySelectorAll('a[href*="/user/profile/"]')].map((anchor) => {
    try {
      const url = new URL(anchor.href, location.origin);
      const id = url.pathname.split('/').filter(Boolean).pop() || '';
      if (!/^[0-9a-f]{24}$/i.test(id)) return null;
      const image = anchor.querySelector('img');
      return {
        id,
        title: (anchor.getAttribute('title') || image?.getAttribute('alt') || anchor.textContent || '').trim(),
        type: anchor.querySelector('video, [class*="play"], [class*="video"]') ? 'video' : '',
        cover_url: image?.currentSrc || image?.src || '',
        url: url.toString(),
      };
    } catch { return null; }
  }).filter(Boolean);
  return { notes: safeClone(notes), domNotes, loggedIn: unwrap(user.loggedIn) !== false, path: location.pathname };
})()`;

function flatten(groups) {
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (Array.isArray(group)) out.push(...group);
    else if (group) out.push(group);
  }
  return out;
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function extractRows(snapshot, userId) {
  const rows = [];
  const seen = new Set();
  for (const entry of [...flatten(snapshot?.notes), ...(snapshot?.domNotes ?? [])]) {
    const card = entry?.noteCard ?? entry?.note_card ?? entry;
    const id = clean(card?.noteId ?? card?.note_id ?? entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let token = clean(entry?.xsecToken ?? entry?.xsec_token ?? card?.xsecToken ?? card?.xsec_token);
    if (!token && entry?.url) {
      try { token = new URL(entry.url).searchParams.get('xsec_token') ?? ''; } catch { token = ''; }
    }
    const url = new URL(`https://www.xiaohongshu.com/user/profile/${userId}/${id}`);
    if (token) {
      url.searchParams.set('xsec_token', token);
      url.searchParams.set('xsec_source', 'pc_user');
    }
    rows.push({
      media_id: id,
      title: clean(card?.displayTitle ?? card?.display_title ?? card?.title ?? entry?.title),
      type: clean(card?.type ?? entry?.type),
      likes: card?.interactInfo?.likedCount ?? card?.interact_info?.liked_count ?? null,
      published_at: card?.time ?? card?.publishTime ?? card?.publish_time ?? null,
      cover_url: clean(card?.cover?.urlDefault ?? card?.cover?.urlPre ?? card?.cover?.url ?? entry?.cover_url),
      url: url.toString(),
    });
  }
  return rows;
}

cli({
  site: 'xiaohongshu',
  name: 'user-all-notes',
  access: 'read',
  description: 'Scroll a Xiaohongshu profile and return a deduplicated all-notes manifest',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'id', required: true, positional: true, help: 'Xiaohongshu user id' },
    { name: 'limit', type: 'int', default: 5000, help: 'Maximum notes' },
  ],
  columns: ['media_id', 'published_at', 'title', 'type', 'likes', 'url', 'cover_url'],
  func: async (page, kwargs) => {
    const userId = clean(kwargs.id).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
    const limit = Math.max(1, Number(kwargs.limit ?? 5000));
    await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);
    await page.wait({ time: 2.5 });
    let snapshot = await page.evaluate(SNAPSHOT_JS);
    const collected = new Map(extractRows(snapshot, userId).map((row) => [row.media_id, row]));
    let stable = 0;
    for (let attempt = 0; attempt < 400 && collected.size < limit && stable < 20; attempt += 1) {
      await page.autoScroll({ times: 1, delayMs: 1200 });
      await page.wait({ time: 0.8 });
      snapshot = await page.evaluate(SNAPSHOT_JS);
      if (!snapshot?.loggedIn || String(snapshot?.path || '').startsWith('/login')) throw new Error('Xiaohongshu login required');
      const before = collected.size;
      for (const row of extractRows(snapshot, userId)) {
        const previous = collected.get(row.media_id) ?? {};
        collected.set(row.media_id, { ...previous, ...row });
      }
      stable = collected.size === before ? stable + 1 : 0;
    }
    const rows = [...collected.values()].slice(0, limit);
    if (!rows.length) throw new EmptyResultError('xiaohongshu user-all-notes', 'No public notes found');
    return rows;
  },
});
