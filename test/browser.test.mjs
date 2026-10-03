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

async function openApp(t, { read, authState = 'chatgpt', sessionDelayMs = 0, context = browser, clockTime } = {}) {
  let reads = 0;
  const service = {
    status: async () => ({ connected: true, authState: typeof authState === 'function' ? authState() : authState, revision: 0, busy: false }),
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
  await page.goto(`${app.origin}/#${app.bootstrapToken}`);
  await page.waitForFunction(() => {
    const refresh = document.querySelector('#refresh');
    const count = document.querySelector('#count')?.textContent;
    const notice = document.querySelector('#notice');
    const completed = notice?.textContent === '조회가 완료되었습니다.' || notice?.dataset.kind === 'error';
    return refresh && !refresh.disabled && (count !== '—' || completed);
  });
  return page;
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
      const selectors = ['#refresh', '#notice', '#nearest', '#nearest-remaining', '#coverage', '.credit', '#usage-five-hour', '#usage-weekly', '#usage-status', '#recommendation', '#usage-alerts', '#usage-forecast', '#start-time-comparison'];
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
    assert.match(await page.locator('#coverage').innerText(), /1개|부분|조회/);
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
  });
}

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
  await page.waitForFunction(() => document.querySelector('#usage-five-hour .usage-percent')?.textContent === '—');
  assert.equal(await page.locator('#usage-five-hour progress').isVisible(), false);
  assert.match(await page.locator('#usage-five-hour .usage-reset').innerText(), /확인 불가/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === '로그인 필요');
  assert.equal(await page.locator('#usage-weekly .usage-percent').innerText(), '—');
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
  assert.equal(await page.locator('#forecast-five-hour .forecast-rate').innerText(), '—');
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
  await page.locator('#forecast-toggle').click();
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour .forecast-samples').textContent.includes('2건'));
  await page.clock.runFor(300000); await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'forecast');
  failed = true; await page.clock.runFor(300000);
  await page.waitForFunction(() => document.querySelector('#forecast-five-hour').dataset.state === 'stale');
  assert.equal(await page.locator('#forecast-five-hour .forecast-rate').innerText(), '—');
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
  assert.equal(await page.locator('#comparison-five-hour .comparison-time').innerText(), '—');
  assert.match(await page.locator('#comparison-queried-at').innerText(), /KST/);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#start-time-comparison').dataset.state === 'complete');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#start-time-comparison').dataset.state === 'not-ready');
  assert.equal(await page.locator('#comparison-queried-at').innerText(), '—');
  assert.equal(await page.locator('#comparison-five-hour .comparison-time').innerText(), '—');
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
  assert.equal(await page.locator('#comparison-five-hour .comparison-time').innerText(), '—');
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

test('empty, count-only, unavailable, refresh failure, and login-needed states render without overflow', async t => {
  if (skipWithoutBrowser(t)) return;
  const cases = [
    ['count-only', () => ({ ...longSnapshot, availableCount: 3, detailState: 'count-only', credits: [] }), '3'],
    ['zero', () => ({ ...longSnapshot, availableCount: 0, detailState: 'complete', credits: [] }), '0'],
    ['unavailable', () => ({ ...longSnapshot, availableCount: null, detailState: 'unavailable', credits: [] }), '—'],
    ['refresh-error', n => { if (n > 1) throw new AppError('TIMEOUT'); return structuredClone(longSnapshot); }, '5'],
    ['login-needed', () => { throw new AppError('LOGIN_REQUIRED'); }, '—'],
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
