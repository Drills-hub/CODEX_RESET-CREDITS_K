import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApplication } from '../lib/http.mjs';
import { AppError } from '../lib/errors.mjs';
const N = 1791072000, H = 3600, D = 86400;
const snapshot = () => ({ queriedAt: N, availableCount: 2, detailState: 'complete', accountScope: 'calendar-account', revision: 0, ordinaryUsageAllowed: true,
  credits: [{ number: 1, title: '첫 리셋권', status: 'available', expiryState: 'known', expiresAt: N + 12 * H }, { number: 2, title: '다음 리셋권', status: 'available', expiryState: 'known', expiresAt: N + 3 * D }],
  usageWindows: [{ kind: 'five-hour', state: 'complete', remainingPercent: 65, resetsAt: N + 5 * H }, { kind: 'weekly', state: 'complete', remainingPercent: 80, resetsAt: N + 12 * H }] });
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
async function open(t, { read = snapshot, status, width = 375, theme = 'light', path = '/' } = {}) {
  let reads = 0;
  const app = createApplication({ service: { read: () => read(++reads), status: () => status?.() ?? { connected: true, authState: 'chatgpt', revision: 0 } } });
  await app.listen(); t.after(() => app.close());
  const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.clock.install({ time: new Date(N * 1000) });
  await page.goto(`${app.origin}${path}#${app.bootstrapToken}`);
  await page.waitForFunction(() => document.querySelector('#count').textContent === '2');
  return { page, reads: () => reads };
}
test('recommendation is shared in the summary and removed forecasting controls issue no automatic reads', async t => {
  const { page, reads } = await open(t);
  assert.equal(await page.locator('#reset-recommendation').count(), 0);
  assert.equal(await page.locator('#recommendation-details').count(), 1);
  assert.match(await page.locator('#recommendation-title').innerText(), /20시/);
  assert.equal(await page.locator('#forecast-toggle, #usage-plan-rate, #work-plan-enabled, #start-time-comparison').count(), 0);
  await page.clock.runFor(600000);
  assert.equal(reads(), 1);
});
test('tabs and calendar support selection, history, month navigation and distinct event types', async t => {
  const { page } = await open(t);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['리셋 상세', '만료 캘린더', '알림']);
  await page.getByRole('tab', { name: '리셋 상세', exact: true }).press('ArrowRight');
  assert.equal(await page.locator('#tab-calendar').getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '만료 캘린더', exact: true }).click();
  assert.equal(await page.locator('[data-calendar-date]').count(), 31);
  assert.equal(await page.locator('#calendar-events [data-kind="credit-expiry"]').count(), 1);
  assert.equal(await page.locator('#calendar-events [data-kind="weekly-reset"]').count(), 1);
  assert.equal(await page.locator('#calendar-events [data-kind="five-hour-reset"]').count(), 1);
  const colors = await page.locator('#calendar-events [data-kind]').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).borderLeftColor));
  assert.equal(new Set(colors).size, 3);
  await page.locator('#calendar-next').click();
  assert.match(await page.locator('#calendar-month').innerText(), /2026년 11월/);
  assert.equal(await page.locator('[data-calendar-date]').count(), 30);
  await page.locator('#calendar-today').click();
  await page.locator('[data-calendar-date="2026-10-07"]').click();
  assert.match(await page.locator('#calendar-events').innerText(), /다음 리셋권/);
  await page.getByRole('tab', { name: '알림', exact: true }).click();
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#tab-calendar').getAttribute('aria-selected') === 'true');
  assert.equal(await page.locator('[data-calendar-date="2026-10-07"]').getAttribute('aria-pressed'), 'true');
});
test('obsolete forecast URL falls back without losing unrelated query values', async t => {
  const { page } = await open(t, { path: '/?tab=forecast&source=desktop' });
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'credits');
  assert.equal(new URL(page.url()).searchParams.get('source'), 'desktop');
});
test('failed refresh retains calendar events and suspends recommendation, then recovers and clears at logout', async t => {
  let signedOut = false;
  const { page } = await open(t, { read: n => { if (n === 2) throw new AppError('TIMEOUT'); return snapshot(); }, status: () => ({ connected: true, authState: signedOut ? 'signed-out' : 'chatgpt', revision: signedOut ? 1 : 0 }) });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#notice').dataset.kind === 'error');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  await page.locator('#tab-calendar').click();
  assert.equal(await page.locator('#calendar-events [data-kind]').count(), 3);
  assert.match(await page.locator('#calendar-status').innerText(), /이전 조회/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'deadline');
  await page.locator('#calendar-next').click(); signedOut = true;
  await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelector('#count').textContent === '확인 전');
  assert.equal(await page.locator('#calendar-events [data-kind]').count(), 0);
  assert.match(await page.locator('#calendar-month').innerText(), /2026년 10월/);
});
test('elapsed deadline suspends until a successful refresh offers immediate use', async t => {
  const { page } = await open(t, { read: n => ({ ...snapshot(), queriedAt: n === 1 ? N : N + H, credits: [{ ...snapshot().credits[0], expiresAt: N + 2 * H }] }) });
  await page.clock.fastForward(H * 1000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#recommendation-title').innerText(), '지금 사용을 추천합니다!');
});
for (const theme of ['light', 'dark']) for (const width of [320, 375, 768, 1280]) {
  test(`calendar ${theme} ${width}px fits and exposes labelled dates and legend`, async t => {
    const { page } = await open(t, { width, theme });
    await page.locator('#tab-calendar').click();
    assert.equal(await page.locator('#calendar-legend').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.match(await page.locator('[data-calendar-date="2026-10-04"]').getAttribute('aria-label'), /일정 3건/);
    await page.locator('[data-calendar-date="2026-10-04"]').focus();
    assert.ok(await page.locator('[data-calendar-date="2026-10-04"]').evaluate(n => parseFloat(getComputedStyle(n).outlineWidth) >= 2));
    await mkdir('.tmp/check/reset-calendar', { recursive: true });
    await page.screenshot({ path: `.tmp/check/reset-calendar/${theme}-${width}.png`, fullPage: true });
  });
}
test('calendar clock ticks do not repeat live heading announcements or disturb date focus', async t => {
  const { page } = await open(t);
  await page.locator('#tab-calendar').click();
  await page.locator('[data-calendar-date="2026-10-04"]').focus();
  await page.evaluate(() => {
    globalThis.__calendarAnnouncements = 0;
    const observer = new MutationObserver(records => { __calendarAnnouncements += records.length; });
    for (const id of ['calendar-month', 'calendar-selected']) observer.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
  });
  await page.clock.runFor(5000);
  assert.equal(await page.evaluate(() => __calendarAnnouncements), 0);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.calendarDate), '2026-10-04');
});
