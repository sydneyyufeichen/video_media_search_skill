import { cli, Strategy } from '@jackwener/opencli/registry';

cli({
  site: 'xiaohongshu',
  name: 'note-fetch-diagnostic',
  access: 'read',
  description: 'Check whether note detail state is available through authenticated HTML fetch',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'url', required: true, positional: true, help: 'Full note URL' }],
  columns: ['status', 'length', 'has_initial_state', 'has_note_detail', 'snippet'],
  func: async (page, kwargs) => {
    await page.goto('https://www.xiaohongshu.com/');
    await page.wait({ time: 1 });
    return page.evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(String(kwargs.url))}, { credentials: 'include' });
      const html = await response.text();
      const marker = html.indexOf('__INITIAL_STATE__');
      const jsonStart = html.indexOf('=', marker) + 1;
      const jsonEnd = html.indexOf('</script>', jsonStart);
      let parsed = null;
      const source = html.slice(jsonStart, jsonEnd).trim();
      const normalizeUndefined = (text) => {
        let output = '';
        let inString = false;
        let escaped = false;
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
      let parseError = '';
      try { parsed = JSON.parse(normalizeUndefined(source)); } catch (error) { parseError = String(error?.message || error); }
      const noteMap = parsed?.note?.noteDetailMap || {};
      const noteId = new URL(${JSON.stringify(String(kwargs.url))}).pathname.split('/').filter(Boolean).pop();
      const note = noteMap?.[noteId]?.note || noteMap?.[noteId] || {};
      return [{
        status: response.status,
        length: html.length,
        has_initial_state: marker >= 0,
        has_note_detail: html.includes('noteDetailMap'),
        snippet: JSON.stringify({
          parsed: Boolean(parsed), parseError, noteId,
          noteKeys: Object.keys(note).slice(0, 20),
          videoKeys: Object.keys(note.video || {}),
          mediaKeys: Object.keys(note.video?.media || {}),
          streamKeys: Object.keys(note.video?.media?.stream || {}),
          streamItemKeys: Object.keys(Object.values(note.video?.media?.stream || {}).flatMap((value) => Array.isArray(value) ? value : [])[0] || {}),
          mediaVideoKeys: Object.keys(note.video?.media?.video || {}),
          mediaV2Keys: Object.keys(note.video?.mediaV2 || {}),
          consumer: note.video?.consumer || null,
        }),
      }];
    })()`);
  },
});
