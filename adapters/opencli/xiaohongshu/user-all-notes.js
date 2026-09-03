import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';

const SNAPSHOT_JS = `
(() => {
  const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
  const safeClone = (value) => { try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return null; } };
  const clean = (value) => value == null ? '' : String(value).trim();
  const user = unwrap(window.__INITIAL_STATE__?.user) || {};
  const pageData = unwrap(user.userPageData) || {};
  const basicInfo = pageData.basicInfo || {};
  const nickname = clean(basicInfo.nickname ?? basicInfo.nickName ?? basicInfo.nick ?? user.nickname ?? user.nickName ?? pageData.nickname);
  const notes = unwrap(user.notes) || [];
  const domNotes = [...document.querySelectorAll('a[href]')].map((anchor) => {
    try {
      const url = new URL(anchor.href, location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      let id = '';
      if (parts[0] === 'user' && parts[1] === 'profile' && parts.length >= 4) id = parts[3] || '';
      else if ((parts[0] === 'explore' || parts[0] === 'search_result') && parts.length >= 2) id = parts[1] || '';
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
  const bodyText = document.body?.innerText || '';
  const risk = /验证码|访问频繁|操作频繁|请求频繁|环境异常|账号异常|请稍后重试|安全验证|security verification/i.test(bodyText);
  return { notes: safeClone(notes), domNotes, nickname, loggedIn: unwrap(user.loggedIn) !== false, path: location.pathname, risk };
})()`;

const SCROLL_ONE_VIEWPORT_JS = `
(() => {
  const root = document.scrollingElement || document.documentElement;
  const step = Math.max(600, Math.floor(window.innerHeight * 0.85));
  const before = root?.scrollTop ?? window.scrollY ?? 0;
  window.scrollBy({ top: step, left: 0, behavior: 'auto' });
  const after = root?.scrollTop ?? window.scrollY ?? 0;
  if (after <= before) {
    const candidates = [...document.querySelectorAll('body *')]
      .filter((el) => el.clientWidth >= 300 && el.clientHeight >= 200 && el.scrollHeight > el.clientHeight + 100)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const aVisible = Math.max(0, Math.min(aRect.bottom, innerHeight) - Math.max(aRect.top, 0));
        const bVisible = Math.max(0, Math.min(bRect.bottom, innerHeight) - Math.max(bRect.top, 0));
        return (bVisible * b.clientWidth) - (aVisible * a.clientWidth);
      });
    if (candidates[0]) {
      const target = candidates[0];
      const targetBefore = target.scrollTop;
      target.scrollBy({ top: step, left: 0, behavior: 'auto' });
      return {
        target: 'container',
        before: targetBefore,
        after: target.scrollTop,
        atBottom: target.scrollTop + target.clientHeight >= target.scrollHeight - 10,
        step,
      };
    }
  }
  return {
    target: 'window',
    before,
    after: root?.scrollTop ?? window.scrollY ?? 0,
    atBottom: (root?.scrollTop ?? window.scrollY ?? 0) + window.innerHeight >= (root?.scrollHeight ?? 0) - 10,
    step,
  };
})()`;

async function scrollOneViewport(page) {
  const viewport = await page.evaluate(`(() => ({ width: window.innerWidth, height: window.innerHeight }))()`);
  const width = Math.max(800, Number(viewport?.width ?? 1440));
  const height = Math.max(600, Number(viewport?.height ?? 900));
  const deltaY = Math.max(600, Math.floor(height * 0.85));
  if (typeof page.cdp === 'function') {
    await page.cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.floor(width * 0.55),
      y: Math.floor(height * 0.65),
      deltaX: 0,
      deltaY,
    });
    return { target: 'native-mouse-wheel', atBottom: false, step: deltaY };
  }
  return page.evaluate(SCROLL_ONE_VIEWPORT_JS);
}

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
      account_nickname: clean(snapshot?.nickname),
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
    { name: 'max-attempts', type: 'int', default: 400, help: 'Maximum profile scroll attempts' },
    { name: 'stable-limit', type: 'int', default: 20, help: 'Stop after this many scrolls add no notes' },
    { name: 'scroll-delay-ms', type: 'int', default: 2000, help: 'Delay after each viewport-sized scroll' },
  ],
  columns: ['media_id', 'published_at', 'title', 'type', 'likes', 'url', 'cover_url'],
  func: async (page, kwargs) => {
    const userId = clean(kwargs.id).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
    const limit = Math.max(1, Number(kwargs.limit ?? 5000));
    const maxAttempts = Math.max(1, Number(kwargs['max-attempts'] ?? 400));
    const stableLimit = Math.max(1, Number(kwargs['stable-limit'] ?? 20));
    const scrollDelayMs = Math.max(1000, Number(kwargs['scroll-delay-ms'] ?? 2000));
    await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);
    await page.wait({ time: 2.5 });
    let snapshot = await page.evaluate(SNAPSHOT_JS);
    if (snapshot?.risk) throw new Error('Xiaohongshu risk control detected; stopped before scrolling');
    const collected = new Map(extractRows(snapshot, userId).map((row) => [row.media_id, row]));
    let stable = 0;
    for (let attempt = 0; attempt < maxAttempts && collected.size < limit && stable < stableLimit; attempt += 1) {
      try {
        await scrollOneViewport(page);
      } catch (error) {
        const message = String(error?.message ?? error);
        if (/Input\.dispatchMouseEvent timed out/i.test(message) && collected.size > 0) break;
        throw error;
      }
      await page.wait({ time: scrollDelayMs / 1000 });
      snapshot = await page.evaluate(SNAPSHOT_JS);
      if (!snapshot?.loggedIn || String(snapshot?.path || '').startsWith('/login')) throw new Error('Xiaohongshu login required');
      if (snapshot?.risk) throw new Error('Xiaohongshu risk control detected; stopped immediately');
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
