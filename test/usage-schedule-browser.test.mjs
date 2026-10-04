import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApplication } from '../lib/http.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const at = 1791072000;
const hour = 3600;
const fixture = () => ({ queriedAt: at, accountScope: 'schedule-fixture', revision: 0, ordinaryUsageAllowed: true,
  availableCount: 2, detailState: 'complete', credits: [
    { number: 1, title: '첫 리셋권', status: 'available', resetType: 'codexRateLimits', expiryState: 'known', expiresAt: at + 12 * hour },
    { number: 2, title: '다음 리셋권', status: 'available', resetType: 'codexRateLimits', expiryState: 'known', expiresAt: at + 48 * hour },
  ], usageWindows: [
    { kind: 'five-hour', windowDurationMins: 300, state: 'complete', usedPercent: 14, remainingPercent: 86, resetsAt: at + 5 * hour },
    { kind: 'weekly', windowDurationMins: 10080, state: 'complete', usedPercent: 18, remainingPercent: 82, resetsAt: at + 7 * 86400 },
  ] });
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
async function open(t, { read = fixture, status, width = 375, colorScheme = 'light' } = {}) {
  const app = createApplication({ service: { status: async () => status?.() ?? ({ connected: true, authState: 'chatgpt', revision: 0 }), read } });
  await app.listen(); t.after(() => app.close());
  const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme, reducedMotion: 'reduce' });
  t.after(() => context.close()); const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'UI event handlers must not throw'));
  await page.clock.install({ time: new Date(at * 1000) });
  await page.goto(`${app.origin}/#${app.bootstrapToken}`);
  await page.waitForFunction(() => document.querySelector('#count').textContent === '2');
  return page;
}
async function addSlot(page, start, end, accessOnly = false) {
  await page.locator('#work-slot-start').fill(start); await page.locator('#work-slot-end').fill(end);
  await page.locator('#work-slot-access-only').setChecked(accessOnly);
  await page.locator('#work-slot-add').click();
}

test('work-aware editor distinguishes access-only time, validates KST and preserves simple mode', async t => {
  const page = await open(t);
  assert.equal(await page.locator('#work-plan-enabled').count(), 1);
  assert.equal(await page.locator('#work-plan-enabled').isChecked(), false);
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T13:00', '2026-10-04T12:00');
  assert.match(await page.locator('#work-plan-error').innerText(), /종료|시작/);
  assert.equal(await page.locator('#work-slots li').count(), 0);
  await addSlot(page, '2026-10-04T10:00', '2026-10-04T13:00');
  await addSlot(page, '2026-10-05T10:00', '2026-10-05T13:00');
  await addSlot(page, '2026-10-04T19:30', '2026-10-04T20:00', true);
  assert.equal(await page.locator('#work-slots li').count(), 3);
  assert.match(await page.locator('#work-slots').innerText(), /확인만/);
  await page.locator('#work-hour-rate').fill('10');
  await page.waitForFunction(() => document.querySelector('#usage-plan-chart [data-schedule-state]')?.dataset.scheduleState === 'ready');
  assert.match(await page.locator('#usage-plan-chart').innerText(), /권장.*구간/);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /느림/);
  assert.equal(await page.locator('#usage-plan-rate').isDisabled(), true);
  await page.getByRole('tab', { name: '알림', exact: true }).click();
  await page.getByRole('tab', { name: '리셋 일정', exact: true }).click();
  assert.equal(await page.locator('#work-slots li').count(), 3);
  await page.locator('#work-plan-enabled').uncheck();
  assert.equal(await page.locator('#usage-plan-chart [data-schedule-state]').count(), 0);
  assert.equal(await page.locator('#work-hour-rate').inputValue(), '10');
});

test('marked-work automatic samples do not reuse calendar rates or add polling, and reset on new session', async t => {
  let reads = 0;
  const page = await open(t, { read: () => {
    const result = fixture(); const n = reads++;
    result.queriedAt = at + n * 300;
    result.usageWindows[0].remainingPercent = 86 - n * 6;
    result.usageWindows[1].remainingPercent = 82 - n;
    return result;
  } });
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T11:00', '2026-10-04T13:00');
  await addSlot(page, '2026-10-05T10:00', '2026-10-05T13:00');
  await page.locator('[name="work-rate-mode"][value="auto"]').check();
  assert.equal(reads, 1);
  assert.doesNotMatch(await page.locator('#work-rate-status').innerText(), /주간 12/);
  await page.locator('#work-active').check();
  for (let n = 1; n <= 3; n++) {
    await page.clock.fastForward(300000);
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.body.dataset.loading === 'false');
  }
  assert.equal(reads, 4);
  assert.match(await page.locator('#work-rate-status').innerText(), /주간 12 .*작업시간/);
  assert.equal(await page.locator('#work-hour-rate').isDisabled(), true);
  await page.locator('#work-active').uncheck();
  assert.doesNotMatch(await page.locator('#work-rate-status').innerText(), /주간 12/);
  assert.equal(await page.locator('#usage-plan-chart [data-schedule-state]').getAttribute('data-schedule-state'), 'incomplete');
});

test('invalid work rate suspends charts, and logout clears hidden schedules and work measurements', async t => {
  let authState = 'chatgpt';
  const page = await open(t, { status: () => ({ connected: true, authState, revision: authState === 'chatgpt' ? 0 : 1 }) });
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T10:00', '2026-10-04T13:00');
  await page.locator('#work-hour-rate').fill('10');
  await page.locator('#work-hour-rate').fill('0');
  assert.match(await page.locator('#work-plan-error').innerText(), /0보다 큰/);
  assert.equal(await page.locator('#usage-plan-chart .usage-plan-estimate').count(), 0);
  await page.getByRole('tab', { name: '알림', exact: true }).click();
  authState = 'signed-out';
  await page.clock.runFor(5100);
  await page.waitForFunction(() => !document.querySelector('#work-plan-enabled').checked);
  assert.equal(await page.locator('#work-slots li').count(), 0);
  assert.equal(await page.locator('#work-hour-rate').inputValue(), '');
  assert.equal(await page.locator('#usage-plan-chart [data-schedule-state]').count(), 0);
});

test('an inaccessible first credit does not prevent planning rescue of the second credit', async t => {
  const page = await open(t);
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-05T10:00', '2026-10-05T13:00');
  await page.locator('#work-hour-rate').fill('10');
  assert.match(await page.locator('#recommendation').innerText(), /2번.*권장/);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /1개/);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /다음 리셋권 검토/);
});

test('enabling work mode after a credit deadline requires requery even when a later credit has access', async t => {
  const page = await open(t, { read: () => {
    const result = fixture(); result.credits[0].expiresAt = at + 2 * hour; return result;
  } });
  await page.clock.fastForward(3601000);
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T12:00', '2026-10-04T13:00');
  await addSlot(page, '2026-10-05T10:00', '2026-10-05T13:00');
  await page.locator('#work-hour-rate').fill('10');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart .usage-plan-estimate, #usage-plan-chart .usage-plan-scenario').count(), 0);
});

test('work mode preserves the future-query clock guard instead of masking it with the reference time', async t => {
  const page = await open(t, { read: () => { const result = fixture(); result.queriedAt = at + 60; return result; } });
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T10:00', '2026-10-04T13:00');
  await page.locator('#work-hour-rate').fill('10');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart .usage-plan-estimate, #usage-plan-chart .usage-plan-scenario').count(), 0);
});

for (const kind of ['weekly', 'five-hour']) test(`work mode requires requery when the current ${kind} budget is projected depleted`, async t => {
  const page = await open(t, { read: () => {
    const result = fixture(); result.credits[0].resetType = 'unknown';
    result.usageWindows.find(row => row.kind === kind).remainingPercent = 10; return result;
  } });
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T09:00', '2026-10-04T13:00');
  await page.locator('#work-hour-rate').fill('20');
  if (kind === 'five-hour') await page.locator('#work-five-rate').fill('40');
  await page.clock.fastForward((kind === 'weekly' ? 1801 : 901) * 1000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart .usage-plan-estimate, #usage-plan-chart .usage-plan-scenario').count(), 0);
});

test('changing a work rate before a timer runs cannot discard an elapsed review boundary', async t => {
  const page = await open(t, { read: () => { const result = fixture(); result.usageWindows[1].remainingPercent = 50; return result; } });
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T09:00', '2026-10-04T17:00');
  await page.locator('#work-hour-rate').fill('20');
  await page.clock.setFixedTime(new Date((at + 9360) * 1000));
  await page.locator('#work-hour-rate').fill('10');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  await page.locator('#work-hour-rate').fill('1');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
});

test('simple and work modes share snapshot requery state until a successful new read', async t => {
  let reads = 0;
  const page = await open(t, { read: () => { const result = fixture(); result.usageWindows[1].remainingPercent = 10;
    result.queriedAt = reads++ ? at + 1801 : at; return result; } });
  await page.locator('[name="usage-plan-rate-mode"][value="manual"]').check();
  await page.locator('#usage-plan-rate').fill('480');
  await page.clock.fastForward(1801000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  await page.locator('#work-plan-enabled').check();
  await addSlot(page, '2026-10-04T10:00', '2026-10-04T13:00');
  await page.locator('#work-hour-rate').fill('10');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#usage-plan-chart [data-schedule-state]').getAttribute('data-schedule-state'), 'ready');
});

for (const colorScheme of ['light', 'dark']) for (const width of [320, 375, 768, 1280]) {
  test(`work-aware ${colorScheme} ${width}px: recommendation window and work-band charts fit`, async t => {
    const page = await open(t, { colorScheme, width });
    await page.locator('#work-plan-enabled').check();
    await addSlot(page, '2026-10-04T10:00', '2026-10-04T13:00');
    await addSlot(page, '2026-10-05T10:00', '2026-10-05T13:00');
    await page.locator('#work-hour-rate').fill('10');
    await page.waitForFunction(() => document.querySelector('[data-schedule-state]')?.dataset.scheduleState === 'ready');
    await page.evaluate(() => scrollTo(0, 0));
    const geometry = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
      tabsBottom: document.querySelector('#dashboard-tabs').getBoundingClientRect().bottom,
      touch: [...document.querySelectorAll('#work-slot-add, .work-input-grid input, #work-plan-enabled')].map(element => element.closest('label')?.getBoundingClientRect().height ?? element.getBoundingClientRect().height),
    }));
    assert.ok(geometry.width <= geometry.viewport, JSON.stringify(geometry));
    if (width === 375) assert.ok(geometry.tabsBottom <= 950, `work-aware first viewport ${geometry.tabsBottom}`);
    assert.ok(geometry.touch.every(height => height >= 44), JSON.stringify(geometry.touch));
    assert.ok(await page.locator('.work-band').count() > 0);
    const output = process.env.VISUAL_QA_OUTPUT_DIR ?? '.tmp/check/screenshots-work-schedule';
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, `work-schedule-${colorScheme}-${width}.png`), fullPage: true });
    assert.match(await page.locator('#recommendation').innerText(), /권장.*구간/);
  });
}
