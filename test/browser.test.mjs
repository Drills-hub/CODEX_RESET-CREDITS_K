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

for (const width of widths) {
  test(`Chromium ${width}px: long partial data fits, focus is visible, screenshot captured`, async t => {
    if (skipWithoutBrowser(t)) return;
    const page = await openApp(t);
    await page.setViewportSize({ width, height: 950 });
    const geometry = await page.evaluate(() => {
      const selectors = ['#refresh', '#notice', '#nearest', '#nearest-remaining', '#usage-five-hour', '#usage-weekly', '#recommendation'];
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
        boxes,
        clipped: boxes.filter(box => box.scrollWidth > box.clientWidth).map(box => box.selector),
        overlaps,
      };
    });
    assert.ok(geometry.documentWidth <= geometry.viewportWidth, `horizontal overflow: ${geometry.documentWidth}px > ${geometry.viewportWidth}px`);
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
        id: active.id || active.closest('details')?.id,
        focusVisible: active.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineAlpha: context.getImageData(0, 0, 1, 1).data[3],
      };
    });
    assert.equal(focus.id, 'query-time-details');
    assert.equal(keyboardFocusIsVisible(focus), true, `keyboard focus must be visible: ${JSON.stringify(focus)}`);
    await page.screenshot({ path: join(outputDir, `long-partial-${width}.png`), fullPage: true });
    await selectTab(page, 'credits');
    assert.match(await page.locator('#coverage').innerText(), /1개|부분|조회/);
    assert.equal(await page.locator('.credit').count(), 1);
    if (width === 375 || width === 1280) {
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(outputDir, `credits-${width}.png`), fullPage: true });
      await selectTab(page, 'calendar');
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(outputDir, `calendar-${width}.png`), fullPage: true });
      await selectTab(page, 'alerts');
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(outputDir, `alerts-${width}.png`), fullPage: true });
    }
  });
}

test('dashboard tabs expose ARIA state, preserve query values, and follow browser history', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { entryPath: '/?source=desktop&tab=calendar' });
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(new URL(page.url()).searchParams.get('source'), 'desktop');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'calendar');
  const tabs = page.getByRole('tab');
  assert.equal(await tabs.count(), 3);
  assert.equal(await page.getByRole('tab', { name: '만료 캘린더' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-tab-panel="calendar"]').isVisible(), true);
  assert.equal(await page.locator('[data-tab-panel="credits"]').isVisible(), false);

  await page.getByRole('tab', { name: '만료 캘린더' }).press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '알림' }).getAttribute('aria-selected'), 'true');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'alerts');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-tab="calendar"]')?.getAttribute('aria-selected') === 'true');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'calendar');

  await page.getByRole('tab', { name: '만료 캘린더' }).press('End');
  assert.equal(await page.getByRole('tab', { name: '알림' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '알림' }).press('Home');
  assert.equal(await page.getByRole('tab', { name: '리셋 상세' }).getAttribute('aria-selected'), 'true');
});

test('invalid tab values normalize to credits without discarding other query values', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { entryPath: '/?source=desktop&tab=unknown' });
  const url = new URL(page.url());
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.get('source'), 'desktop');
  assert.equal(url.searchParams.get('tab'), 'credits');
  assert.equal(await page.getByRole('tab', { name: '리셋 상세' }).getAttribute('aria-selected'), 'true');
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
  await selectTab(page, 'calendar');
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
  await page.keyboard.press('Tab'); // Query time disclosure precedes refresh in DOM order.
  // Measure settled colors: refresh fades from its disabled to enabled colors over --motion-fast.
  await page.locator('#refresh').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
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
      buttonColor: button.color, buttonBackground: button.backgroundColor, disabled: document.querySelector('#refresh').disabled,
      focus: contrast(button.outlineColor, body.backgroundColor),
    };
  });
  assert.ok(ratios.body >= 4.5, `body contrast ${ratios.body}`);
  assert.ok(ratios.muted >= 4.5, `muted contrast ${ratios.muted}`);
  assert.ok(ratios.button >= 4.5, `button contrast ${ratios.button}`);
  assert.ok(ratios.focus >= 3, `focus contrast ${ratios.focus}`);
  await page.screenshot({ path: join(outputDir, `theme-${colorScheme}-375.png`), fullPage: true });
});

test('mobile controls meet target size and the dashboard grows naturally without overlapping tabs', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t);
  await page.setViewportSize({ width: 375, height: 950 });
  const layout = await page.evaluate(() => Object.fromEntries(['.page-header', '#main-status-card', '#dashboard-tabs'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return [selector, { top: rect.top, bottom: rect.bottom, height: rect.height }];
  })));
  assert.ok(layout['#dashboard-tabs'].top >= layout['#main-status-card'].bottom, `tabs must follow the naturally sized card: ${JSON.stringify(layout)}`);
  await selectTab(page, 'alerts');
  const sizes = await page.locator('#refresh, [role="tab"], #usage-alerts-toggle, #notifications-toggle').evaluateAll(elements => elements.map(element => ({ id: element.id, height: element.getBoundingClientRect().height })));
  for (const size of sizes) assert.ok(size.height >= 44, `${size.id} target height ${size.height}px`);
});

test('disabled refresh remains readable while a usage read is pending', async t => {
  if (skipWithoutBrowser(t)) return;
  let reads = 0, release;
  const page = await openApp(t, { read: () => ++reads === 1 ? structuredClone(longSnapshot)
    : new Promise(resolve => { release = () => resolve(structuredClone(longSnapshot)); }) });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#refresh').disabled);
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release, 'manual refresh should reach the pending usage read');
  const ratio = await page.locator('#refresh').evaluate(node => {
    const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const foreground = luminance(getComputedStyle(node).color);
    const background = luminance(getComputedStyle(node).backgroundColor);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  assert.ok(ratio >= 4.5, `disabled refresh contrast ${ratio}`);
  release(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
});

test('tab switches and refreshed values play short motion without blocking content', async t => {
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
  let reads = 0;
  const page = await openApp(t, { context, read: () => {
    const remainingPercent = reads++ === 0 ? 65 : 64;
    return { ...longSnapshot, usageWindows: [{ ...longSnapshot.usageWindows[0], remainingPercent, usedPercent: 100 - remainingPercent }, longSnapshot.usageWindows[1]] };
  } });
  await page.evaluate(() => { globalThis.__dashboardAnimationDurations = []; });
  await selectTab(page, 'calendar');
  // Panel enter (380ms) + indicator slide (400ms).
  assert.deepEqual((await page.evaluate(() => globalThis.__dashboardAnimationDurations)).sort(), [380, 400]);
  assert.ok(await page.locator('[data-tab-indicator]').evaluate(element => element.style.width !== '0px'));
  await page.evaluate(() => { globalThis.__dashboardAnimationDurations = []; });
  await page.locator('#refresh').click(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  // The value is final immediately; only the changed value is emphasized (440ms), not the unchanged recommendation.
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '64%');
  assert.equal((await page.evaluate(() => globalThis.__dashboardAnimationDurations)).filter(duration => duration === 440).length, 1);
});

test('usage dashboard renders percentages and reset times and preserves them on refresh failure', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { read: n => {
    if (n > 1) throw new AppError('TIMEOUT');
    return structuredClone(longSnapshot);
  } });
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  assert.equal(await page.locator('#usage-weekly .usage-percent').innerText(), '20%');
  await page.locator('#usage-five-hour-details summary').click();
  assert.match(await page.locator('#usage-five-hour .usage-reset-full').innerText(), /KST/);
  assert.equal(await page.locator('#usage-five-hour progress').getAttribute('value'), '65');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#notice').dataset.kind === 'error');
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  assert.match(await page.locator('#query-state').innerText(), /이전 조회 결과.*재조회 필요/);
  assert.equal(await page.locator('#usage-status').isVisible(), false);
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
  assert.equal(await page.locator('#usage-status').isVisible(), true);
  assert.match(await page.locator('#usage-status').innerText(), /일부 사용 한도 정보를 확인할 수 없습니다/);
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

test('delayed refresh suspends usage decisions while retaining the last dashboard values', async t => {
  if (skipWithoutBrowser(t)) return;
  let release;
  const page = await openApp(t, { read: n => n === 1 ? structuredClone(longSnapshot) : new Promise(resolve => { release = () => resolve(structuredClone(longSnapshot)); }) });
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'true');
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refreshing');
  assert.doesNotMatch(await page.locator('#recommendation').innerText(), /지금 사용 가능합니다|활용을 권장|잔여량을 활용하기 위한 권고/);
  assert.match(await page.locator('#query-state').innerText(), /재조회 중.*마지막 성공 결과/);
  assert.equal(await page.locator('#usage-status').isVisible(), false);
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  release();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.notEqual(await page.locator('#recommendation').getAttribute('data-code'), 'refreshing');
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

for (const tabCount of [2, 3]) test(`${tabCount} visible tabs share simultaneous manual reads without BUSY or stale results`, async t => {
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
  const before = reads; block = true;
  await Promise.all(pages.map(page => page.clock.runFor(300000)));
  await Promise.all(pages.map(page => page.locator('#refresh').click()));
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  for (const page of pages) assert.equal(await page.locator('body').getAttribute('data-loading'), 'true');
  release();
  for (const page of pages) {
    await page.waitForFunction(() => document.body.dataset.loading === 'false');
    assert.equal(await page.locator('#notice').getAttribute('data-kind'), 'info');
  }
  assert.equal(reads - before, 1);
});

test('manual refresh and another tab alert validation share one usage read', async t => {
  if (skipWithoutBrowser(t)) return;
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    globalThis.__usageNotices = [];
    const NativeChannel = BroadcastChannel;
    globalThis.BroadcastChannel = class extends NativeChannel {
      constructor(name) {
        super(name);
        if (name === 'reset-check.usage-read.channel.v1') this.addEventListener('message', ({ data }) => {
          if (data?.type === 'request') __usageReadRequestsReceived.push(data.id);
        });
      }
      postMessage(data) {
        if (this.name === 'reset-check.usage-read.channel.v1' && data?.type === 'request') __usageReadRequestsSent.push(data.id);
        return super.postMessage(data);
      }
    };
    globalThis.__usageReadRequestsSent = []; globalThis.__usageReadRequestsReceived = [];
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
  const postedBefore = await second.evaluate(() => __usageReadRequestsSent.length);
  const before = reads; block = true;
  await Promise.all([first.locator('#refresh').click(), second.locator('#usage-alerts-toggle').click()]);
  await second.waitForFunction(() => document.body.dataset.loading === 'true');
  await second.waitForFunction(count => __usageReadRequestsSent.length > count, postedBefore);
  const requestId = await second.evaluate(count => __usageReadRequestsSent[count], postedBefore);
  await first.waitForFunction(id => __usageReadRequestsReceived.includes(id), requestId);
  for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release); release();
  await first.waitForFunction(() => document.body.dataset.loading === 'false');
  await second.waitForFunction(() => __usageNotices.length === 1);
  assert.equal(reads - before, 1);
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
  const panels = ['usage-panel', 'recommendation', 'usage-alerts', 'expiry-calendar'];
  for (const id of panels) assert.equal(await page.locator(`#${id}`).getAttribute('aria-busy'), 'false');
  for (const id of ['notifications-toggle', 'usage-alerts-toggle']) {
    await selectTab(page, 'alerts');
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
