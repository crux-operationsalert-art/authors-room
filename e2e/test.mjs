// End-to-end user test of Author's Room against the LIVE backend.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-test@authors-room.test', PASS = 'E2E-test-pass-2026!';
const OUT = '/home/claude/e2e/shots'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync('/home/claude/e2e/log.txt', l + '\n'); };
const findings = [];
const note = (sev, what) => { findings.push({ sev, what }); log(`FINDING ${sev}: ${what}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(page, fn, label, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) { log(`ok: ${label} after ${Math.round((Date.now() - t0) / 1000)} s`); return true; }
    await sleep(5000);
  }
  note('high', `timed out waiting for: ${label} (${timeoutMs / 1000} s)`);
  await page.screenshot({ path: `${OUT}/timeout-${label.replace(/\W+/g, '_')}.png`, fullPage: true });
  return false;
}

const browser = await chromium.launch();
let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
let page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

async function signIn(p) {
  await p.goto(BASE);
  await p.getByRole('button', { name: 'Use my password' }).click();
  await p.getByLabel('Email').fill(EMAIL);
  await p.getByLabel('Password').fill(PASS);
  await p.getByRole('button', { name: 'Sign in' }).click();
}

// 1. sign in with a WRONG password first
await page.goto(BASE);
await page.screenshot({ path: `${OUT}/01-signin.png` });
await page.getByRole('button', { name: 'Use my password' }).click();
await page.getByLabel('Email').fill(EMAIL); await page.getByLabel('Password').fill('wrong');
await page.getByRole('button', { name: 'Sign in' }).click(); await sleep(2500);
if (!(await page.getByText('did not match').count())) note('medium', 'wrong password shows no clear message');
await signIn(page);
await page.getByText('Claim this Author').waitFor({ timeout: 20000 }).catch(() => note('high', 'claim screen did not appear after sign-in'));
await page.screenshot({ path: `${OUT}/02-claim.png` });
await page.getByLabel('Author name').fill('Test Author');
await page.getByRole('button', { name: /Claim this/ }).click();
await page.getByText('Start a new book').waitFor({ timeout: 20000 });
log('signed in and claimed');

// 2. empty idea and too-short idea
await page.getByLabel('Your idea').fill('short');
await page.getByRole('button', { name: 'Start my book' }).click(); await sleep(2500);
if (!(await page.getByText(/tell me a little more/i).count())) note('medium', 'too-short idea gives no friendly message');
await page.getByLabel('Working title').fill('The Keeper of Vengurla');
await page.getByLabel('Your idea').fill('A retired lighthouse keeper on the Konkan coast starts receiving letters in her own handwriting, dated twenty years in the future. Quiet literary mystery for adults, close third person, past tense, about 70,000 words, hopeful ending.');
await page.screenshot({ path: `${OUT}/03-new-book.png` });
await page.getByRole('button', { name: 'Start my book' }).click();
await page.waitForURL(/\/book\?id=/, { timeout: 20000 });
const bookUrl = page.url(); log('book page', bookUrl);

// 3. interview reply
await waitFor(page, async () => (await page.locator('div[style*="background: rgb(246, 248, 250)"]').count()) > 0 ||
  (await page.getByText(/directions for your book/).count()) > 0, 'first interviewer reply', 300000);
await page.screenshot({ path: `${OUT}/04-interview.png`, fullPage: true });
if (await page.getByLabel('Reply').count()) {
  await page.getByLabel('Reply').fill('Her name is Sumati Rane, 67, widow, kept the Vengurla light for 30 years. She wants to know what she will lose and whether she can change it. Please propose directions now.');
  await page.getByRole('button', { name: 'Send' }).click();
  // double-send protection
  await page.getByLabel('Reply').fill('Thank you.');
  await page.getByRole('button', { name: 'Send' }).click();
}

// 4. directions
await waitFor(page, async () => (await page.getByRole('button', { name: 'Choose this direction' }).count()) > 0, 'genre directions', 480000);
await page.screenshot({ path: `${OUT}/05-directions.png`, fullPage: true });
const choose = page.getByRole('button', { name: 'Choose this direction' }).first();
await choose.click();
await choose.click({ timeout: 3000 }).catch(() => {});   // double click
await sleep(3000);
const errText = await page.locator('[role=alert]').allInnerTexts();
log('after double choose, alerts:', JSON.stringify(errText));

// 5. constitution
await waitFor(page, async () => (await page.getByRole('button', { name: 'Approve constitution' }).count()) > 0, 'constitution proposed', 480000);
await page.screenshot({ path: `${OUT}/06-constitution.png`, fullPage: true });
await page.getByRole('button', { name: 'Approve constitution' }).click();

// 6. Bible, then paragraph
await waitFor(page, async () => (await page.getByRole('button', { name: /Write the opening paragraph/ }).isEnabled().catch(() => false)), 'Book Bible ready', 480000);
await page.screenshot({ path: `${OUT}/07-bible.png`, fullPage: true });
await page.getByRole('button', { name: /Write the opening paragraph/ }).click();
await sleep(4000);

// 7. LAPTOP OFF: close the whole browser context for 4 minutes
log('closing browser (laptop off) for 4 minutes');
await ctx.close();
await sleep(240000);
ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await signIn(page);
await page.getByText('Start a new book').waitFor({ timeout: 20000 });
await page.goto(bookUrl);
await sleep(5000);
const afterOff = await page.locator('main').innerText();
log('after reopening, paragraph present:', /¶ 1/.test(afterOff), 'status snippet:', (afterOff.match(/(Team reviewing|Being revised|Passed review[^\n]*|Drafted)/) ?? ['none'])[0]);
await page.screenshot({ path: `${OUT}/08-after-laptop-off.png`, fullPage: true });

// 8. OFFLINE
await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(1500);
const banner = await page.getByText('You are offline').count();
if (!banner) note('medium', 'no offline banner');
await page.screenshot({ path: `${OUT}/09-offline.png` });
await page.getByRole('button', { name: /Download backup/ }).click(); await sleep(2500);
const offErr = await page.locator('[role=alert]').allInnerTexts();
log('offline action alert:', JSON.stringify(offErr));
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await sleep(3000);

// 9. wait for review to pass, try approve early via double click, then approve
await waitFor(page, async () => (await page.getByRole('button', { name: 'Approve paragraph' }).count()) > 0, 'paragraph passed review', 900000);
await page.screenshot({ path: `${OUT}/10-passed.png`, fullPage: true });
const ap = page.getByRole('button', { name: 'Approve paragraph' }).first();
await ap.click(); await ap.click({ timeout: 2000 }).catch(() => {});
await sleep(4000);
await page.screenshot({ path: `${OUT}/11-approved.png`, fullPage: true });
if (!(await page.getByText('Approved by you').count())) note('high', 'approval not shown after clicking Approve');

// 10. downloads
for (const name of [/Download backup/, /Download manuscript/]) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.getByRole('button', { name }).click()]);
  if (!dl) { note('medium', `download did not start: ${name}`); continue; }
  const path = `${OUT}/${dl.suggestedFilename()}`; await dl.saveAs(path);
  log('downloaded', dl.suggestedFilename(), fs.statSync(path).size, 'bytes');
}

// 11. keys page + mobile layout
await page.goto(`${BASE}/keys`); await sleep(5000);
await page.screenshot({ path: `${OUT}/12-keys.png`, fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(bookUrl); await sleep(5000);
await page.screenshot({ path: `${OUT}/13-mobile-book.png`, fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
if (overflow) note('medium', 'book page scrolls sideways on a phone-sized screen');
await page.goto(`${BASE}/keys`); await sleep(4000);
await page.screenshot({ path: `${OUT}/14-mobile-keys.png`, fullPage: true });

log('console errors:', consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 5)));
fs.writeFileSync('/home/claude/e2e/findings.json', JSON.stringify({ findings, consoleErrors, bookUrl }, null, 2));
log('DONE');
await browser.close();
