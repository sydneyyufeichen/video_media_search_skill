import fs from 'node:fs';

const [envPath = '.env', platform, outputPath] = process.argv.slice(2);
if (!platform || !outputPath) throw new Error('Usage: node scripts/write-cookie-jar.mjs <env> <instagram|xiaohongshu> <output>');

const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
  .map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));

const config = platform === 'instagram'
  ? { key: 'INSTAGRAM_COOKIE', domain: '.instagram.com' }
  : { key: 'XHS_COOKIE', domain: '.xiaohongshu.com' };
const raw = env[config.key] ?? '';
if (!raw) throw new Error(`${config.key} is missing`);

const rows = raw.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
  const index = part.indexOf('=');
  const name = index >= 0 ? part.slice(0, index).trim() : part;
  const value = index >= 0 ? part.slice(index + 1).trim() : '';
  return `${config.domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}`;
});
fs.writeFileSync(outputPath, `# Netscape HTTP Cookie File\n${rows.join('\n')}\n`, { mode: 0o600 });
