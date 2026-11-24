// Worker logic tests (genre rules, scoring sheets, cut-off guard). Run: node supabase/functions/worker/logic.test.mjs
// roles.ts is bundled with esbuild first: npx esbuild supabase/functions/worker/roles.ts --format=esm --outfile=/tmp/roles.mjs
import assert from 'node:assert/strict';
const R = await import(process.env.ROLES ?? '/tmp/roles.mjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS', name); };

const novel = R.genreReaderRules('Mystery / Psychological Thriller with Philosophical Themes');
const comedy = R.genreReaderRules('Humour / Satirical Workplace Comedy & Management Parody');
t('comedy rules never reach the novel ("with" must not match "wit")', () => assert.ok(!novel.includes('Comedy/satire')));
t('novel gets thriller and psychological rules', () => { assert.ok(novel.includes('Thriller/mystery')); assert.ok(novel.includes('Psychological/literary')); });
t('comedy book gets comedy rules only', () => { assert.ok(comedy.includes('Comedy/satire')); assert.ok(!comedy.includes('Psychological/literary')); });
t('novel scoring sheet fails on explaining the mystery and mocking trauma', () => {
  assert.ok(novel.includes('explains or resolves the central mystery')); assert.ok(novel.includes('mocks or trivialises the protagonist'));
});
t('every scoring sheet adds up to 100', () => {
  for (const g of ['Humour', 'Psychological novel', 'Self-help', '']) {
    const sheet = R.genreRubric(g); const pts = [...sheet.matchAll(/: (\d+)\n/g)].map(m => Number(m[1]));
    assert.equal(pts.reduce((a, b) => a + b, 0), 100, g);
  }
});
t('ending rule limits question endings', () => assert.ok(R.DEFAULT_CRAFT.join(' ').includes('At most one paragraph in four may end on a question')));
t('consolidate schema requires critical_failures', () => assert.ok(R.consolidate.schema.required.includes('critical_failures')));

// the same cut-off guard expression as index.ts
const cutOff = (text) => !/[.!?…'"”’)\]*_—-]$/.test(text) || /\b(and|or|but|the|a|of|to|that|I|which|with)\s*,?$/i.test(text) || text.split(/\s+/).length < 25;
const long = 'word '.repeat(30);
t('cut-off guard rejects unfinished text', () => { assert.ok(cutOff(long + 'and I,')); assert.ok(cutOff(long + 'that only')); assert.ok(cutOff('Too short.')); });
t('cut-off guard accepts finished text', () => { assert.ok(!cutOff(long + 'end.')); assert.ok(!cutOff(long + 'what now?')); assert.ok(!cutOff(long + 'he said, “go.”')); });
console.log(`${n} worker logic tests passed`);
