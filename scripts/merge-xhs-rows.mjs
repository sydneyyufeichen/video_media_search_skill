import fs from 'node:fs';
import path from 'node:path';

const [basePath, refreshPath, outputPath] = process.argv.slice(2);
if (!basePath || !refreshPath || !outputPath) {
  throw new Error('Usage: node scripts/merge-xhs-rows.mjs <base.json> <refresh.json> <output.json>');
}

const read = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const base = read(basePath);
const refresh = read(refreshPath);
const refreshById = new Map(refresh.map((row) => [String(row.media_id ?? ''), row]));
const seen = new Set();
const merged = base.map((row) => {
  const key = String(row.media_id ?? '');
  seen.add(key);
  const newer = refreshById.get(key) ?? {};
  return {
    ...row,
    ...Object.fromEntries(Object.entries(newer).filter(([, value]) => value !== '' && value != null)),
    detail_status: row.detail_status,
    detail_source: row.detail_source,
    detail_error: row.detail_error,
    media_url: row.media_url,
    media_urls: row.media_urls,
    duration_seconds: row.duration_seconds,
    caption: row.caption,
    comments: row.comments,
    shares: row.shares,
    collects: row.collects,
    is_video: row.is_video ?? (newer.type === 'video'),
  };
});
for (const row of refresh) {
  const key = String(row.media_id ?? '');
  if (!seen.has(key)) merged.push({ ...row, is_video: row.type === 'video' });
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2));
console.log(JSON.stringify({ base: base.length, refresh: refresh.length, merged: merged.length }));
