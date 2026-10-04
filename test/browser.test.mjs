import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../lib/http.mjs';
import { AppError } from '../lib/errors.mjs';

let chromium;
let playwrightError;
try { ({ chromium } = await import('playwright')); }
catch (error) { playwrightError = error; }

const widths = [320, 375, 640, 768, 1280];
const outputDir = process.env.VISUAL_QA_OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'limit-check-visual-qa-'));
await mkdir(outputDir, { recursive: true });
console.log(`Browser QA screenshots: ${outputDir}`);

const longSnapshot = {
  queriedAt: 1780000000, availableCount: 5, detailState: 'partial', revision: 0,
  credits: [{ number: 1, title: '긴 제목 '.repeat(28), status: 'available', grantedAt: 1770000000, expiresAt: 1781000000, expiryState: 'known' }],
  usageWindows: [
    { kind: 'five-hour', windowDurationMins: 300, usedPercent: 35, remainingPercent: 65, resetsAt: 4102444800, state: 'complete' },
    { kind: 'weekly', windowDurationMins: 10080, usedPercent: 80, remainingPercent: 20, resetsAt: 4102531200, state: 'complete' },
  ],
};

async function openApp(t, { read, authState = 'chatgpt', status, sessionDelayMs = 0, context = browser, clockTime, entryPath = '/' } = {}) {
  let reads = 0;
  const service = {
    status: async () => status ? status() : ({ connected: true, authState: typeof authState === 'function' ? authState() : authState, revision: 0, busy: false }),
    read: async () => {
      reads++;
      return read ? read(reads) : structuredClone(longSnapshot);
    },
  };
  const app = createApplication({ service });
  await app.listen();
  t.after(() => app.close());
  if (context.grantPermissions) await context.grantPermissions(['notifications'], { origin: app.origin });
  const page = await context.newPage();
  t.after(() => page.close());
  if (clockTime !== undefined) await page.clock.install({ time: new Date(clockTime) });
  if (sessionDelayMs) await page.route('**/api/session', async route => {
    await new Promise(resolve => setTimeout(resolve, sessionDelayMs));
    await route.continue();
  });
  const separator = entryPath.includes('?') ? '#' : '#';
  await page.goto(`${app.origin}${entryPath}${separator}${app.bootstrapToken}`);
  await page.waitForFunction(() => {
    const refresh = document.querySelector('#refresh');
    const count = document.querySelector('#count')?.textContent;
    const notice = document.querySelector('#notice');
    const completed = notice?.textContent === '조회가 완료되었습니다.' || notice?.dataset.kind === 'error';
    return refresh && !refresh.disabled && (count !== '확인 전' || completed);
  });
  return page;
}

async function selectTab(page, tabId) {
  await page.locator(`[role="tab"][data-tab="${tabId}"]`).click();
  await page.waitForFunction(id => document.querySelector(`[data-tab-panel="${id}"]`)?.hidden === false, tabId);
}

function keyboardFocusIsVisible(focus) {
  return focus.focusVisible && focus.outlineStyle !== 'none' && focus.outlineWidth >= 2 && focus.outlineAlpha > 0;
}

let browser;
let browserError = playwrightError;
test.before(async () => {
  if (browserError) return;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { browserError = error; }
});
test.after(async () => { await browser?.close(); });
function skipWithoutBrowser(t) {
  if (!browserError) return false;
  process.exitCode = 1;
  t.skip(`Chromium visual QA unavailable: ${browserError.message}`);
  return true;
}

const planAt = 1791072000;
const day = 86400;
function planSnapshot({ at = planAt, remaining = 80, revision = 0, accountScope = 'plan-account', five = 65, allowed = null } = {}) {
  return {
    queriedAt: at, availableCount: 2, detailState: 'complete', revision, accountScope, ordinaryUsageAllowed: allowed,
    credits: [1, 3].map((days, index) => ({ number: index + 1, title: `계획 리셋권 ${index + 1}`, status: 'available',
      grantedAt: planAt - day, expiresAt: planAt + days * day, expiryState: 'known', resetType: 'codexRateLimits' })),
    usageWindows: [
      { kind: 'five-hour', windowDurationMins: 300, usedPercent: 100 - five, remainingPercent: five, resetsAt: planAt + 8 * day, state: 'complete' },
      { kind: 'weekly', windowDurationMins: 10080, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: planAt + 7 * day, state: 'complete' },
    ],
  };
}
async function manualPlan(page, value = '40') {
  await selectTab(page, 'schedule');
  await page.locator('[name="usage-plan-rate-mode"][value="manual"]').check();
  await page.locator('#usage-plan-rate').fill(value);
}
async function planMetric(page, label) {
  return page.locator('#usage-plan-chart .usage-plan-metrics > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd').innerText();
}

test('usage plan manual rate connects real engine, main summary and conditional refill chart', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => planSnapshot() });
  assert.equal(await page.locator('#usage-plan-rate').isDisabled(), true);
  await manualPlan(page);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'credit-before-expiry');
  assert.match(await page.locator('#recommendation-reason').innerText(), /허용.*확인/);
  assert.match(await page.locator('#recommendation-reason').innerText(), /41\.6667%/);
  assert.doesNotMatch(await page.locator('#recommendation-reason').innerText(), /41\.666666/);
  assert.match(await planMetric(page, '목표 시점 예상 잔여량'), /41\.6667%/);
  assert.match(await page.locator('#usage-plan-leftover').innerText(), /41\.6667%/);
  assert.match(await planMetric(page, '첫 사용 검토부터 다음 안전 마감까지'), /48시간/);
  assert.match(await page.locator('#usage-plan-next-gap').innerText(), /48시간/);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /100%.*가정/);
  assert.equal(await page.locator('#usage-plan-chart [data-segment-kind="scenario"]').count(), 1);
  await manualPlan(page, '160');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'credit-after-depletion');
  assert.match(await page.locator('#recommendation-reason').innerText(), /소진.*재조회/);
  assert.match(await page.locator('#usage-plan-first-use').innerText(), /2026-10-04 21:00:00/);
  assert.match(await planMetric(page, '소모량 출처'), /직접 입력/);
});

test('usage plan manual invalid values suppress action, retain across tabs and restore auto', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => planSnapshot() });
  for (const value of ['', '0', '-1']) {
    await manualPlan(page, value);
    assert.equal(await page.locator('#usage-plan-rate').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#usage-plan-input-error').innerText(), /0보다 큰.*숫자/);
    assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
    assert.equal(await page.locator('#usage-plan-first-use').innerText(), '');
    assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'invalid-rate');
  }
  await manualPlan(page, '0.05');
  assert.equal(await page.locator('#usage-plan-rate').getAttribute('aria-invalid'), 'false');
  await selectTab(page, 'credits'); await selectTab(page, 'schedule');
  assert.equal(await page.locator('#usage-plan-rate').inputValue(), '0.05');
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#usage-plan-rate').inputValue(), '0.05');
  await manualPlan(page, '');
  await page.locator('[name="usage-plan-rate-mode"][value="auto"]').check();
  assert.equal(await page.locator('#usage-plan-input-error').innerText(), '');
  assert.equal(await page.locator('#usage-plan-rate').isDisabled(), true);
  assert.equal(await page.locator('#forecast-toggle').innerText(), '추세 켜기');
});

test('usage plan automatic rate follows opted-in forecast samples and opt-out without extra reads', async t => {
  if (skipWithoutBrowser(t)) return;
  let reads = 0;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => {
    const n = reads++;
    return planSnapshot({ at: planAt + n * 300, remaining: 80 - n });
  } });
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'credit-deadline');
  await selectTab(page, 'forecast'); await page.locator('#forecast-toggle').click();
  for (let n = 2; n <= 3; n++) {
    await page.clock.runFor(300000);
    await page.waitForFunction(n => document.querySelector('#forecast-weekly .forecast-samples').textContent.includes(`${n}건`), n);
  }
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'credit-after-depletion');
  await selectTab(page, 'schedule');
  assert.match(await planMetric(page, '예상 하루 소모량'), /288.*%p\/일/);
  assert.match(await planMetric(page, '소모량 출처'), /자동/);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /30분.*낙관/);
  await selectTab(page, 'forecast'); await page.locator('#forecast-toggle').click();
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'credit-deadline');
  await selectTab(page, 'schedule');
  assert.equal(await page.locator('#usage-plan-chart [data-segment-kind]').count(), 0);
  await page.clock.runFor(300000); assert.equal(reads, 3);
});

test('usage plan account boundaries erase inputs and hidden charts while transient failure pauses', async t => {
  if (skipWithoutBrowser(t)) return;
  let revision = 0; let scope = 'plan-account'; let auth = 'chatgpt'; let failed = false;
  const page = await openApp(t, { clockTime: planAt * 1000,
    status: () => ({ connected: true, authState: auth, revision, busy: false }),
    read: () => { if (failed) throw new AppError('UPSTREAM'); return planSnapshot({ revision, accountScope: scope }); } });
  await manualPlan(page);
  failed = true; await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#usage-plan-rate').inputValue(), '40');
  assert.match(await page.locator('#usage-weekly .usage-percent').innerText(), /80%/);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
  await manualPlan(page, '');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-input-error').innerText(), '');
  failed = false; await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await manualPlan(page); await selectTab(page, 'credits');
  revision = 1; await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelector('#usage-plan-rate').value === '');
  assert.equal(await page.locator('[name="usage-plan-rate-mode"][value="auto"]').isChecked(), true);
  assert.doesNotMatch(await page.locator('#usage-plan-chart').textContent(), /계획 리셋권|41\.6667/);
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await manualPlan(page); scope = 'new-scope';
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#usage-plan-rate').inputValue(), '');
  await manualPlan(page); await selectTab(page, 'credits'); auth = 'signed-out';
  await page.clock.runFor(5000); await page.waitForFunction(() => document.querySelector('#usage-plan-rate').value === '');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
});

test('usage plan revision and logout clear manual mode even before a first successful read', async t => {
  if (skipWithoutBrowser(t)) return;
  let revision = 0; let authState = 'chatgpt';
  const page = await openApp(t, { clockTime: planAt * 1000,
    status: () => ({ connected: true, authState, revision, busy: false }), read: () => { throw new AppError('UPSTREAM'); } });
  await manualPlan(page); revision = 1;
  await page.clock.runFor(5000); await page.waitForFunction(() => document.querySelector('#usage-plan-rate').value === '');
  await manualPlan(page); authState = 'unsupported';
  await page.clock.runFor(5000); await page.waitForFunction(() => document.querySelector('#usage-plan-rate').value === '');
  assert.equal(await page.locator('[name="usage-plan-rate-mode"][value="auto"]').isChecked(), true);
});

test('usage plan ticks preserve SVG nodes and announcements, boundaries requery without refill', async t => {
  if (skipWithoutBrowser(t)) return;
  const value = planSnapshot();
  value.credits[0].expiresAt = planAt + 3605;
  value.usageWindows[1].resetsAt = planAt + 3700;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => value });
  await manualPlan(page);
  await page.evaluate(() => {
    globalThis.__planSvg = document.querySelector('#usage-plan-chart svg');
    globalThis.__planMutations = 0;
    new MutationObserver(records => { globalThis.__planMutations += records.length; }).observe(document.querySelector('#usage-plan-chart'), { subtree: true, childList: true, characterData: true, attributes: true });
    globalThis.__planAnnouncements = 0;
    new MutationObserver(records => { globalThis.__planAnnouncements += records.length; }).observe(document.querySelector('#usage-announcement'), { childList: true });
  });
  await page.clock.runFor(3000);
  assert.equal(await page.evaluate(() => __planSvg === document.querySelector('#usage-plan-chart svg')), true);
  assert.equal(await page.evaluate(() => __planMutations), 0);
  assert.equal(await page.evaluate(() => __planAnnouncements), 0);
  await page.clock.runFor(3000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.match(await page.locator('#usage-plan-chart').innerText(), /마감.*재조회/);
  await page.clock.fastForward(3600000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.doesNotMatch(await page.locator('#usage-plan-first-use').innerText(), /2026-10-04 09:00:05/);
  await page.clock.fastForward(100000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.match(await page.locator('#usage-weekly .usage-percent').innerText(), /80%/);
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
});

test('usage plan predicted depletion pauses instead of restarting from the old balance', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => planSnapshot() });
  await manualPlan(page, '691200'); // 80 percentage points in ten seconds
  await page.clock.runFor(11000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
  assert.match(await page.locator('#usage-weekly .usage-percent').innerText(), /80%/);
});

test('usage plan newly entered rate suspends immediately when its snapshot estimate is already past', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => planSnapshot() });
  await page.clock.runFor(20000);
  await manualPlan(page, '691200');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
});

test('usage plan deadline continuity suspends old balance until a successful requery', async t => {
  if (skipWithoutBrowser(t)) return;
  let reads = 0;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => {
    reads++;
    return planSnapshot({ at: reads === 1 ? planAt : planAt + 82801, remaining: reads === 1 ? 80 : 42 });
  } });
  await manualPlan(page, '40');
  assert.match(await page.locator('#usage-plan-leftover').innerText(), /41\.6667%/);
  await page.clock.fastForward(82801000);
  assert.equal(reads, 1);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-leftover').innerText(), '');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
  assert.match(await page.locator('#usage-weekly .usage-percent').innerText(), /80%/);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /마감.*재조회/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(reads, 2);
  assert.match(await page.locator('#usage-plan-leftover').innerText(), /42%/);
  assert.match(await page.locator('#usage-weekly .usage-percent').innerText(), /42%/);
  assert.equal(await page.locator('#usage-plan-rate').inputValue(), '40');
});

test('usage plan extreme rate after deadline cannot resume an old actionable estimate', async t => {
  if (skipWithoutBrowser(t)) return;
  let reads = 0;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => { reads++; return planSnapshot(); } });
  await page.clock.fastForward(82801000);
  await manualPlan(page, '691200');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-first-use').innerText(), '');
  assert.equal(await page.locator('#usage-plan-leftover').innerText(), '');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
  assert.equal(reads, 1);
});

test('usage plan elapsed-depletion entry after a clock jump suspends without a timer tick', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { clockTime: planAt * 1000, read: () => planSnapshot() });
  await manualPlan(page, '40');
  await page.clock.setSystemTime(new Date((planAt + 82801) * 1000));
  await page.locator('#usage-plan-rate').fill('691200');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.locator('#usage-plan-chart svg:visible').count(), 0);
});

for (const theme of ['light', 'dark']) for (const width of [320, 375, 768, 1280]) {
  test(`usage plan ${theme} ${width}px actual feature capture and accessible controls`, async t => {
    if (skipWithoutBrowser(t)) return;
    const context = await browser.newContext({ colorScheme: theme, reducedMotion: 'reduce', viewport: { width, height: 950 } });
    t.after(() => context.close());
    const page = await openApp(t, { context, clockTime: planAt * 1000, read: () => planSnapshot() });
    await manualPlan(page);
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      controls: [...document.querySelectorAll('.usage-plan-rate-choice, #usage-plan-rate')].map(element => element.getBoundingClientRect().height),
      events: document.querySelectorAll('#usage-plan-chart .usage-plan-event-list li').length,
      markers: document.querySelectorAll('#usage-plan-chart [data-event-kind]').length,
      animations: document.getAnimations().filter(animation => animation.effect.getTiming().duration > 1).length,
    }));
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.controls.every(height => height >= 44));
    assert.equal(geometry.events, 5); assert.equal(geometry.markers, 5);
    assert.equal(geometry.animations, 0);
    await page.screenshot({ path: join(outputDir, `usage-plan-${theme}-${width}.png`), fullPage: true });
  });
}

for (const width of widths) {
  test(`Chromium ${width}px: long partial data fits, focus is visible, screenshot captured`, async t => {
    if (skipWithoutBrowser(t)) return;
    const page = await openApp(t);
    await page.setViewportSize({ width, height: 950 });
    const geometry = await page.evaluate(() => {
      const selectors = ['#refresh', '#notice', '#nearest', '#nearest-remaining', '#usage-five-hour', '#usage-weekly', '#recommendation', '#start-time-comparison'];
      const boxes = selectors.map(selector => {
        const element = document.querySelector(selector);
        const rect = element.getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      });
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]; const b = boxes[j];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push(`${a.selector}:${b.selector}`);
      }
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        caption: (() => { const rect = document.querySelector('.comparison caption').getBoundingClientRect(); return { width: rect.width, height: rect.height }; })(),
        boxes,
        clipped: boxes.filter(box => box.scrollWidth > box.clientWidth).map(box => box.selector),
        overlaps,
      };
    });
    assert.ok(geometry.documentWidth <= geometry.viewportWidth, `horizontal overflow: ${geometry.documentWidth}px > ${geometry.viewportWidth}px`);
    assert.ok(geometry.caption.width >= 200 && geometry.caption.height < 80, 'comparison caption must use the table width rather than wrapping one character per line');
    for (const box of geometry.boxes) assert.ok(box.left >= 0 && box.right <= width, `${box.selector} must fit viewport`);
    assert.deepEqual(geometry.clipped, [], `content must not be clipped: ${geometry.clipped.join(', ')}`);
    assert.deepEqual(geometry.overlaps, [], `content boxes must not overlap: ${geometry.overlaps.join(', ')}`);
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = style.outlineColor;
      context.fillRect(0, 0, 1, 1);
      return {
        id: active.id,
        focusVisible: active.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineAlpha: context.getImageData(0, 0, 1, 1).data[3],
      };
    });
    assert.equal(focus.id, 'refresh');
    assert.equal(keyboardFocusIsVisible(focus), true, `keyboard focus must be visible: ${JSON.stringify(focus)}`);
    await page.screenshot({ path: join(outputDir, `long-partial-${width}.png`), fullPage: true });
    await page.locator('#start-time-comparison').screenshot({ path: join(outputDir, `comparison-${width}.png`) });
    await selectTab(page, 'credits');
    assert.match(await page.locator('#coverage').innerText(), /1개|부분|조회/);
    assert.equal(await page.locator('.credit').count(), 1);
    if (width === 375 || width === 1280) {
      await page.waitForTimeout(240);
      await page.screenshot({ path: join(outputDir, `credits-${width}.png`), fullPage: true });
      await selectTab(page, 'forecast');
      await page.waitForTimeout(240);
      await page.screenshot({ path: join(outputDir, `forecast-${width}.png`), fullPage: true });
      await selectTab(page, 'alerts');
      await page.waitForTimeout(240);
      await page.screenshot({ path: join(outputDir, `alerts-${width}.png`), fullPage: true });
    }
  });
}

test('dashboard tabs expose ARIA state, preserve query values, and follow browser history', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { entryPath: '/?source=desktop&tab=forecast' });
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(new URL(page.url()).searchParams.get('source'), 'desktop');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'forecast');
  const tabs = page.getByRole('tab');
  assert.equal(await tabs.count(), 4);
  assert.equal(await page.getByRole('tab', { name: '사용 추세' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-tab-panel="forecast"]').isVisible(), true);
  assert.equal(await page.locator('[data-tab-panel="schedule"]').isVisible(), false);

  await page.getByRole('tab', { name: '사용 추세' }).press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '알림' }).getAttribute('aria-selected'), 'true');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'alerts');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-tab="forecast"]')?.getAttribute('aria-selected') === 'true');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'forecast');

  await page.getByRole('tab', { name: '사용 추세' }).press('End');
  assert.equal(await page.getByRole('tab', { name: '리셋 상세' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '리셋 상세' }).press('Home');
  assert.equal(await page.getByRole('tab', { name: '리셋 일정' }).getAttribute('aria-selected'), 'true');
});

test('invalid tab values normalize to schedule without discarding other query values', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { entryPath: '/?source=desktop&tab=unknown' });
  const url = new URL(page.url());
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.get('source'), 'desktop');
  assert.equal(url.searchParams.get('tab'), 'schedule');
  assert.equal(await page.getByRole('tab', { name: '리셋 일정' }).getAttribute('aria-selected'), 'true');
});

test('reduced motion disables dashboard Web Animations API effects', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  t.after(() => context.close());
  await context.addInitScript(() => {
    globalThis.__dashboardAnimations = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      globalThis.__dashboardAnimations++;
      return animate.apply(this, args);
    };
  });
  const page = await openApp(t, { context });
  await page.setViewportSize({ width: 375, height: 950 });
  await selectTab(page, 'forecast');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.evaluate(() => globalThis.__dashboardAnimations), 0);
});

for (const colorScheme of ['light', 'dark']) test(`${colorScheme} theme meets dashboard contrast targets`, async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext({ colorScheme });
  t.after(() => context.close());
  const page = await openApp(t, { context });
  await page.setViewportSize({ width: 375, height: 950 });
  await page.keyboard.press('Tab');
  const ratios = await page.evaluate(() => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255);
    const luminance = value => rgb(value).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const contrast = (foreground, background) => {
      const first = luminance(foreground); const second = luminance(background);
      return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    };
    const body = getComputedStyle(document.body);
    const muted = getComputedStyle(document.querySelector('.muted'));
    const button = getComputedStyle(document.querySelector('#refresh'));
    return {
      body: contrast(body.color, body.backgroundColor),
      muted: contrast(muted.color, body.backgroundColor),
      button: contrast(button.color, button.backgroundColor),
      focus: contrast(button.outlineColor, body.backgroundColor),
    };
  });
  assert.ok(ratios.body >= 4.5, `body contrast ${ratios.body}`);
  assert.ok(ratios.muted >= 4.5, `muted contrast ${ratios.muted}`);
  assert.ok(ratios.button >= 4.5, `button contrast ${ratios.button}`);
  assert.ok(ratios.focus >= 3, `focus contrast ${ratios.focus}`);
  await page.screenshot({ path: join(outputDir, `theme-${colorScheme}-375.png`), fullPage: true });
});

test('mobile controls meet target size and the primary dashboard fits the first viewport', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t);
  await page.setViewportSize({ width: 375, height: 950 });
  const layout = await page.evaluate(() => Object.fromEntries(['.page-header', '#main-status-card', '#dashboard-tabs'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return [selector, { top: rect.top, bottom: rect.bottom, height: rect.height }];
  })));
  assert.ok(layout['#dashboard-tabs'].bottom <= 950, `dashboard tabs should be visible in the first viewport: ${JSON.stringify(layout)}`);
  await selectTab(page, 'alerts');
  const sizes = await page.locator('#refresh, [role="tab"], #usage-alerts-toggle, #notifications-toggle').evaluateAll(elements => elements.map(element => ({ id: element.id, height: element.getBoundingClientRect().height })));
  for (const size of sizes) assert.ok(size.height >= 44, `${size.id} target height ${size.height}px`);
});

test('tab and refreshed-value changes use the approved state animations', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  t.after(() => context.close());
  await context.addInitScript(() => {
    globalThis.__dashboardAnimationDurations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      globalThis.__dashboardAnimationDurations.push(options?.duration);
      return animate.call(this, keyframes, options);
    };
  });
  const page = await openApp(t, { context });
  await page.evaluate(() => { globalThis.__dashboardAnimationDurations = []; });
  await selectTab(page, 'forecast');
  const durations = await page.evaluate(() => globalThis.__dashboardAnimationDurations);
  assert.ok(durations.includes(180), `tab indicator durations: ${durations}`);
  assert.ok(durations.includes(200), `panel durations: ${durations}`);
});

test('usage dashboard renders percentages and reset times and preserves them on refresh failure', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { read: n => {
    if (n > 1) throw new AppError('TIMEOUT');
    return structuredClone(longSnapshot);
  } });
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  assert.equal(await page.locator('#usage-weekly .usage-percent').innerText(), '20%');
  assert.match(await page.locator('#usage-five-hour .usage-reset').innerText(), /KST/);
  assert.equal(await page.locator('#usage-five-hour progress').getAttribute('value'), '65');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#notice').dataset.kind === 'error');
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  assert.match(await page.locator('#usage-status').innerText(), /이전 조회|재조회/);
});

test('missing usage and login changes clear the dashboard without inventing zero percent', async t => {
  if (skipWithoutBrowser(t)) return;
  let signedOut = false;
  const page = await openApp(t, { read: n => {
    if (n === 3) { signedOut = true; throw new AppError('LOGIN_REQUIRED'); }
    return n === 1 ? structuredClone(longSnapshot) : { ...longSnapshot, usageWindows: undefined };
  }, authState: () => signedOut ? 'signed-out' : 'chatgpt' });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#usage-five-hour .usage-percent')?.textContent === '확인 불가');
  assert.equal(await page.locator('#usage-five-hour progress').isVisible(), false);
  assert.match(await page.locator('#usage-five-hour .usage-reset').innerText(), /확인 불가/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '로그인 필요');
  assert.equal(await page.locator('#usage-weekly .usage-percent').innerText(), '확인 전');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'not-ready');
});

test('usage countdown crosses reset without locally replenishing the percentage', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000);
  const page = await openApp(t, { clockTime: at * 1000, read: () => ({ ...longSnapshot, usageWindows: [
    { ...longSnapshot.usageWindows[0], remainingPercent: 0, usedPercent: 100, resetsAt: at + 60 },
    longSnapshot.usageWindows[1],
  ] }) });
  await page.clock.fastForward(61000);
  assert.match(await page.locator('#usage-five-hour .usage-remaining').innerText(), /리셋 시각 경과.*새로고침/);
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '0%');
});

test('server usage restriction remains visible after a reset or failed refresh', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { read: n => {
    if (n > 1) throw new AppError('TIMEOUT');
    return { ...longSnapshot, ordinaryUsageAllowed: false, usageWindows: [
      { ...longSnapshot.usageWindows[0], resetsAt: 1 }, longSnapshot.usageWindows[1],
    ] };
  } });
  assert.match(await page.locator('#usage-status').innerText(), /서버.*일반 사용.*제한/);
  assert.match(await page.locator('#usage-status').innerText(), /재조회/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#notice').dataset.kind === 'error');
  assert.match(await page.locator('#usage-status').innerText(), /서버.*일반 사용.*제한/);
  assert.match(await page.locator('#usage-status').innerText(), /이전 조회/);
});

test('timing recommendation shows its reason and query time and stays paused after failed refresh', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000);
  const page = await openApp(t, { read: n => {
    if (n === 2) throw new AppError('TIMEOUT');
    return { ...longSnapshot, queriedAt: at, usageWindows: [
      { ...longSnapshot.usageWindows[0], resetsAt: at + 3600 },
      { ...longSnapshot.usageWindows[1], resetsAt: at + 86400 },
    ] };
  } });
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'weekly-reset');
  assert.match(await page.locator('#recommendation-reason').innerText(), /20%/);
  assert.match(await page.locator('#recommendation-queried-at').innerText(), /KST/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#notice').dataset.kind === 'error');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.doesNotMatch(await page.locator('#recommendation').innerText(), /잔여량을 활용하기 위한 권고/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#recommendation')?.dataset.code === 'weekly-reset');
});

test('timing recommendation becomes requery guidance when a reset passes', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000);
  const page = await openApp(t, { clockTime: at * 1000, read: () => ({ ...longSnapshot, queriedAt: at, usageWindows: [
    { ...longSnapshot.usageWindows[0], resetsAt: at + 60 },
    { ...longSnapshot.usageWindows[1], resetsAt: at + 172800 },
  ] }) });
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'weekly-budget');
  await page.clock.fastForward(61000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.doesNotMatch(await page.locator('#recommendation').innerText(), /잔여량을 활용하기 위한 권고/);
});

test('usage alert opt-in validates low allowance, persists, and avoids reload duplicates', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    globalThis.__usageNotices = [];
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function (title, options) { __usageNotices.push({ title, ...options }); },
      { permission: 'granted', requestPermission: async () => 'granted' }) });
  });
  let reads = 0;
  const page = await openApp(t, { context, read: () => {
    reads++; return { ...longSnapshot, accountScope: 'synthetic-digest', usageWindows: [longSnapshot.usageWindows[1]] };
  } });
  assert.equal(reads, 1);
  await selectTab(page, 'alerts');
  await page.locator('#usage-alerts-toggle').click();
  await page.waitForFunction(() => __usageNotices.length === 1);
  assert.equal(reads, 2);
  assert.match((await page.evaluate(() => __usageNotices[0])).body, /20%/);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#usage-alerts-toggle').textContent === '사용량 알림 끄기');
  assert.equal(await page.evaluate(() => __usageNotices.length), 0);
  await page.locator('#usage-alerts-toggle').click();
  assert.equal(await page.locator('#usage-alerts-toggle').innerText(), '사용량 알림 켜기');
});

test('usage reset alert uses a real requery and never promises restored permission', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    globalThis.__usageNotices = [];
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function (title, options) { __usageNotices.push({ title, ...options }); },
      { permission: 'granted', requestPermission: async () => 'granted' }) });
  });
  const at = Math.floor(Date.now() / 1000); let reads = 0;
  const page = await openApp(t, { context, clockTime: at * 1000, read: () => ({ ...longSnapshot, accountScope: 'synthetic-digest', ordinaryUsageAllowed: false,
    usageWindows: [{ ...longSnapshot.usageWindows[0], resetsAt: ++reads < 3 ? at + 60 : at + 18000 }],
  }) });
  await selectTab(page, 'alerts');
  await page.locator('#usage-alerts-toggle').click(); await page.clock.runFor(10);
  await page.waitForFunction(() => __usageNotices.length === 1);
  await page.clock.runFor(60000);
  await page.waitForFunction(() => __usageNotices.some(row => /갱신이 확인/.test(row.body)));
  const resetNotice = await page.evaluate(() => __usageNotices.find(row => /갱신이 확인/.test(row.body)));
  assert.doesNotMatch(resetNotice.body, /사용 가능/);
  assert.equal(reads, 3);
});

test('forecast opt-in polls at five minutes, derives rates, and clears after opt-out or reload', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let reads = 0;
  const page = await openApp(t, { clockTime: at * 1000, read: () => {
    const n = reads++;
    return { ...longSnapshot, queriedAt: at + n * 300, accountScope: 'forecast-account', usageWindows: [
      { ...longSnapshot.usageWindows[0], remainingPercent: 100 - n * 10, usedPercent: n * 10, resetsAt: at + 18000 },
      { ...longSnapshot.usageWindows[1], remainingPercent: 50 - n, usedPercent: 50 + n, resetsAt: at + 604800 },
    ] };
  } });
  assert.equal(reads, 1);
  await selectTab(page, 'forecast');
  await page.locator('#forecast-toggle').click();
  assert.match(await page.locator('#forecast-five-hour .forecast-samples').innerText(), /1건/);
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour .forecast-samples').textContent.includes('2건'));
  assert.equal(reads, 2);
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'forecast');
  assert.equal(reads, 3);
  assert.match(await page.locator('#forecast-five-hour .forecast-rate').innerText(), /120\.0%p/);
  assert.match(await page.locator('#forecast-weekly .forecast-rate').innerText(), /12\.0%p/);
  assert.match(await page.locator('#forecast-five-hour .forecast-exhaustion').innerText(), /KST/);
  await page.locator('#forecast-toggle').click();
  assert.equal(await page.locator('#forecast-five-hour .forecast-rate').innerText(), '계산 전');
  await page.clock.runFor(300000); assert.equal(reads, 3);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#forecast-toggle')?.textContent === '추세 켜기');
  assert.match(await page.locator('#forecast-five-hour .forecast-samples').innerText(), /0건/);
});

test('forecast hides stale extrapolation after failed polling and recovers on a successful read', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let reads = 0; let failed = false;
  const page = await openApp(t, { clockTime: at * 1000, read: () => {
    reads++;
    if (failed) throw new AppError('TIMEOUT');
    return { ...longSnapshot, queriedAt: at + (reads - 1) * 300, accountScope: 'forecast-account', usageWindows: [
      { ...longSnapshot.usageWindows[0], remainingPercent: 100 - (reads - 1) * 10, resetsAt: at + 18000 },
    ] };
  } });
  await selectTab(page, 'forecast');
  await page.locator('#forecast-toggle').click();
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour .forecast-samples').textContent.includes('2건'));
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'forecast');
  failed = true; await page.clock.runFor(300000);
  await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'stale');
  assert.equal(await page.locator('#forecast-five-hour .forecast-rate').innerText(), '계산 전');
  failed = false; await page.clock.runFor(300000);
  await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'forecast');
});

test('forecast auto-retries after the first usage read fails despite ongoing empty status polls', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let reads = 0;
  const page = await openApp(t, { clockTime: at * 1000, read: () => {
    if (++reads === 1) throw new AppError('TIMEOUT');
    return { ...longSnapshot, queriedAt: at + 300, accountScope: 'forecast-account', usageWindows: [
      { ...longSnapshot.usageWindows[0], resetsAt: at + 18000 },
    ] };
  } });
  await selectTab(page, 'forecast');
  await page.locator('#forecast-toggle').click();
  await page.clock.runFor(300000);
  await page.waitForFunction(() => document.querySelector('#forecast-five-hour .forecast-samples').textContent.includes('1건'));
  assert.equal(reads, 2);
});

test('start-time comparison displays three options and the weekly bottleneck without future refill claims', async t => {
  if (skipWithoutBrowser(t)) return;
  let reads = 0;
  const page = await openApp(t, { read: () => { reads++; return { ...longSnapshot, ordinaryUsageAllowed: true, usageWindows: [
    longSnapshot.usageWindows[0], { ...longSnapshot.usageWindows[1], remainingPercent: 0, usedPercent: 100 },
  ] }; } });
  assert.equal(await page.locator('#start-time-comparison tbody tr').count(), 3);
  assert.equal(await page.locator('#comparison-now').getAttribute('data-state'), 'exhausted');
  assert.equal(await page.locator('#comparison-five-hour').getAttribute('data-state'), 'remaining-limit');
  assert.match(await page.locator('#comparison-five-hour .comparison-message').innerText(), /주간.*0%/);
  assert.match(await page.locator('#comparison-five-hour .comparison-time').innerText(), /KST/);
  assert.match(await page.locator('#comparison-weekly .comparison-resets').innerText(), /5시간.*주간/);
  assert.doesNotMatch(await page.locator('#comparison-weekly').innerText(), /100%|사용 가능/);
  assert.equal(reads, 1, 'comparison must not issue an additional usage read');
  await page.setViewportSize({ width: 375, height: 950 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(outputDir, 'comparison-depleted-375.png'), fullPage: true });
});

test('comparison suspends after a failed refresh, recovers, and clears on logout', async t => {
  if (skipWithoutBrowser(t)) return;
  let signedOut = false;
  const page = await openApp(t, { authState: () => signedOut ? 'signed-out' : 'chatgpt', read: n => {
    if (n === 2) throw new AppError('TIMEOUT');
    if (n === 4) { signedOut = true; throw new AppError('LOGIN_REQUIRED'); }
    return structuredClone(longSnapshot);
  } });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#start-time-comparison').dataset.state === 'refresh-needed');
  assert.equal(await page.locator('#comparison-five-hour .comparison-time').innerText(), '확인 불가');
  assert.match(await page.locator('#comparison-queried-at').innerText(), /KST/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#start-time-comparison').dataset.state === 'complete');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#start-time-comparison').dataset.state === 'not-ready');
  assert.equal(await page.locator('#comparison-queried-at').innerText(), '확인 전');
  assert.equal(await page.locator('#comparison-five-hour .comparison-time').innerText(), '확인 불가');
});

test('comparison requires fresh reset times at the reset boundary instead of advancing by five hours', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let reads = 0;
  const page = await openApp(t, { clockTime: at * 1000, read: () => { reads++; return { ...longSnapshot, queriedAt: at, usageWindows: [
    { ...longSnapshot.usageWindows[0], resetsAt: at + 60 }, { ...longSnapshot.usageWindows[1], resetsAt: at + 86400 },
  ] }; } });
  assert.equal(await page.locator('#start-time-comparison').getAttribute('data-state'), 'complete');
  await page.clock.runFor(61000);
  assert.equal(await page.locator('#start-time-comparison').getAttribute('data-state'), 'refresh-needed');
  assert.equal(await page.locator('#comparison-five-hour .comparison-time').innerText(), '확인 불가');
  assert.equal(reads, 1);
});

test('delayed refresh suspends usage decisions while retaining the last dashboard values', async t => {
  if (skipWithoutBrowser(t)) return;
  let release;
  const page = await openApp(t, { read: n => n === 1 ? structuredClone(longSnapshot) : new Promise(resolve => { release = () => resolve(structuredClone(longSnapshot)); }) });
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'true');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refreshing');
  assert.equal(await page.locator('#start-time-comparison').getAttribute('data-state'), 'refreshing');
  assert.doesNotMatch(await page.locator('#recommendation').innerText(), /지금 사용 가능합니다|활용을 권장|잔여량을 활용하기 위한 권고/);
  assert.match(await page.locator('#usage-status').innerText(), /재조회 중.*마지막 성공 결과/);
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  release();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.notEqual(await page.locator('#recommendation').getAttribute('data-code'), 'refreshing');
  assert.equal(await page.locator('#start-time-comparison').getAttribute('data-state'), 'complete');
});

test('waits for delayed session exchange and the initial credit read', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { sessionDelayMs: 500 });
  assert.equal(await page.locator('#count').innerText(), '5');
  assert.equal(await page.locator('.credit').count(), 1);
});

test('initial markup stays neutral while the session exchange is pending', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    globalThis.__initialRecommendationDisclaimer = document.querySelector('#recommendation-disclaimer')?.textContent;
  }));
  const page = await openApp(t, { context, sessionDelayMs: 500 });
  const initial = await page.evaluate(() => __initialRecommendationDisclaimer);
  assert.doesNotMatch(initial, /잔여량을 활용하기 위한 권고/);
  assert.match(initial, /조회.*안내/);
});

for (const tabCount of [2, 3]) test(`${tabCount} visible tabs share simultaneous forecast reads without BUSY or stale results`, async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  const at = Math.floor(Date.now() / 1000); let reads = 0; let active = false; let block = false; let release;
  const result = () => ({ ...longSnapshot, queriedAt: block ? at + 300 : at, accountScope: 'shared-scope' });
  const first = await openApp(t, { context, clockTime: at * 1000, read: async () => {
    if (active) throw new AppError('BUSY');
    reads++; active = true;
    try { if (block) await new Promise(resolve => { release = resolve; }); return result(); }
    finally { active = false; }
  } });
  const pages = [first];
  for (let index = 1; index < tabCount; index++) {
    const page = await context.newPage(); pages.push(page); t.after(() => page.close());
    await page.clock.install({ time: new Date(at * 1000) }); await page.goto(first.url());
    await page.waitForFunction(() => document.querySelector('#notice').textContent === '조회가 완료되었습니다.');
  }
  await Promise.all(pages.map(page => selectTab(page, 'forecast')));
  await Promise.all(pages.map(page => page.locator('#forecast-toggle').click()));
  const before = reads; block = true;
  await Promise.all(pages.map(page => page.clock.runFor(300000)));
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  for (const page of pages) assert.equal(await page.locator('body').getAttribute('data-loading'), 'true');
  release();
  for (const page of pages) {
    await page.waitForFunction(() => document.body.dataset.loading === 'false');
    assert.match(await page.locator('#forecast-five-hour .forecast-samples').innerText(), /2건/);
    assert.notEqual(await page.locator('#forecast-five-hour').getAttribute('data-state'), 'stale');
    assert.equal(await page.locator('#notice').getAttribute('data-kind'), 'info');
  }
  assert.equal(reads - before, 1);
});

test('manual refresh and another tab alert validation share one usage read', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    globalThis.__usageNotices = [];
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function (title, options) { __usageNotices.push({ title, ...options }); },
      { permission: 'granted', requestPermission: async () => 'granted' }) });
  });
  let reads = 0; let block = false; let release;
  const first = await openApp(t, { context, read: async () => {
    reads++; if (block) await new Promise(resolve => { release = resolve; });
    return { ...longSnapshot, accountScope: 'shared-scope', usageWindows: [{ ...longSnapshot.usageWindows[0], remainingPercent: 10, usedPercent: 90 }] };
  } });
  const second = await context.newPage(); t.after(() => second.close()); await second.goto(first.url());
  await second.waitForFunction(() => document.querySelector('#notice').textContent === '조회가 완료되었습니다.');
  await selectTab(second, 'alerts');
  // Keep the first client manual-only while the second validates a notification.
  await first.evaluate(() => { Notification.permission = 'denied'; });
  const before = reads; block = true;
  await Promise.all([first.locator('#refresh').click(), second.locator('#usage-alerts-toggle').click()]);
  await second.waitForFunction(() => document.body.dataset.loading === 'true');
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release); release();
  await first.waitForFunction(() => document.body.dataset.loading === 'false');
  await second.waitForFunction(() => __usageNotices.length === 1);
  assert.equal(reads - before, 1);
});

test('BFCache transitions preserve forecasts while real page exit clears them', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let reads = 0;
  const page = await openApp(t, { clockTime: at * 1000, read: () => {
    const index = reads++;
    return { ...longSnapshot, queriedAt: at + Math.min(index, 2) * 300, accountScope: 'bfcache-scope', usageWindows: [
      { ...longSnapshot.usageWindows[0], remainingPercent: 100 - index * 10, resetsAt: at + 18000 },
    ] };
  } });
  await selectTab(page, 'forecast');
  await page.locator('#forecast-toggle').click();
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour .forecast-samples').textContent.includes('2건'));
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'forecast');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.locator('#forecast-toggle').innerText(), '추세 끄기');
  assert.match(await page.locator('#forecast-five-hour .forecast-samples').innerText(), /3건/);
  const before = reads;
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => document.body.dataset.loading === 'false' && document.querySelector('#notice').dataset.kind === 'info');
  assert.equal(reads, before + 1);
  assert.equal(await page.locator('#forecast-toggle').innerText(), '추세 끄기');
  assert.match(await page.locator('#forecast-five-hour .forecast-samples').innerText(), /3건/);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  assert.equal(await page.locator('#forecast-toggle').innerText(), '추세 켜기');
  assert.match(await page.locator('#forecast-five-hour .forecast-samples').innerText(), /0건/);
});

test('BFCache restoration discards the prior in-flight response and performs a fresh read', async t => {
  if (skipWithoutBrowser(t)) return;
  let reads = 0; let release;
  const page = await openApp(t, { read: () => {
    reads++;
    if (reads === 2) return new Promise(resolve => { release = () => resolve({ ...longSnapshot, usageWindows: [
      { ...longSnapshot.usageWindows[0], remainingPercent: 1 }, longSnapshot.usageWindows[1],
    ] }); });
    return structuredClone(longSnapshot);
  } });
  await page.locator('#refresh').click();
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  release();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(reads, 3);
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
});

test('usage panels expose busy and pressed state and live summaries without repeated clock announcements', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function () {}, { permission: 'granted', requestPermission: async () => 'granted' }) });
  });
  const at = Math.floor(Date.now() / 1000); let release;
  const value = { ...longSnapshot, queriedAt: at, accountScope: 'accessible-scope', ordinaryUsageAllowed: true, usageWindows: [
    { ...longSnapshot.usageWindows[0], resetsAt: at + 7200 },
    { ...longSnapshot.usageWindows[1], remainingPercent: 50, usedPercent: 50, resetsAt: at + 172800 },
  ] };
  const page = await openApp(t, { context, clockTime: at * 1000, read: n => {
    if (n === 2) return new Promise(resolve => { release = () => resolve(value); });
    if (n === 3) throw new AppError('TIMEOUT');
    return value;
  } });
  const live = page.locator('#usage-announcement');
  assert.equal(await live.getAttribute('role'), 'status'); assert.equal(await live.getAttribute('aria-live'), 'polite'); assert.equal(await live.getAttribute('aria-atomic'), 'true');
  assert.match(await live.textContent(), /조회 완료.*65%.*50%/);
  const panels = ['usage-panel', 'recommendation', 'start-time-comparison', 'usage-alerts', 'usage-forecast'];
  for (const id of panels) assert.equal(await page.locator(`#${id}`).getAttribute('aria-busy'), 'false');
  for (const id of ['notifications-toggle', 'usage-alerts-toggle', 'forecast-toggle']) {
    await selectTab(page, id === 'forecast-toggle' ? 'forecast' : 'alerts');
    const toggle = page.locator(`#${id}`); assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await toggle.click(); await page.waitForFunction(id => document.getElementById(id).getAttribute('aria-pressed') === 'true', id);
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  }
  await page.evaluate(() => {
    globalThis.__liveMutations = 0;
    const observer = new MutationObserver(records => { __liveMutations += records.length; });
    observer.observe(document.getElementById('usage-announcement'), { childList: true, subtree: true, characterData: true });
    observer.observe(document.getElementById('notice'), { childList: true, subtree: true, characterData: true });
  });
  await page.clock.runFor(6000);
  assert.equal(await page.evaluate(() => __liveMutations), 0);
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'true');
  for (const id of panels) assert.equal(await page.locator(`#${id}`).getAttribute('aria-busy'), 'true');
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release); release(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  for (const id of panels) assert.equal(await page.locator(`#${id}`).getAttribute('aria-busy'), 'false');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#usage-announcement').textContent.includes('이전 결과'));
});

test('reset and account boundaries announce once and clear old usage summaries', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let signedOut = false;
  const page = await openApp(t, { clockTime: at * 1000, authState: () => signedOut ? 'signed-out' : 'chatgpt', read: n => {
    if (n > 1) { signedOut = true; throw new AppError('LOGIN_REQUIRED'); }
    return { ...longSnapshot, queriedAt: at, usageWindows: [
      { ...longSnapshot.usageWindows[0], resetsAt: at + 60 }, longSnapshot.usageWindows[1],
    ] };
  } });
  await page.clock.runFor(61000);
  assert.match(await page.locator('#usage-announcement').textContent(), /리셋 시각이 지났/);
  await page.evaluate(() => {
    globalThis.__boundaryMutations = 0;
    new MutationObserver(records => { __boundaryMutations += records.length; }).observe(document.getElementById('usage-announcement'), { childList: true });
  });
  await page.clock.runFor(3000); assert.equal(await page.evaluate(() => __boundaryMutations), 0);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#usage-announcement').textContent.includes('계정 상태가 변경'));
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '확인 전');
});

test('forecast readiness and failure are announced on their state boundaries', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let reads = 0;
  const page = await openApp(t, { clockTime: at * 1000, read: () => {
    const index = reads++;
    if (index === 3) throw new AppError('TIMEOUT');
    return { ...longSnapshot, queriedAt: at + index * 300, accountScope: 'forecast-announcement', usageWindows: [
      { ...longSnapshot.usageWindows[0], remainingPercent: 100 - index * 10, resetsAt: at + 18000 },
    ] };
  } });
  await selectTab(page, 'forecast');
  await page.locator('#forecast-toggle').click();
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour .forecast-samples').textContent.includes('2건'));
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#usage-announcement').textContent.includes('예상 소진 시각'));
  assert.match(await page.locator('#usage-announcement').textContent(), /5시간 추세/);
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'stale');
  assert.match(await page.locator('#usage-announcement').textContent(), /추세.*조회에 실패.*보류/);
});

test('notification storage failure is announced without raw errors or a pressed toggle', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function () {}, { permission: 'granted', requestPermission: async () => 'granted' }) });
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'reset-check.usage-alerts.enabled.v1') throw new Error('PRIVATE_WRITE_ERROR');
      return write.call(this, key, value);
    };
  });
  const page = await openApp(t, { context, read: () => ({ ...longSnapshot, accountScope: 'error-scope' }) });
  await selectTab(page, 'alerts');
  await page.locator('#usage-alerts-toggle').click();
  await page.waitForFunction(() => document.querySelector('#usage-announcement').textContent.includes('사용량 알림:'));
  assert.match(await page.locator('#usage-announcement').textContent(), /저장소/);
  assert.doesNotMatch(await page.locator('#usage-announcement').textContent(), /PRIVATE/);
  assert.equal(await page.locator('#usage-alerts-toggle').getAttribute('aria-pressed'), 'false');
});

test('a reset reached during a delayed read is announced after that read finishes', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000); let release;
  const value = { ...longSnapshot, queriedAt: at, usageWindows: [
    { ...longSnapshot.usageWindows[0], resetsAt: at + 5 }, longSnapshot.usageWindows[1],
  ] };
  const page = await openApp(t, { clockTime: at * 1000, read: n => n === 1 ? value : new Promise(resolve => { release = () => resolve(value); }) });
  await page.locator('#refresh').click();
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release); await page.clock.runFor(6000); release();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.match(await page.locator('#usage-announcement').textContent(), /리셋 시각이 지났/);
});

test('missing crypto disables notifications with an explicit accessible reason', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined }); });
  const page = await openApp(t, { context });
  assert.equal(await page.locator('#notifications-toggle').isDisabled(), true);
  assert.equal(await page.locator('#notifications-toggle').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#notifications-status').innerText(), /암호화/);
});

test('an enabled expiry reminder shows delivery errors in both visible and live status', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function () { throw new Error('PRIVATE_NOTIFICATION_ERROR'); },
      { permission: 'granted', requestPermission: async () => 'granted' }) });
  });
  const at = Math.floor(Date.now() / 1000);
  const page = await openApp(t, { context, clockTime: at * 1000, read: () => ({ ...longSnapshot, queriedAt: at, accountScope: 'reminder-scope', credits: [
    { ...longSnapshot.credits[0], reminderKey: 'synthetic-key', grantedAt: at - 100, expiresAt: at + 3601 },
  ] }) });
  await selectTab(page, 'alerts');
  await page.locator('#notifications-toggle').click();
  await page.clock.runFor(2000);
  await page.waitForFunction(() => document.querySelector('#usage-announcement').textContent.includes('만료 알림:'));
  assert.match(await page.locator('#notifications-status').innerText(), /확인하지 못/);
  assert.doesNotMatch(await page.locator('#notifications-status').innerText(), /알림이 켜졌습니다/);
  assert.doesNotMatch(await page.locator('#usage-announcement').textContent(), /PRIVATE/);
  assert.equal(await page.locator('#notifications-toggle').getAttribute('aria-pressed'), 'true');
});

test('a successful read replacing the account announces that boundary once', async t => {
  if (skipWithoutBrowser(t)) return;
  const at = Math.floor(Date.now() / 1000);
  const page = await openApp(t, { read: n => ({ ...longSnapshot, queriedAt: at, revision: n === 1 ? 0 : 1,
    accountScope: n === 1 ? 'scope-a' : 'scope-b', ordinaryUsageAllowed: true, usageWindows: [
      { ...longSnapshot.usageWindows[0], remainingPercent: n === 1 ? 65 : 30, usedPercent: n === 1 ? 35 : 70 },
      { ...longSnapshot.usageWindows[1], remainingPercent: 50, usedPercent: 50 },
    ],
  }) });
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.match(await page.locator('#usage-announcement').textContent(), /계정 상태가 변경.*조회 완료.*30%/);
  assert.doesNotMatch(await page.locator('#usage-announcement').textContent(), /scope-a|scope-b/);
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.doesNotMatch(await page.locator('#usage-announcement').textContent(), /계정 상태가 변경/);
});

test('empty, count-only, unavailable, refresh failure, and login-needed states render without overflow', async t => {
  if (skipWithoutBrowser(t)) return;
  const cases = [
    ['count-only', () => ({ ...longSnapshot, availableCount: 3, detailState: 'count-only', credits: [] }), '3'],
    ['zero', () => ({ ...longSnapshot, availableCount: 0, detailState: 'complete', credits: [] }), '0'],
    ['unavailable', () => ({ ...longSnapshot, availableCount: null, detailState: 'unavailable', credits: [] }), '확인 불가'],
    ['refresh-error', n => { if (n > 1) throw new AppError('TIMEOUT'); return structuredClone(longSnapshot); }, '5'],
    ['login-needed', () => { throw new AppError('LOGIN_REQUIRED'); }, '확인 전'],
  ];
  for (const [name, read, expected] of cases) {
    await t.test(name, async st => {
      const page = await openApp(st, { read, authState: name === 'login-needed' ? 'signed-out' : 'chatgpt' });
      await page.setViewportSize({ width: 375, height: 950 });
      if (name === 'refresh-error') {
        await page.getByRole('button', { name: /새로고침/ }).click();
        await page.getByRole('status').filter({ hasText: '완료하지 못했습니다' }).waitFor();
      } else if (name === 'login-needed') {
        await page.getByRole('status').filter({ hasText: '로그인이 필요합니다' }).waitFor();
      } else if (name === 'unavailable') {
        assert.equal(await page.locator('#notice').innerText(), '조회가 완료되었습니다.');
        assert.match(await page.locator('#coverage').innerText(), /이 계정에서 리셋권 정보를 확인할 수 없습니다/);
      }
      assert.equal(await page.locator('#count').innerText(), expected);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false, `${name} state overflows horizontally`);
      await page.screenshot({ path: join(outputDir, `${name}-375.png`), fullPage: true });
    });
  }
});

test('focus alpha check rejects transparent CSS Color formats', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await browser.newPage();
  t.after(() => page.close());
  const alphas = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    return ['transparent', 'rgba(0, 0, 0, 0)', 'color(srgb 0 0 0 / 0)', 'oklch(0.5 0.1 120 / 0)'].map(color => {
      if (!CSS.supports('color', color)) throw new Error(`unsupported test color ${color}`);
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
  });
  assert.deepEqual(alphas, [0, 0, 0, 0]);
  for (const outlineAlpha of alphas) {
    assert.equal(keyboardFocusIsVisible({ focusVisible: true, outlineStyle: 'solid', outlineWidth: 3, outlineAlpha }), false);
  }
});

test('browser notification opt-in persists across reload in the same context', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    class TestNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title, options) {
        globalThis.__resetCheckNotifications ??= [];
        globalThis.__resetCheckNotifications.push({ title, options });
      }
    }
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: TestNotification });
  });
  const page = await openApp(t, { context });
  await selectTab(page, 'alerts');
  const toggle = page.getByRole('button', { name: '알림 켜기', exact: true });
  assert.equal(await toggle.isDisabled(), false);
  await toggle.click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#notifications-toggle').innerText(), '알림 끄기');
  await page.getByRole('button', { name: '알림 끄기', exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#count')?.textContent === '5');
  await page.getByRole('button', { name: '알림 끄기', exact: true }).waitFor();
});

test('real browser Web Locks serialize two tabs and a shared opt-out cancels delivery', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext();
  t.after(() => context.close());
  let reads = 0;
  const credit = { ...longSnapshot.credits[0], title: 'synthetic', reminderKey: 'test-stable-key', expiresAt: 100 * 3600 };
  const value = { ...longSnapshot, credits: [credit], accountScope: 'synthetic-scope' };
  const first = await openApp(t, { context, read: async () => {
    reads++;
    return structuredClone(value);
  } });
  const second = await context.newPage();
  await second.goto(first.url());
  await second.waitForFunction(() => document.querySelector('#count')?.textContent === '5');
  const prepare = async page => page.evaluate(async value => {
    const { createReminderController } = await import('/notifications.mjs');
    globalThis.__at = 75 * 3600000;
    globalThis.__notices = [];
    globalThis.__timers = [];
    const Notification = Object.assign(function (title, options) { __notices.push({ title, options }); }, { permission: 'granted' });
    globalThis.__controller = createReminderController({
      storage: localStorage, locks: navigator.locks, Notification,
      now: () => __at,
      setTimeout: (fn, delay) => { const timer = { fn, delay }; __timers.push(timer); return timer; },
      clearTimeout: timer => { timer.cancelled = true; },
      refresh: async () => {
        const response = await fetch('/api/reset-credits/read', {
          method: 'POST', headers: { 'X-Reset-Check': '1', 'Content-Type': 'application/json' }, body: '{}',
        });
        return response.ok ? response.json() : null;
      },
    });
    __controller.update(value);
    await __controller.requestEnable();
  }, value);
  await prepare(first); await prepare(second);
  const before = reads;
  await Promise.all([first, second].map(page => page.evaluate(async () => {
    __at = 76 * 3600000;
    await __timers.find(timer => !timer.cancelled).fn();
  })));
  assert.equal(reads - before, 1);
  assert.equal(await first.evaluate(() => __notices.length) + await second.evaluate(() => __notices.length), 1);
  await first.evaluate(() => __controller.disable());
  await second.evaluate(async () => {
    __at = 99 * 3600000;
    await __timers.find(timer => !timer.cancelled).fn();
  });
  assert.equal(reads - before, 1);
  assert.equal(await first.evaluate(() => __notices.length) + await second.evaluate(() => __notices.length), 1);
});

test('notification preference restores after the browser context closes with persistent cookies only', async t => {
  if (skipWithoutBrowser(t)) return;
  const installNotification = async context => context.addInitScript(() => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Object.assign(function () {}, {
      permission: 'granted', requestPermission: async () => 'granted',
    }) });
  });
  const firstContext = await browser.newContext();
  t.after(() => firstContext.close());
  await installNotification(firstContext);
  const first = await openApp(t, { context: firstContext });
  await selectTab(first, 'alerts');
  await first.getByRole('button', { name: '알림 켜기', exact: true }).click();
  await first.getByRole('button', { name: '알림 끄기', exact: true }).waitFor();
  const url = first.url();
  const saved = await firstContext.storageState();
  saved.cookies = saved.cookies.filter(cookie => cookie.expires > Date.now() / 1000);
  assert.equal(saved.cookies.length, 1, 'local authentication must survive browser shutdown');
  await firstContext.close();
  const resumedContext = await browser.newContext({ storageState: saved });
  t.after(() => resumedContext.close());
  await installNotification(resumedContext);
  const resumed = await resumedContext.newPage();
  await resumed.goto(url);
  await resumed.getByRole('button', { name: '알림 끄기', exact: true }).waitFor();
  assert.equal(await resumed.locator('#count').innerText(), '5');
});
