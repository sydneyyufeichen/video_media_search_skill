import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const [inputPath, outputPath, previewDir = ''] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/fill-proxy-metrics.mjs <input.xlsx> <output.xlsx> [preview-dir]');
}

const instagramAccounts = new Set([
  'wellness.with.gloria',
  'tcmbycheehee',
  'dr.franktcm',
  'yourtcmguide',
]);

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const report = [];

for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange(true);
  const lastRow = used?.rowCount ?? 1;
  if (lastRow < 2) continue;

  const isInstagram = instagramAccounts.has(sheet.name);
  sheet.getRange('I1:J1').values = [['爆款倍率', '互动率']];

  const viralFormulas = [];
  const engagementFormulas = [];
  for (let row = 2; row <= lastRow; row += 1) {
    if (isInstagram) {
      viralFormulas.push([`=IFERROR((D${row}+E${row})/((SUM($D$2:$D$${lastRow})+SUM($E$2:$E$${lastRow}))/COUNTA($H$2:$H$${lastRow})),"")`]);
      engagementFormulas.push([`=IFERROR((D${row}+E${row})/F${row},"")`]);
    } else {
      viralFormulas.push([`=IFERROR(SUM(D${row}:F${row})/(SUM($D$2:$F$${lastRow})/COUNTA($H$2:$H$${lastRow})),"")`]);
      engagementFormulas.push([`=IFERROR(SUM(E${row}:F${row})/SUM(D${row}:F${row}),"")`]);
    }
  }

  sheet.getRange(`I2:I${lastRow}`).formulas = viralFormulas;
  sheet.getRange(`J2:J${lastRow}`).formulas = engagementFormulas;
  sheet.getRange(`I2:I${lastRow}`).format.numberFormat = '0.00x';
  sheet.getRange(`J2:J${lastRow}`).format.numberFormat = '0.0%';

  report.push({
    sheet: sheet.name,
    platform: isInstagram ? 'Instagram' : '小红书',
    rows: lastRow - 1,
    viralFormula: viralFormulas[0][0],
    engagementFormula: engagementFormulas[0][0],
  });

  if (previewDir) {
    await fs.mkdir(previewDir, { recursive: true });
    const preview = await workbook.render({ sheetName: sheet.name, range: 'A1:J20', scale: 1, format: 'png' });
    await fs.writeFile(path.join(previewDir, `${sheet.name}.png`), new Uint8Array(await preview.arrayBuffer()));
  }
}

const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 300 },
  summary: 'proxy metric formula error scan',
});

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({ outputPath, report, errorScan: errors.ndjson }, null, 2));
