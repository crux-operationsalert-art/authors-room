// Focused re-check of the fixes: worker ping (CORS), keys page buttons, offline message, double-send guard.
import { chromium } from 'playwright';
const BASE = 'http://localhost:3000', EMAIL = 'e2e-test@authors-room.test', PASS = 'E2E-test-pass-2026!';
const out = { cors: [], results: {} };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' && /CORS|x-client-info/.test(m.text())) out.cors.push(m.text()); });
const workerCalls = [];
page.on('response', r => { if (r.url().includes('/functions/v1/worker') && r.request().method() === 'POST') workerCalls.push(r.status()); });

await page.goto(BASE);
await page.getByRole('button', { name: 'Use my password' }).click();
await page.getByLabel('Email').fill(EMAIL); await page.getByLabel('Password').fill(PASS);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('The Keeper of Vengurla').first().click();
await page.waitForURL(/book\?id=/);
await page.getByText('Manuscript').first().waitFor();

// write-next (triggers kick) — double click
const next = page.getByRole('button', { name: 'Write the next paragraph' });
await next.click(); await next.click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(6000);
out.results.workerPingStatuses = workerCalls.slice();
out.results.alertsAfterDoubleClick = await page.locator('[role=alert]').allInnerTexts();

// offline action
await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await page.getByRole('button', { name: 'Download backup (.json)' }).click();
await page.waitForTimeout(2000);
out.results.offlineAlerts = await page.locator('[role=alert]').allInnerTexts();
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(3000);
out.results.alertsAfterReconnect = await page.locator('[role=alert]').allInnerTexts();

// keys page: check keys
await page.goto(`${BASE}/keys`);
const check = page.getByRole('button', { name: /check/i }).first();
await check.click();
await page.waitForTimeout(15000);
out.results.keysPageText = (await page.locator('body').innerText()).slice(0, 1500);
await page.screenshot({ path: '/home/claude/e2e/shots/15-keys-after-check.png', fullPage: true });
console.log(JSON.stringify(out, null, 1));
await browser.close();
