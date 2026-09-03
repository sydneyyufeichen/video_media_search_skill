import fs from 'node:fs';

const [manifestPath, detailsPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !detailsPath || !outputPath) {
  throw new Error('Usage: node order-xhs-unseen-first.mjs <manifest.json> <details.json> <output.json>');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let details = [];
try { details = JSON.parse(fs.readFileSync(detailsPath, 'utf8')); } catch {}
const saved = new Map(details.map((row) => [String(row.media_id ?? ''), row]));
const rank = (row) => {
  const detail = saved.get(String(row.media_id ?? ''));
  if (!detail) return 0;
  if (String(detail.detail_status ?? '').startsWith('failed:')) return 1;
  return 2;
};
const ordered = manifest
  .map((row, index) => ({ row, index, rank: rank(row) }))
  .sort((a, b) => a.rank - b.rank || a.index - b.index)
  .map(({ row }) => row);
fs.writeFileSync(outputPath, JSON.stringify(ordered, null, 2));
process.stdout.write(`ORDERED unseen-first manifest=${manifestPath} rows=${ordered.length}\n`);
