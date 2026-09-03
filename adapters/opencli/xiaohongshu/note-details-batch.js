import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';

const DETAIL_JS = `
((noteId) => {
  const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
  const clean = (value) => value == null ? '' : String(value).replace(/\\s+/g, ' ').trim();
  const cleanMultiline = (value) => value == null ? '' : String(value).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim();
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
  const domVideo = document.querySelector('video');
  const resourceMedia = performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => /sns-video|\\.mp4(?:\\?|$)|\\.m3u8(?:\\?|$)/i.test(url))
    .pop() || '';
  const domTitle = clean(document.querySelector('#detail-title, .title')?.textContent);
  const domDesc = clean(document.querySelector('#detail-desc, .desc, .note-text')?.textContent);
  const main = document.querySelector('.interact-container');
  return {
    title: clean(note.title) || domTitle,
    caption: cleanMultiline(note.desc ?? note.description) || domDesc,
    author: clean(note.user?.nickname ?? note.user?.nickName),
    likes: interact.likedCount ?? interact.liked_count ?? clean(main?.querySelector('.like-wrapper .count')?.textContent),
    collects: interact.collectedCount ?? interact.collected_count ?? clean(main?.querySelector('.collect-wrapper .count')?.textContent),
    comments: interact.commentCount ?? interact.comment_count ?? clean(main?.querySelector('.chat-wrapper .count')?.textContent),
    shares: interact.shareCount ?? interact.share_count ?? null,
    published_at: note.time ?? note.publishTime ?? note.publish_time ?? null,
    duration_seconds: video.duration ?? media.duration ?? streamItem.duration ?? (Number.isFinite(domVideo?.duration) ? domVideo.duration : null),
    media_url: streamItem.masterUrl ?? streamItem.master_url ?? streamItem.url ?? resourceMedia ?? domVideo?.currentSrc ?? domVideo?.src ?? '',
    note_type: clean(note.type ?? note.noteType ?? note.note_type),
    page_url: location.href,
  };
})`;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

cli({
  site: 'xiaohongshu',
  name: 'note-details-batch',
  access: 'read',
  description: 'Read a resumable batch of Xiaohongshu note details and video source URLs',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'items', required: true, positional: true, help: 'JSON array of manifest rows with media_id and url' },
  ],
  columns: [
    'media_id', 'published_at', 'title', 'caption', 'likes', 'comments', 'collects',
    'shares', 'duration_seconds', 'url', 'cover_url', 'media_url', 'is_video', 'detail_status',
  ],
  func: async (page, kwargs) => {
    let items;
    try { items = JSON.parse(String(kwargs.items ?? '[]')); } catch { items = []; }
    if (!Array.isArray(items) || !items.length) throw new EmptyResultError('xiaohongshu note-details-batch', 'No input rows');
    await page.goto('https://www.xiaohongshu.com/');
    await page.wait({ time: 1 });
    return page.evaluate(`(async () => {
      const items = ${JSON.stringify(items.slice(0, 40))};
      const delayMs = 2000;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clean = (value) => value == null ? '' : String(value).replace(/\\s+/g, ' ').trim();
      const cleanMultiline = (value) => value == null ? '' : String(value).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim();
      const normalizeState = (text) => {
        let output = '', inString = false, escaped = false;
        for (let index = 0; index < text.length; index += 1) {
          const char = text[index];
          if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
          }
          if (char === '"') { inString = true; output += char; continue; }
          if (text.startsWith('new Map([])', index)) { output += '{}'; index += 10; continue; }
          if (text.startsWith('new Set([])', index)) { output += '[]'; index += 10; continue; }
          if (text.startsWith('undefined', index)) { output += 'null'; index += 8; continue; }
          output += char;
        }
        return output;
      };
      const readOne = async (item) => {
        const mediaId = clean(item.media_id);
        try {
          const requestUrl = new URL(clean(item.url), location.origin);
          requestUrl.pathname = '/explore/' + mediaId;
          const response = await fetch(requestUrl.toString(), { credentials: 'include' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const html = await response.text();
          const riskText = ['访问频繁', '操作频繁', '验证码', '安全验证']
            .find((marker) => html.includes(marker));
          if (riskText) throw new Error('risk control: ' + riskText);
          const marker = html.indexOf('__INITIAL_STATE__');
          const start = html.indexOf('=', marker) + 1;
          const end = html.indexOf('</script>', start);
          if (marker < 0 || start <= 0 || end <= start) throw new Error('initial state missing');
          const state = JSON.parse(normalizeState(html.slice(start, end).trim()));
          const entry = state?.note?.noteDetailMap?.[mediaId] || {};
          const note = entry.note || entry.noteData || entry.data || entry;
          if (!note || !Object.keys(note).length) throw new Error('note detail missing');
          const interact = note.interactInfo || note.interact_info || {};
          const video = note.video || {};
          const media = video.media || {};
          const stream = media.stream || {};
          const h264 = Array.isArray(stream.h264) ? stream.h264 : [];
          const h265 = Array.isArray(stream.h265) ? stream.h265 : [];
          const streamVariants = Object.values(stream).flatMap((value) => Array.isArray(value) ? value : []);
          const streamItem = h264[0] || h265[0] || streamVariants[0] || {};
          const mediaUrl = streamItem.masterUrl || streamItem.master_url || streamItem.url || '';
          const noteType = clean(note.type || note.noteType || note.note_type);
          return {
            ...item,
            media_id: mediaId,
            title: clean(note.title) || clean(item.title),
            caption: cleanMultiline(note.desc || note.description),
            author: clean(note.user?.nickname || note.user?.nickName),
            likes: interact.likedCount ?? interact.liked_count ?? item.likes ?? null,
            collects: interact.collectedCount ?? interact.collected_count ?? null,
            comments: interact.commentCount ?? interact.comment_count ?? null,
            shares: interact.shareCount ?? interact.share_count ?? null,
            published_at: note.time ?? note.publishTime ?? note.publish_time ?? null,
            duration_seconds: video.duration ?? media.duration ?? streamItem.duration ?? null,
            media_url: mediaUrl,
            note_type: noteType,
            page_url: clean(item.url),
            url: clean(item.url),
            is_video: item.type === 'video' || noteType === 'video' || Boolean(mediaUrl),
            detail_status: 'complete',
          };
        } catch (error) {
          return { ...item, media_id: mediaId, is_video: item.type === 'video', detail_status: 'failed: ' + String(error?.message || error) };
        }
      };
      const results = new Array(items.length);
      for (let index = 0; index < items.length; index += 1) {
        results[index] = await readOne(items[index]);
        if (index + 1 < items.length) await wait(delayMs);
      }
      return results;
    })()`);
  },
});
