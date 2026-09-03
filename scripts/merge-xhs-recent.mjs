import fs from 'node:fs';

const [manifestPath, recentPath] = process.argv.slice(2);
if (!manifestPath || !recentPath) {
  throw new Error('Usage: node merge-xhs-recent.mjs <manifest.json> <recent.json>');
}

const readArray = (file) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${file} must contain a JSON array`);
  return value;
};

const existing = readArray(manifestPath);
const recent = readArray(recentPath);
const byId = new Map(existing.map((row) => [String(row.media_id ?? row.id ?? ''), row]));
for (const row of recent) {
  const mediaId = String(row.media_id ?? row.id ?? '');
  if (!/^[0-9a-f]{24}$/i.test(mediaId)) continue;
  const previous = byId.get(mediaId) ?? {};
  byId.set(mediaId, {
    ...previous,
    ...row,
    media_id: mediaId,
    cover_url: row.cover_url ?? row.cover ?? previous.cover_url ?? '',
  });
}
const temporary = `${manifestPath}.tmp`;
fs.writeFileSync(temporary, JSON.stringify([...byId.values()], null, 2));
fs.renameSync(temporary, manifestPath);
process.stdout.write(`MERGED manifest=${manifestPath} before=${existing.length} recent=${recent.length} after=${byId.size}\n`);
