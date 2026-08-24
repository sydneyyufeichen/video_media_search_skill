import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';

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
  const variants = Object.values(stream).flatMap((value) => Array.isArray(value) ? value : []);
  const streamItem = variants[0] ?? {};
  const urls = [...(streamItem.backupUrls ?? []), streamItem.masterUrl, streamItem.master_url, streamItem.url]
    .filter((url) => typeof url === 'string' && url.startsWith('http'));
  const domVideo = document.querySelector('video');
  const main = document.querySelector('.interact-container');
  const domTitle = clean(document.querySelector('#detail-title, .title')?.textContent);
  const domDesc = clean(document.querySelector('#detail-desc, .desc, .note-text')?.textContent);
  return {
    title: clean(note.title) || domTitle,
    caption: clean(note.desc ?? note.description) || domDesc,
    author: clean(note.user?.nickname ?? note.user?.nickName),
    likes: interact.likedCount ?? interact.liked_count ?? clean(main?.querySelector('.like-wrapper .count')?.textContent),
    collects: interact.collectedCount ?? interact.collected_count ?? clean(main?.querySelector('.collect-wrapper .count')?.textContent),
    comments: interact.commentCount ?? interact.comment_count ?? clean(main?.querySelector('.chat-wrapper .count')?.textContent),
    shares: interact.shareCount ?? interact.share_count ?? null,
    published_at: note.time ?? note.publishTime ?? note.publish_time ?? null,
    duration_seconds: video.duration ?? media.duration ?? streamItem.duration ?? (Number.isFinite(domVideo?.duration) ? domVideo.duration : null),
    media_url: urls[0] ?? domVideo?.currentSrc ?? domVideo?.src ?? '',
    media_urls: urls,
    note_type: clean(note.type ?? note.noteType ?? note.note_type),
    page_url: location.href,
    state_found: Boolean(Object.keys(note).length),
    page_title: document.title,
  };
})`;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

cli({
  site: 'xiaohongshu',
  name: 'note-details-nav-batch',
  access: 'read',
  description: 'Read Xiaohongshu note details by navigating signed URLs in an authenticated browser',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'items', required: true, positional: true, help: 'JSON array of manifest rows' }],
  columns: [
    'media_id', 'published_at', 'title', 'caption', 'likes', 'comments', 'collects',
    'shares', 'duration_seconds', 'url', 'cover_url', 'media_url', 'is_video', 'detail_status',
  ],
  func: async (page, kwargs) => {
    let items;
    try { items = JSON.parse(String(kwargs.items ?? '[]')); } catch { items = []; }
    if (!Array.isArray(items) || !items.length) {
      throw new EmptyResultError('xiaohongshu note-details-nav-batch', 'No input rows');
    }
    const results = [];
    for (const item of items.slice(0, 25)) {
      const mediaId = clean(item.media_id);
      try {
        const url = new URL(clean(item.url), 'https://www.xiaohongshu.com');
        url.pathname = `/explore/${mediaId}`;
        await page.goto(url.toString());
        await page.wait({ time: 1 });
        const detail = await page.evaluate(`${DETAIL_JS}(${JSON.stringify(mediaId)})`);
        const blockText = [detail?.page_title, detail?.title, detail?.caption].map(clean).join(' ');
        if (/安全限制|访问受限|登录|security|验证/i.test(blockText)) {
          throw new Error(`blocked page: ${blockText.slice(0, 120)}`);
        }
        const isVideo = item.type === 'video' || detail?.note_type === 'video' || Boolean(detail?.media_url);
        if (!detail?.state_found && !detail?.media_url && !detail?.caption) {
          throw new Error('note detail missing after browser navigation');
        }
        results.push({
          ...item,
          ...detail,
          media_id: mediaId,
          title: detail?.title || item.title || '',
          likes: detail?.likes ?? item.likes ?? null,
          url: url.toString(),
          is_video: isVideo,
          detail_status: 'complete',
          detail_source: 'authenticated_browser_navigation',
        });
      } catch (error) {
        results.push({
          ...item, media_id: mediaId, is_video: item.type === 'video',
          detail_status: `failed: ${String(error?.message || error)}`,
          detail_source: 'authenticated_browser_navigation',
        });
      }
    }
    return results;
  },
});
