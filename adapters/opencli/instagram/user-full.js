import { cli } from '@jackwener/opencli/registry';

cli({
  site: 'instagram',
  name: 'user-full',
  access: 'read',
  description: 'Read a paginated Instagram user feed with full video metrics',
  domain: 'www.instagram.com',
  args: [
    { name: 'username', required: true, positional: true, help: 'Instagram username' },
    { name: 'limit', type: 'int', default: 1000, help: 'Maximum number of video posts' },
  ],
  columns: [
    'media_id', 'published_at', 'caption', 'likes', 'comments', 'shares',
    'play_count', 'view_count', 'duration_seconds', 'type', 'url', 'subtitle_url',
  ],
  pipeline: [
    { navigate: 'https://www.instagram.com' },
    { evaluate: `(async () => {
  const username = \${{ args.username | json }};
  const limit = Math.max(1, Number(\${{ args.limit }} || 1000));
  const headers = { 'X-IG-App-ID': '936619743392459' };
  const opts = { credentials: 'include', headers };

  const profileResponse = await fetch(
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
    opts
  );
  if (!profileResponse.ok) throw new Error('Profile HTTP ' + profileResponse.status);
  const profile = await profileResponse.json();
  const userId = profile?.data?.user?.id;
  if (!userId) throw new Error('User not found: ' + username);

  const rawItems = [];
  const seen = new Set();
  let maxId = '';
  let complete = false;
  for (let page = 0; page < 60 && rawItems.length < limit; page += 1) {
    const url = new URL('https://www.instagram.com/api/v1/feed/user/' + userId + '/');
    url.searchParams.set('count', '100');
    if (maxId) url.searchParams.set('max_id', maxId);
    const response = await fetch(url.toString(), opts);
    if (!response.ok) throw new Error('Feed HTTP ' + response.status + ' at page ' + (page + 1));
    const payload = await response.json();
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const item of items) {
      const key = String(item.pk ?? item.id ?? item.code ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rawItems.push(item);
    }
    const next = payload?.next_max_id ?? payload?.next_min_id ?? '';
    if (!payload?.more_available || !next || next === maxId || items.length === 0) {
      complete = true;
      break;
    }
    maxId = String(next);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const firstVideoPart = (item) => Array.isArray(item?.carousel_media)
    ? item.carousel_media.find(part => part?.media_type === 2)
    : null;
  const videos = rawItems.filter(item => item?.media_type === 2 || firstVideoPart(item));
  return videos.slice(0, limit).map((item) => {
    const part = item.media_type === 2 ? item : firstVideoPart(item);
    const code = item.code || part?.code || '';
    const subtitles = item.video_subtitles ?? part?.video_subtitles ?? [];
    return {
      media_id: String(item.pk ?? item.id ?? ''),
      published_at: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : '',
      caption: item.caption?.text ?? '',
      likes: item.like_count ?? null,
      comments: item.comment_count ?? null,
      shares: item.share_count ?? item.reshare_count ?? null,
      play_count: item.play_count ?? part?.play_count ?? null,
      view_count: item.view_count ?? part?.view_count ?? null,
      duration_seconds: item.video_duration ?? part?.video_duration ?? null,
      type: item.product_type ?? (item.media_type === 8 ? 'carousel_video' : 'video'),
      url: code ? 'https://www.instagram.com/p/' + code + '/' : '',
      subtitle_url: Array.isArray(subtitles) ? (subtitles[0]?.subtitle_url ?? subtitles[0]?.url ?? '') : '',
      pagination_complete: complete,
    };
  });
})()` },
  ],
});
