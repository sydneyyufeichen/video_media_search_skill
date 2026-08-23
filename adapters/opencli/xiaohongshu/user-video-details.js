import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';

const SNAPSHOT_JS = `
(() => {
  const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
  const safeClone = (value) => { try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return null; } };
  const user = unwrap(window.__INITIAL_STATE__?.user) || {};
  const notes = unwrap(user.notes) || [];
  return { notes: safeClone(notes), loggedIn: unwrap(user.loggedIn) !== false, path: location.pathname };
})()`;

const DETAIL_JS = `
((noteId) => {
  const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
  const clean = (value) => value == null ? '' : String(value).replace(/\\s+/g, ' ').trim();
  const stateNote = unwrap(window.__INITIAL_STATE__?.note) || {};
  const detailMap = unwrap(stateNote.noteDetailMap) || {};
  const entry = unwrap(detailMap[noteId]) || {};
  const note = unwrap(entry.note ?? entry.noteData ?? entry.data ?? entry) || {};
  const interact = note.interactInfo ?? note.interact_info ?? {};
  const video = note.video ?? {};
  const media = video.media ?? {};
  const stream = media.stream ?? {};
  const h264 = Array.isArray(stream.h264) ? stream.h264 : [];
  const h265 = Array.isArray(stream.h265) ? stream.h265 : [];
  const streamItem = h264[0] ?? h265[0] ?? {};
  const domTitle = clean(document.querySelector('#detail-title, .title')?.textContent);
  const domDesc = clean(document.querySelector('#detail-desc, .desc, .note-text')?.textContent);
  const domAuthor = clean(document.querySelector('.username, .author-wrapper .name')?.textContent);
  const main = document.querySelector('.interact-container');
  const domLikes = clean(main?.querySelector('.like-wrapper .count')?.textContent);
  const domCollects = clean(main?.querySelector('.collect-wrapper .count')?.textContent);
  const domComments = clean(main?.querySelector('.chat-wrapper .count')?.textContent);
  const domVideo = document.querySelector('video');
  return {
    title: clean(note.title) || domTitle,
    caption: clean(note.desc ?? note.description) || domDesc,
    author: clean(note.user?.nickname ?? note.user?.nickName) || domAuthor,
    likes: interact.likedCount ?? interact.liked_count ?? domLikes,
    collects: interact.collectedCount ?? interact.collected_count ?? domCollects,
    comments: interact.commentCount ?? interact.comment_count ?? domComments,
    shares: interact.shareCount ?? interact.share_count ?? null,
    published_at: note.time ?? note.publishTime ?? note.publish_time ?? null,
    duration_seconds: video.duration ?? media.duration ?? streamItem.duration ?? (Number.isFinite(domVideo?.duration) ? domVideo.duration : null),
    media_url: streamItem.masterUrl ?? streamItem.master_url ?? streamItem.url ?? domVideo?.currentSrc ?? domVideo?.src ?? '',
    page_url: location.href,
  };
})`;

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
  const seen = new Set();
  const rows = [];
  for (const entry of flatten(snapshot?.notes)) {
    const card = entry?.noteCard ?? entry?.note_card ?? entry;
    const id = clean(card?.noteId ?? card?.note_id ?? entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const type = clean(card?.type);
    const token = clean(entry?.xsecToken ?? entry?.xsec_token ?? card?.xsecToken ?? card?.xsec_token);
    const url = new URL(`https://www.xiaohongshu.com/user/profile/${userId}/${id}`);
    if (token) {
      url.searchParams.set('xsec_token', token);
      url.searchParams.set('xsec_source', 'pc_user');
    }
    rows.push({
      media_id: id,
      title: clean(card?.displayTitle ?? card?.display_title ?? card?.title),
      type,
      likes: card?.interactInfo?.likedCount ?? card?.interact_info?.liked_count ?? null,
      cover_url: clean(card?.cover?.urlDefault ?? card?.cover?.urlPre ?? card?.cover?.url),
      url: url.toString(),
    });
  }
  return rows;
}

cli({
  site: 'xiaohongshu',
  name: 'user-video-details',
  access: 'read',
  description: 'Scroll a Xiaohongshu user profile and read each public video note detail',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'id', required: true, positional: true, help: 'Xiaohongshu user id' },
    { name: 'limit', type: 'int', default: 1000, help: 'Maximum video notes' },
  ],
  columns: [
    'media_id', 'published_at', 'title', 'caption', 'likes', 'comments', 'collects',
    'shares', 'duration_seconds', 'url', 'cover_url', 'media_url', 'detail_status',
  ],
  func: async (page, kwargs) => {
    const userId = clean(kwargs.id).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
    const limit = Math.max(1, Number(kwargs.limit ?? 1000));
    await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);
    await page.wait({ time: 2.5 });
    let snapshot = await page.evaluate(SNAPSHOT_JS);
    let rows = extractRows(snapshot, userId);
    let stable = 0;
    for (let attempt = 0; attempt < 50 && rows.length < limit && stable < 4; attempt += 1) {
      await page.autoScroll({ times: 1, delayMs: 1700 });
      await page.wait({ time: 1 });
      snapshot = await page.evaluate(SNAPSHOT_JS);
      if (!snapshot?.loggedIn || String(snapshot?.path || '').startsWith('/login')) throw new Error('Xiaohongshu login required');
      const nextRows = extractRows(snapshot, userId);
      if (nextRows.length <= rows.length) stable += 1;
      else { rows = nextRows; stable = 0; }
    }
    rows = rows.filter(row => row.type === 'video').slice(0, limit);
    if (!rows.length) throw new EmptyResultError('xiaohongshu user-video-details', 'No public video notes found');

    const output = [];
    for (const row of rows) {
      try {
        await page.goto(row.url);
        await page.wait({ time: 2.5 });
        const detail = await page.evaluate(`${DETAIL_JS}(${JSON.stringify(row.media_id)})`);
        output.push({ ...row, ...detail, likes: detail?.likes || row.likes, detail_status: 'complete' });
      } catch (error) {
        output.push({ ...row, caption: '', comments: null, collects: null, shares: null, duration_seconds: null, media_url: '', detail_status: `failed: ${error?.message ?? error}` });
      }
    }
    return output;
  },
});
