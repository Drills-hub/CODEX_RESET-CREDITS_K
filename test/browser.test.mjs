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
};

async function openApp(t, { read, authState = 'chatgpt', sessionDelayMs = 0, context = browser } = {}) {
  let reads = 0;
  const service = {
    status: async () => ({ connected: true, authState, revision: 0, busy: false }),
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
      const selectors = ['#refresh', '#notice', '#nearest', '#nearest-remaining', '#coverage', '.credit'];
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
  });
}

test('waits for delayed session exchange and the initial credit read', async t => {
  if (skipWithoutBrowser(t)) return;
  const page = await openApp(t, { sessionDelayMs: 500 });
  assert.equal(await page.locator('#count').innerText(), '5');
  assert.equal(await page.locator('.credit').count(), 1);
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
