import { cli } from '@jackwener/opencli/registry';

cli({
  site: 'instagram',
  name: 'profile-diagnostic',
  access: 'read',
  description: 'Diagnose Instagram username/profile/feed endpoint differences without exposing cookies',
  domain: 'www.instagram.com',
  args: [
    { name: 'username', required: true, positional: true, help: 'Instagram username' },
  ],
  columns: ['endpoint', 'status', 'ok', 'account_id', 'result', 'body_excerpt'],
  pipeline: [
    { navigate: 'https://www.instagram.com' },
    { evaluate: `(async () => {
  const username = \${{ args.username | json }};
  const headers = { 'X-IG-App-ID': '936619743392459' };
  const options = { credentials: 'include', headers };
  const rows = [];

  async function request(endpoint, url) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      rows.push({
        endpoint,
        status: response.status,
        ok: response.ok,
        result: json?.status ?? json?.message ?? '',
        body_excerpt: text.replace(/\\s+/g, ' ').slice(0, 800),
      });
      return { response, text, json };
    } catch (error) {
      rows.push({ endpoint, status: 0, ok: false, result: String(error), body_excerpt: '' });
      return { response: null, text: '', json: null };
    }
  }

  const search = await request(
    'topsearch',
    'https://www.instagram.com/web/search/topsearch/?query=' + encodeURIComponent(username) + '&context=user'
  );
  const exact = (search.json?.users ?? []).map(item => item?.user).find(user => user?.username === username);
  const accountId = String(exact?.pk ?? exact?.id ?? '');
  if (rows.length) rows[rows.length - 1].account_id = accountId;

  await request(
    'web_profile_info',
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username)
  );
  if (accountId) {
    const info = await request('user_info_by_id', 'https://www.instagram.com/api/v1/users/' + accountId + '/info/');
    if (rows.length) rows[rows.length - 1].account_id = accountId;
    const feed = await request('feed_by_id', 'https://www.instagram.com/api/v1/feed/user/' + accountId + '/?count=12');
    if (rows.length) rows[rows.length - 1].account_id = accountId;
    if (feed.json?.items) rows[rows.length - 1].result = 'items=' + feed.json.items.length + '; more_available=' + Boolean(feed.json.more_available);
    if (info.json?.user) rows[rows.length - 2].result = 'username=' + (info.json.user.username ?? '') + '; private=' + Boolean(info.json.user.is_private);
  }
  return rows;
})()` },
  ],
});
