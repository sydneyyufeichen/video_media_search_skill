import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const [referencePath, outputPath] = process.argv.slice(2);
if (!referencePath || !outputPath) throw new Error('Usage: node scripts/extract-reference-transcripts.mjs <reference.xlsx> <output.json>');

const accounts = ['wellness.with.gloria', 'tcmbycheehee', 'yourtcmguide'];
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(referencePath));
const output = {};
for (const account of accounts) {
  const values = workbook.worksheets.getItem(account).getUsedRange(true)?.values ?? [];
  const headers = (values[0] ?? []).map((value) => String(value ?? '').trim().toLowerCase());
  const urlIndex = headers.indexOf('url');
  const transcriptIndex = headers.indexOf('transcript');
  const rows = {};
  for (const row of values.slice(1)) {
    const url = String(row[urlIndex] ?? '');
    const transcript = String(row[transcriptIndex] ?? '').trim();
    const match = url.match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/i);
    if (match && transcript) rows[match[1]] = transcript;
  }
  output[account] = rows;
}
await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(output).map(([account, rows]) => [account, Object.keys(rows).length])), null, 2));
