import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const [inputPath, rowsPath, outputPath, previewDir = ''] = process.argv.slice(2);
if (!inputPath || !rowsPath || !outputPath) {
  throw new Error('Usage: node scripts/append-incremental-workbook.mjs <input.xlsx> <rows.json> <output.xlsx> [preview-dir]');
}

const xhsAccounts = new Set(['阿飞泡枸杞', '欧阳会食养', '小七养生说', '肖食儿', '养生小禾']);
const instagramAccounts = new Set(['tcmbycheehee', 'wellness.with.gloria', 'dr.franktcm', 'yourtcmguide']);
const requiredSheetOrder = [
  '阿飞泡枸杞', '欧阳会食养', '小七养生说', '肖食儿', '养生小禾',
  'tcmbycheehee', 'wellness.with.gloria', 'dr.franktcm', 'yourtcmguide',
];
const requiredHeaders = {
  xiaohongshu: ['Timestamp', 'Caption', 'Script', 'Likes', 'Comments', 'Shares', 'Heat', 'Duration', 'URL'],
  instagram: ['Timestamp', 'Caption', 'Script', 'Likes', 'Comments', 'Views', 'Heat', 'Engagement', 'Duration', 'URL'],
};

function canonicalId(value) {
  const text = String(value ?? '').trim();
  const instagram = text.match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/i);
  if (instagram) return `ig:${instagram[1]}`;
  const xhs = text.match(/(?:explore|profile\/[^/]+)\/([0-9a-f]{24})/i);
  if (xhs) return `xhs:${xhs[1].toLowerCase()}`;
  return text ? `url:${text.split('#')[0].replace(/\?.*$/, '').replace(/\/+$/, '')}` : '';
}

function asNumber(value) {
  if (value === '' || value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value);
  }
  const parsed = new Date(String(value ?? ''));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid published_at: ${value}`);
  return parsed;
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) {
    return payload.reduce((byAccount, row) => {
      const account = String(row.account ?? '').trim();
      if (!account) throw new Error('Every input row must include account');
      (byAccount[account] ??= []).push(row);
      return byAccount;
    }, {});
  }
  return payload.accounts ?? payload;
}

const payload = normalizePayload(JSON.parse(await fs.readFile(rowsPath, 'utf8')));
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const actualOrder = workbook.worksheets.items.map((sheet) => sheet.name);
if (JSON.stringify(actualOrder) !== JSON.stringify(requiredSheetOrder)) {
  throw new Error(`Sheet order mismatch. Expected ${requiredSheetOrder.join(' | ')}, got ${actualOrder.join(' | ')}`);
}

const report = [];
for (const account of requiredSheetOrder) {
  const rows = Array.isArray(payload[account]) ? payload[account] : [];
  if (!rows.length) continue;
  const platform = xhsAccounts.has(account) ? 'xiaohongshu' : instagramAccounts.has(account) ? 'instagram' : '';
  if (!platform) throw new Error(`Unsupported account: ${account}`);
  const sheet = workbook.worksheets.getItem(account);
  const expectedHeaders = requiredHeaders[platform];
  const headerRange = sheet.getRangeByIndexes(0, 0, 1, expectedHeaders.length);
  const actualHeaders = headerRange.values[0].map((value) => String(value ?? '').trim());
  if (JSON.stringify(actualHeaders) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`${account} header mismatch. Expected ${expectedHeaders.join(' | ')}, got ${actualHeaders.join(' | ')}`);
  }

  const used = sheet.getUsedRange(true);
  const lastRow = used?.rowCount ?? 1;
  const urlColumn = platform === 'xiaohongshu' ? 8 : 9;
  const existingUrls = sheet.getRangeByIndexes(1, urlColumn, Math.max(0, lastRow - 1), 1).values.flat();
  const knownIds = new Set(existingUrls.map(canonicalId).filter(Boolean));
  const deduped = [];
  for (const row of rows) {
    const id = canonicalId(row.url ?? row.post_url ?? row.media_id);
    if (!id || knownIds.has(id)) continue;
    knownIds.add(id);
    deduped.push(row);
  }
  deduped.sort((left, right) => asDate(right.published_at ?? right.timestamp) - asDate(left.published_at ?? left.timestamp));
  if (!deduped.length) {
    report.push({ account, platform, beforeRows: lastRow - 1, addedRows: 0, afterRows: lastRow - 1 });
    continue;
  }

  const columnCount = expectedHeaders.length;
  const template = sheet.getRangeByIndexes(lastRow - 1, 0, 1, columnCount);
  const formulaEndRow = Math.max(lastRow + deduped.length, 1000);
  const normalizedRows = deduped.map((row) => {
    const publishedAt = asDate(row.published_at ?? row.timestamp);
    const common = [
      publishedAt,
      String(row.caption ?? ''),
      String(row.script ?? row.transcript ?? ''),
      asNumber(row.likes),
      asNumber(row.comments),
    ];
    if (platform === 'xiaohongshu') {
      return [
        ...common,
        asNumber(row.shares),
        null,
        asNumber(row.duration_seconds ?? row.duration),
        String(row.url ?? row.post_url ?? ''),
      ];
    }
    return [
      ...common,
      asNumber(row.views ?? row.view_count ?? row.play_count),
      null,
      null,
      asNumber(row.duration_seconds ?? row.duration),
      String(row.url ?? row.post_url ?? ''),
    ];
  });

  const table = sheet.tables.items[0];
  if (table) {
    table.rows.add(null, normalizedRows);
  } else {
    for (let index = 0; index < normalizedRows.length; index += 1) {
      const target = sheet.getRangeByIndexes(lastRow + index, 0, 1, columnCount);
      target.copyFrom(template, 'all');
      target.values = [normalizedRows[index]];
    }
  }

  for (let index = 0; index < deduped.length; index += 1) {
    const targetRowIndex = lastRow + index;
    if (platform === 'xiaohongshu') {
      sheet.getRange(`G${targetRowIndex + 1}`).formulas = [[
        `=IFERROR(SUM(D${targetRowIndex + 1}:F${targetRowIndex + 1})/(SUM($D$2:$F$${formulaEndRow})/COUNTA($I$2:$I$${formulaEndRow})),"")`,
      ]];
    } else {
      sheet.getRange(`G${targetRowIndex + 1}:H${targetRowIndex + 1}`).formulas = [[
        `=IFERROR((D${targetRowIndex + 1}+E${targetRowIndex + 1})/((SUM($D$2:$D$${formulaEndRow})+SUM($E$2:$E$${formulaEndRow}))/COUNTA($J$2:$J$${formulaEndRow})),"")`,
        `=IFERROR((D${targetRowIndex + 1}+E${targetRowIndex + 1})/F${targetRowIndex + 1},"")`,
      ]];
    }
  }

  const firstNewRow = lastRow + 1;
  const finalRow = lastRow + deduped.length;
  sheet.getRange(`A${firstNewRow}:${String.fromCharCode(64 + columnCount)}${finalRow}`).format.autofitRows();
  report.push({ account, platform, beforeRows: lastRow - 1, addedRows: deduped.length, afterRows: finalRow - 1, newRange: `A${firstNewRow}:${String.fromCharCode(64 + columnCount)}${finalRow}` });

  if (previewDir) {
    await fs.mkdir(previewDir, { recursive: true });
    const start = Math.max(1, firstNewRow - 2);
    const preview = await workbook.render({
      sheetName: account,
      range: `A${start}:${String.fromCharCode(64 + columnCount)}${finalRow}`,
      scale: 1,
      format: 'png',
    });
    await fs.writeFile(path.join(previewDir, `${account}.png`), new Uint8Array(await preview.arrayBuffer()));
  }
}

const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'incremental workbook formula error scan',
});

await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
process.stdout.write(`${JSON.stringify({ inputPath, rowsPath, outputPath, report, errorScan: errors.ndjson }, null, 2)}\n`);
