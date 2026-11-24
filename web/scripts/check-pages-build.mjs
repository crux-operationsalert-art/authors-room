// Guard for GitHub Pages releases: every page must load its scripts from /authors-room/_next/.
// A build without NEXT_PUBLIC_BASE_PATH points at /_next/ and leaves every page stuck on "Loading…" (24 Nov 2026).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const bad = [];
const walk = d => readdirSync(d).forEach(f => { const p = join(d, f);
  if (statSync(p).isDirectory()) { if (f !== '_next') walk(p); }
  else if (p.endsWith('.html') && /["']\/_next\//.test(readFileSync(p, 'utf8'))) bad.push(p); });
walk('out');
if (bad.length) { console.error('Build is NOT for GitHub Pages (scripts point at /_next/):', bad.join(', ')); process.exit(1); }
console.log('Pages build check passed: all pages load scripts from /authors-room/_next/');
