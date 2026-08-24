import { cli, Strategy } from '@jackwener/opencli/registry';

cli({
  site: 'xiaohongshu',
  name: 'user-card-diagnostic',
  access: 'read',
  description: 'Inspect public profile note-card fields without returning credentials',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'id', required: true, positional: true, help: 'Xiaohongshu user id' }],
  columns: ['note_id', 'card_keys', 'video_keys', 'media_keys', 'stream_keys', 'interact_keys'],
  func: async (page, kwargs) => {
    const userId = String(kwargs.id ?? '').trim();
    await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);
    await page.wait({ time: 2 });
    return page.evaluate(`(() => {
      const unwrap = (value) => value && typeof value === 'object' && '_value' in value ? value._value : value;
      const groups = unwrap(unwrap(window.__INITIAL_STATE__?.user)?.notes) || [];
      const rows = groups.flatMap((group) => Array.isArray(group) ? group : [group]);
      const entry = rows.find((row) => (row?.noteCard || row?.note_card || row)?.type === 'video') || rows[0] || {};
      const card = entry.noteCard || entry.note_card || entry;
      const video = card.video || {};
      const media = video.media || {};
      return [{
        note_id: card.noteId || card.note_id || '',
        card_keys: Object.keys(card).sort().join(','),
        video_keys: Object.keys(video).sort().join(','),
        media_keys: Object.keys(media).sort().join(','),
        stream_keys: Object.keys(media.stream || {}).sort().join(','),
        interact_keys: Object.keys(card.interactInfo || card.interact_info || {}).sort().join(','),
      }];
    })()`);
  },
});
