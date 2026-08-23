import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const [captureDir, referencePath, outputPath, previewDir = '/tmp/allmedia_excel_previews'] = process.argv.slice(2);
if (!captureDir || !referencePath || !outputPath) {
  throw new Error('Usage: node scripts/build-workbook.mjs <capture-dir> <reference.xlsx> <output.xlsx> [preview-dir]');
}

const accounts = [
  { platform: '小红书', account: '阿飞泡枸杞', target: '65086f960000000017023c45' },
  { platform: '小红书', account: '欧阳会食养', target: '5e4e14f2000000000100745e' },
  { platform: '小红书', account: '小七养生说', target: '65853f56000000001d001fb8' },
  { platform: '小红书', account: '肖食儿', target: '6513f54a00000000230244b0' },
  { platform: '小红书', account: '养生小禾', target: '65afb335000000000e001062' },
  { platform: '小红书', account: '袁姐姐全息健康笔记', target: '65ddc0f60000000005008e49' },
  { platform: 'Instagram', account: 'wellness.with.gloria', target: 'wellness.with.gloria' },
  { platform: 'Instagram', account: 'tcmbycheehee', target: 'tcmbycheehee' },
  { platform: 'Instagram', account: 'dr.franktcm', target: 'dr.franktcm' },
  { platform: 'Instagram', account: 'yourtcmguide', target: 'yourtcmguide' },
];

const referenceSheets = new Map([
  ['wellness.with.gloria', 'wellness.with.gloria'],
  ['tcmbycheehee', 'tcmbycheehee'],
  ['yourtcmguide', 'yourtcmguide'],
]);

function parseCount(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value).trim().replace(/,/g, '');
  if (!text || text === '-1') return null;
  const match = text.match(/^(-?[\d.]+)\s*(万|亿|k|m)?$/i);
  if (!match) {
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const unit = (match[2] || '').toLowerCase();
  const multiplier = unit === '万' ? 10_000 : unit === '亿' ? 100_000_000 : unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  return Math.round(numeric * multiplier);
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    if (value > 10_000_000_000) return new Date(value);
    if (value > 1_000_000_000) return new Date(value * 1000);
    if (value > 20_000 && value < 100_000) return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function postKey(url, fallback = '') {
  const text = String(url || '');
  const instagram = text.match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/i);
  if (instagram) return `ig:${instagram[1]}`;
  const xhs = text.match(/(?:explore|profile\/[^/]+)\/([0-9a-f]{24})/i);
  if (xhs) return `xhs:${xhs[1]}`;
  return text ? text.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() : fallback;
}

function normalizeReferenceRows(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map((value) => String(value ?? '').trim());
  const index = (name) => headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  const pick = (row, name) => {
    const column = index(name);
    return column >= 0 ? row[column] : null;
  };
  return values.slice(1).map((row) => ({
    publishedAt: parseDate(pick(row, 'timestamp')),
    caption: String(pick(row, 'caption') ?? ''),
    transcript: String(pick(row, 'transcript') ?? ''),
    likes: parseCount(pick(row, 'likesCount')),
    comments: parseCount(pick(row, 'commentsCount')),
    shares: null,
    validViews: parseCount(pick(row, 'ViewCount')) ?? parseCount(pick(row, 'PlayCount')),
    duration: Number(pick(row, 'Duration')) || null,
    url: String(pick(row, 'url') ?? ''),
    viewBasis: pick(row, 'ViewCount') != null ? 'Instagram ViewCount（附件）' : 'Instagram PlayCount（附件）',
    source: '附件 Ins Reel Data.xlsx（历史基线）',
    status: '历史附件数据；分享数未提供，互动率按点赞+评论计算',
  })).filter((row) => row.url || row.caption);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function xhsFileName(account) {
  return `xiaohongshu_${Buffer.from(account, 'utf8').toString('hex')}.json`;
}

const referenceBook = await SpreadsheetFile.importXlsx(await FileBlob.load(referencePath));
const referenceData = new Map();
for (const [account, sheetName] of referenceSheets) {
  const sheet = referenceBook.worksheets.getItem(sheetName);
  const values = sheet.getUsedRange(true)?.values ?? [];
  referenceData.set(account, normalizeReferenceRows(values));
}

const accountRows = new Map();
for (const item of accounts) {
  if (item.platform === 'Instagram') {
    const current = await readJson(path.join(captureDir, `instagram_${item.account}.json`));
    const historical = referenceData.get(item.account) ?? [];
    const transcriptByKey = new Map(historical.map((row) => [postKey(row.url), row.transcript]));
    const merged = new Map();
    for (const raw of current) {
      const url = String(raw.url ?? '');
      const key = postKey(url, `ig-id:${raw.media_id ?? ''}`);
      const validViews = parseCount(raw.view_count) ?? parseCount(raw.play_count);
      const shares = parseCount(raw.shares);
      const transcript = transcriptByKey.get(key) ?? '';
      const missing = [];
      if (shares == null) missing.push('分享数未公开');
      if (!transcript) missing.push('无可用字幕/附件转录');
      if (validViews == null) missing.push('有效播放量未公开');
      merged.set(key, {
        publishedAt: parseDate(raw.published_at),
        caption: String(raw.caption ?? ''),
        transcript,
        likes: parseCount(raw.likes),
        comments: parseCount(raw.comments),
        shares,
        validViews,
        duration: Number(raw.duration_seconds) || null,
        url,
        viewBasis: raw.view_count != null ? 'Instagram view_count（当前公开接口）' : raw.play_count != null ? 'Instagram play_count（当前公开接口）' : '',
        source: 'Instagram 当前采集（OpenCLI + Chrome 登录态）',
        status: missing.length ? missing.join('；') : '完整',
      });
    }
    for (const row of historical) {
      const key = postKey(row.url, `ref:${merged.size}`);
      if (!merged.has(key)) merged.set(key, row);
    }
    accountRows.set(item.account, [...merged.values()]);
  } else {
    const current = await readJson(path.join(captureDir, xhsFileName(item.account)));
    accountRows.set(item.account, current.map((raw) => {
      const missing = ['有效播放量未公开，无法计算爆款倍率/互动率', '无公开视频字幕，未做音轨识别'];
      if (raw.shares == null || raw.shares === '') missing.push('分享数未公开');
      if (raw.duration_seconds == null || raw.duration_seconds === '') missing.push('时长未公开');
      if (raw.detail_status && raw.detail_status !== 'complete') missing.push(String(raw.detail_status));
      return {
        publishedAt: parseDate(raw.published_at),
        caption: [raw.title, raw.caption].filter(Boolean).join('\n'),
        transcript: '',
        likes: parseCount(raw.likes),
        comments: parseCount(raw.comments),
        shares: parseCount(raw.shares),
        validViews: null,
        duration: Number(raw.duration_seconds) || null,
        url: String(raw.page_url || raw.url || ''),
        viewBasis: '小红书公开页面未提供播放量',
        source: '小红书当前采集（OpenCLI + Chrome 登录态）',
        status: missing.join('；'),
      };
    }));
  }
}

const workbook = Workbook.create();
const headers = ['发布时间', 'Caption / 帖子文案', 'Transcript', '点赞数', '评论数', '分享数', '有效播放量', '时长（秒）', '爆款倍率', '互动率', '帖子 URL', '播放量口径', '数据来源', '数据状态 / 缺失原因'];
const instagramAccent = '#7C3AED';
const xhsAccent = '#D93A49';
const neutralFill = '#F5F7FA';
const borderColor = '#D7DCE3';
const tableStartRow = 6;
const dataStartRow = 7;

for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
  const item = accounts[accountIndex];
  const accent = item.platform === 'Instagram' ? instagramAccent : xhsAccent;
  const sheet = workbook.worksheets.add(item.account);
  sheet.showGridLines = false;
  const inputRows = accountRows.get(item.account) ?? [];
  const validViewValues = inputRows.map((row) => row.validViews).filter((value) => Number.isFinite(value) && value > 0);
  const baseline = validViewValues.length ? validViewValues.reduce((sum, value) => sum + value, 0) / validViewValues.length : null;
  const rows = [...inputRows].sort((a, b) => {
    const aViral = baseline && a.validViews ? a.validViews / baseline : -1;
    const bViral = baseline && b.validViews ? b.validViews / baseline : -1;
    return bViral - aViral || (b.likes ?? -1) - (a.likes ?? -1) || (b.publishedAt?.getTime?.() ?? 0) - (a.publishedAt?.getTime?.() ?? 0);
  });
  const lastRow = Math.max(dataStartRow, dataStartRow + rows.length - 1);

  sheet.getRange('A1:N1').merge();
  sheet.getRange('A1').values = [[`${item.platform}｜${item.account}｜视频内容分析`]];
  sheet.getRange('A1:N1').format = { fill: accent, font: { color: '#FFFFFF', bold: true, size: 16 }, verticalAlignment: 'center' };
  sheet.getRange('A1:N1').format.rowHeight = 30;

  sheet.getRange('A2:N2').merge();
  sheet.getRange('A2').values = [[`采集日期：2026-08-23（Asia/Shanghai）｜每个账号独立子表｜爆款倍率 = 有效播放量 ÷ 本账号平均有效播放量｜未知值留空，不以 0 代替`]];
  sheet.getRange('A2:N2').format = { fill: '#EEEAFB', font: { color: '#40345A', italic: true, size: 10 }, wrapText: true, verticalAlignment: 'center' };
  sheet.getRange('A2:N2').format.rowHeight = 30;

  sheet.getRange('A3:H3').values = [[
    '视频数', rows.length,
    '可计算爆款倍率', validViewValues.length,
    '平均有效播放量', null,
    '播放量覆盖率', null,
  ]];
  sheet.getRange('F3').formulas = [[validViewValues.length ? `=IFERROR(AVERAGE(G${dataStartRow}:G${lastRow}),"")` : '=""']];
  sheet.getRange('H3').formulas = [[rows.length ? `=IFERROR(COUNT(G${dataStartRow}:G${lastRow})/COUNTA(K${dataStartRow}:K${lastRow}),0)` : '=0']];
  sheet.getRange('A3:H3').format = { fill: neutralFill, font: { color: '#273142', bold: true }, borders: { preset: 'all', style: 'thin', color: borderColor }, verticalAlignment: 'center' };
  sheet.getRange('B3:D3').format.numberFormat = '0';
  sheet.getRange('F3').format.numberFormat = '#,##0';
  sheet.getRange('H3').format.numberFormat = '0.0%';

  sheet.getRange('A4:N4').merge();
  const scopeNote = item.platform === '小红书'
    ? '口径说明：小红书公开详情页可读取点赞、评论、收藏、分享等部分互动指标，但未公开播放量；因此爆款倍率与互动率留空。Transcript 仅在平台提供字幕或完成音轨识别时填写。'
    : item.account === 'wellness.with.gloria'
      ? '口径说明：该账号当前 Instagram 私有接口拒绝访问，本表使用用户附件中的 100 条历史明细；分享数未提供，互动率按点赞+评论计算。'
      : '口径说明：Instagram 有效播放量优先使用 view_count，否则使用 play_count；分享数多数帖子未公开，互动率按可获得的点赞+评论+分享计算。附件中匹配到的历史 transcript 已合并。';
  sheet.getRange('A4').values = [[scopeNote]];
  sheet.getRange('A4:N4').format = { fill: '#FFF8E8', font: { color: '#6B561A', size: 10 }, wrapText: true, verticalAlignment: 'center', borders: { preset: 'outside', style: 'thin', color: '#E7D7A4' } };
  sheet.getRange('A4:N4').format.rowHeight = 38;

  sheet.getRange(`A${tableStartRow}:N${tableStartRow}`).values = [headers];
  sheet.getRange(`A${tableStartRow}:N${tableStartRow}`).format = { fill: accent, font: { color: '#FFFFFF', bold: true }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true, borders: { preset: 'all', style: 'thin', color: '#FFFFFF' } };
  sheet.getRange(`A${tableStartRow}:N${tableStartRow}`).format.rowHeight = 32;

  if (rows.length) {
    const values = rows.map((row) => [
      row.publishedAt,
      row.caption,
      row.transcript,
      row.likes,
      row.comments,
      row.shares,
      row.validViews,
      row.duration,
      null,
      null,
      row.url,
      row.viewBasis,
      row.source,
      row.status,
    ]);
    sheet.getRange(`A${dataStartRow}:N${lastRow}`).values = values;
    sheet.getRange(`I${dataStartRow}:I${lastRow}`).formulas = rows.map((row, offset) => [row.validViews && baseline ? `=IFERROR(G${dataStartRow + offset}/$F$3,"")` : '=""']);
    sheet.getRange(`J${dataStartRow}:J${lastRow}`).formulas = rows.map((row, offset) => [row.validViews ? `=IFERROR((D${dataStartRow + offset}+E${dataStartRow + offset}+IF(F${dataStartRow + offset}="",0,F${dataStartRow + offset}))/G${dataStartRow + offset},"")` : '=""']);
    sheet.tables.add(`A${tableStartRow}:N${lastRow}`, true, `T_${String(accountIndex + 1).padStart(2, '0')}`);
    sheet.getRange(`A${dataStartRow}:N${lastRow}`).format = { verticalAlignment: 'top', wrapText: true, borders: { preset: 'all', style: 'thin', color: borderColor } };
    sheet.getRange(`A${dataStartRow}:A${lastRow}`).format.numberFormat = 'yyyy-mm-dd hh:mm';
    sheet.getRange(`D${dataStartRow}:G${lastRow}`).format.numberFormat = '#,##0';
    sheet.getRange(`H${dataStartRow}:H${lastRow}`).format.numberFormat = '0.0';
    sheet.getRange(`I${dataStartRow}:I${lastRow}`).format.numberFormat = '0.00x';
    sheet.getRange(`J${dataStartRow}:J${lastRow}`).format.numberFormat = '0.0%';
    sheet.getRange(`I${dataStartRow}:I${lastRow}`).conditionalFormats.add('colorScale', { colors: ['#FCE8E6', '#FFF4CC', '#CDEFD8'] });
    sheet.getRange(`D${dataStartRow}:D${lastRow}`).conditionalFormats.add('dataBar', { color: accent, gradient: true });
    sheet.getRange(`N${dataStartRow}:N${lastRow}`).conditionalFormats.add('containsText', { text: '完整', format: { fill: '#E9F7EF', font: { color: '#1E6B43' } } });
  } else {
    sheet.getRange(`A${dataStartRow}:N${dataStartRow}`).merge();
    sheet.getRange(`A${dataStartRow}`).values = [['本次未读取到公开视频记录。']];
  }

  const widths = [18, 44, 52, 11, 11, 11, 14, 12, 12, 12, 38, 28, 30, 48];
  widths.forEach((width, index) => { sheet.getRangeByIndexes(0, index, lastRow, 1).format.columnWidth = width; });
  if (rows.length) sheet.getRange(`A${dataStartRow}:N${lastRow}`).format.rowHeight = 54;
  sheet.freezePanes.freezeRows(tableStartRow);
  sheet.freezePanes.freezeColumns(1);

  const chartMetricColumn = validViewValues.length ? 'I' : 'D';
  const chartMetricTitle = validViewValues.length ? '爆款倍率' : '点赞数';
  const chartCount = Math.min(10, rows.length);
  sheet.getRange('P1:Q1').values = [['Top 视频', chartMetricTitle]];
  sheet.getRange('P1:Q1').format = { fill: neutralFill, font: { bold: true, color: '#273142' }, borders: { preset: 'all', style: 'thin', color: borderColor } };
  if (chartCount) {
    const helperFormulas = [];
    for (let i = 0; i < chartCount; i += 1) {
      const rowNumber = dataStartRow + i;
      helperFormulas.push([`=LEFT(B${rowNumber},24)`, `=${chartMetricColumn}${rowNumber}`]);
    }
    sheet.getRange(`P2:Q${chartCount + 1}`).formulas = helperFormulas;
    sheet.getRange(`P2:Q${chartCount + 1}`).format = { borders: { preset: 'all', style: 'thin', color: borderColor } };
    sheet.getRange(`Q2:Q${chartCount + 1}`).format.numberFormat = validViewValues.length ? '0.00x' : '#,##0';
    const chart = sheet.charts.add('bar', sheet.getRange(`P1:Q${chartCount + 1}`));
    chart.setPosition('S1', 'Z18');
    chart.title = validViewValues.length ? 'Top 10 视频｜爆款倍率' : 'Top 10 视频｜点赞数（播放量未公开）';
    chart.titleTextStyle.fontSize = 12;
    chart.hasLegend = false;
    chart.xAxis = { axisType: 'textAxis', textStyle: { fontSize: 9 } };
    chart.yAxis = { numberFormatCode: validViewValues.length ? '0.0x' : '#,##0' };
  }
  sheet.getRange('P1:Q12').format.columnWidth = 18;
}

await fs.mkdir(previewDir, { recursive: true });
const previews = [];
for (const item of accounts) {
  const blob = await workbook.render({ sheetName: item.account, range: 'A1:Z22', scale: 1.1, format: 'png' });
  const previewPath = path.join(previewDir, `${item.platform}_${item.account}.png`);
  await fs.writeFile(previewPath, new Uint8Array(await blob.arrayBuffer()));
  previews.push(previewPath);
}

const errorScan = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 300 },
  summary: 'final formula error scan',
});

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

const report = {
  outputPath,
  previews,
  sheets: accounts.map((item) => ({ account: item.account, platform: item.platform, rows: (accountRows.get(item.account) ?? []).length })),
  errorScan: errorScan.ndjson,
};
await fs.writeFile(path.join(previewDir, 'build-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
