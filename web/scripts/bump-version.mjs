// Usage: node scripts/bump-version.mjs  → new version string in lib/version.ts and public/version.json
import { readFileSync, writeFileSync } from 'node:fs';
const d = new Date(), day = d.toISOString().slice(0, 10);
const cur = readFileSync('lib/version.ts', 'utf8').match(/APP_VERSION = '([^']+)'/)?.[1] ?? '';
const n = cur.startsWith(day) ? Number(cur.split('.').pop()) + 1 : 1;
const v = `${day}.${String(n).padStart(2, '0')}`;
writeFileSync('lib/version.ts', readFileSync('lib/version.ts', 'utf8').replace(/APP_VERSION = '[^']+'/, `APP_VERSION = '${v}'`));
writeFileSync('public/version.json', JSON.stringify({ version: v }) + '\n');
console.log(v);
