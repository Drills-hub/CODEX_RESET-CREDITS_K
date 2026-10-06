import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../lib/http.mjs';
import { AppError } from '../lib/errors.mjs';

const N = 1791072000, H = 3600, D = 86400;
const outputDir = process.env.VISUAL_QA_OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'limit-check-readability-qa-'));
const screenshotDir = join(outputDir, 'readability-ui-ux');
await mkdir(screenshotDir, { recursive: true });
const fixture = () => ({ queriedAt: N, accountScope: 'readability-account', revision: 0, availableCount: 2, detailState: 'complete', ordinaryUsageAllowed: true,
  credits: [{ number: 1, title: '첫 리셋권', status: 'available', resetType: 'codexRateLimits', grantedAt: N - D, expiresAt: N + 12.5 * H, expiryState: 'known' },
    { number: 2, title: '다음 리셋권', status: 'available', resetType: 'codexRateLimits', grantedAt: N - D, expiresAt: N + 3 * D, expiryState: 'known' }],
  usageWindows: [{ kind: 'five-hour', windowDurationMins: 300, state: 'complete', usedPercent: 35, remainingPercent: 65, resetsAt: N + 5 * H },
    { kind: 'weekly', windowDurationMins: 10080, state: 'complete', usedPercent: 20, remainingPercent: 80, resetsAt: N + 7 * D }] });
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
async function open(t, { read = fixture, status, width = 375, theme = 'light', now = N, wait = true } = {}) {
  let reads = 0;
  const app = createApplication({ service: { read: () => read(++reads), status: () => status?.() ?? { connected: true, authState: 'chatgpt', revision: 0 } } });
  await app.listen(); t.after(() => app.close());
  const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  t.after(() => assert.deepEqual(errors, [], 'UI handlers must not throw'));
  await page.clock.install({ time: new Date(now * 1000) });
  await page.goto(`${app.origin}/#${app.bootstrapToken}`);
  if (wait) await page.waitForFunction(() => document.body.dataset.loading === 'false' && document.querySelector('#notice').textContent !== 'Codex 계정에 연결하고 있습니다.');
  return { page, reads: () => reads };
}
async function refresh(page) {
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
}

test('summary shares the exact minute deadline while keeping detailed reasoning in one progressive-disclosure block', async t => {
  const { page } = await open(t);
  assert.equal(await page.locator('#recommendation-title').innerText(), '20시 사용을 추천합니다.');
  assert.equal(await page.locator('#recommendation-target').innerText(), '오늘 20:30');
  assert.equal(await page.locator('#recommendation-reason').innerText(), '현재 한도를 가능한 만큼 사용한 뒤 권장 마감에 확인하세요.');
  assert.equal(await page.locator('#reset-recommendation').count(), 0);
  assert.equal(await page.getByRole('tab').count(), 3);
  assert.equal(await page.locator('#recommendation-details').count(), 1);
  await page.locator('#recommendation-details summary').click();
  assert.match(await page.locator('#recommendation-detail-reason').innerText(), /권장 마감: 2026-10-04 20:30:00/);
  assert.match(await page.locator('#recommendation-details').innerText(), /대상 리셋권/);
  assert.equal(await page.locator('#recommendation-queried-at').count(), 0);
  assert.equal(await page.locator('#display-timezone').innerText(), '모든 시각은 KST');
});
test('official usage guidance stays collapsed, preserves its state on refresh, and does not trigger reads', async t => {
  const { page, reads } = await open(t);
  const guide = page.locator('#usage-rules');
  assert.equal(await guide.count(), 1);
  assert.equal(await guide.getAttribute('open'), null);
  const links = await guide.locator('a').evaluateAll(nodes => nodes.map(node => ({
    href: node.href, target: node.target, rel: node.rel,
  })));
  assert.deepEqual(links, [
    { href: 'https://learn.chatgpt.com/docs/pricing', target: '_blank', rel: 'noopener noreferrer' },
    { href: 'https://learn.chatgpt.com/docs/sign-in-with-chatgpt', target: '_blank', rel: 'noopener noreferrer' },
  ]);
  assert.equal(await page.locator('#query-state').evaluate(node => node.classList.contains('sr-only')), true);
  assert.equal(await page.locator('#usage-status').isVisible(), false);
  await guide.locator('summary').press('Enter');
  assert.equal(await guide.getAttribute('open'), '');
  assert.match(await guide.innerText(), /ChatGPT Work/);
  assert.match(await guide.innerText(), /사용 크레딧과는 다릅니다/);
  await page.screenshot({ path: join(screenshotDir, 'usage-rules-open-light-375.png'), fullPage: true });
  await page.clock.runFor(5000);
  assert.equal(reads(), 1);
  await refresh(page);
  assert.equal(reads(), 2);
  assert.equal(await guide.getAttribute('open'), '');
});
test('notification descriptions stay before their controls on mobile and beside them on desktop', async t => {
  const { page } = await open(t, { width: 1280 });
  await page.locator('#tab-alerts').click();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 950 });
    const layout = await page.locator('#panel-alerts .notifications').evaluateAll(sections => sections.map(section => {
      const copy = section.querySelector('.notification-copy');
      const button = section.querySelector('button');
      const text = section.querySelector('p');
      if (!copy || !button || !text) return null;
      const copyBox = copy.getBoundingClientRect(), buttonBox = button.getBoundingClientRect();
      return { textBeforeButton: Boolean(text.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
        copyRight: copyBox.right, copyBottom: copyBox.bottom, buttonLeft: buttonBox.left, buttonTop: buttonBox.top };
    }));
    assert.equal(layout.length, 2);
    for (const item of layout) {
      assert.ok(item, 'notification title and explanation should share a copy region');
      assert.equal(item.textBeforeButton, true);
      if (width >= 768) assert.ok(item.buttonLeft > item.copyRight, `desktop button should sit right of explanation: ${JSON.stringify(item)}`);
      else assert.ok(item.buttonTop >= item.copyBottom, `mobile button should follow explanation: ${JSON.stringify(item)}`);
    }
  }
});
test('full reset and query timestamps remain keyboard accessible and preserve label/value semantics', async t => {
  const { page } = await open(t);
  assert.equal(await page.locator('#usage-five-hour .usage-reset').innerText(), '오늘 14:00');
  for (const id of ['usage-five-hour-details', 'usage-weekly-details', 'query-time-details']) {
    assert.equal(await page.locator(`#${id}`).count(), 1);
    const summary = page.locator(`#${id} summary`); await summary.focus(); await summary.press('Enter');
    assert.equal(await page.locator(`#${id}`).getAttribute('open'), '');
    assert.match(await page.locator(`#${id}`).innerText(), /2026-10-\d{2} \d{2}:00:00 KST \(UTC\+09:00\)/);
  }
  await page.locator('#tab-credits').click();
  const pairs = await page.locator('.credit').first().locator('dt').evaluateAll(nodes => nodes.map(n => [n.textContent, n.nextElementSibling.textContent]));
  assert.ok(pairs.some(([label, value]) => label === '지급 시각' && value.includes('2026-10-03')));
  assert.equal(pairs.some(([label]) => label === '상태'), false);
  assert.equal(await page.locator('.credit').first().locator('.badge').innerText(), '사용 가능');
  assert.equal(await page.locator('.credit').first().locator('.badge').getAttribute('role'), 'img');
  assert.equal(await page.locator('.credit').first().locator('.badge').getAttribute('aria-label'), '리셋권 상태: 사용 가능');
});
test('partial coverage and unknown expiry remain visible in both recommendation surfaces', async t => {
  const { page } = await open(t, { read: () => ({ ...fixture(), detailState: 'partial', credits: [...fixture().credits, { number: 3, status: 'available', expiryState: 'unknown' }] }) });
  for (const id of ['recommendation-scope-note']) {
    assert.equal(await page.locator(`#${id}`).count(), 1);
    assert.equal(await page.locator(`#${id}`).isVisible(), true);
    assert.equal(await page.locator(`#${id}`).innerText(), '조회된 항목 기준 · 일부 만료 시각 확인 불가');
  }
});
test('a successful read after the safety deadline labels the past deadline without replacing it with now', async t => {
  const { page } = await open(t, { now: N + 12 * H, read: () => ({ ...fixture(), queriedAt: N + 12 * H, usageWindows: fixture().usageWindows.map(w => ({ ...w, resetsAt: N + D })) }) });
  assert.equal(await page.locator('#recommendation-title').innerText(), '지금 사용을 추천합니다.');
  assert.match(await page.locator('#recommendation-target').innerText(), /권장 마감 경과: 오늘 20:30/);
  assert.doesNotMatch(await page.locator('#recommendation-target').innerText(), /21:00/);
});
test('query state separates first loading, first failure, previous data and successful recovery', async t => {
  let rejectRead;
  const { page } = await open(t, { wait: false, read: n => n === 1 ? new Promise((_, reject) => { rejectRead = reject; }) : n === 3 ? Promise.reject(new AppError('TIMEOUT')) : fixture() });
  await page.waitForFunction(() => document.body.dataset.loading === 'true');
  assert.equal(await page.locator('#query-state').count(), 1);
  assert.match(await page.locator('#query-state').innerText(), /최초 조회 중/);
  for (let i = 0; !rejectRead && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  rejectRead(new AppError('TIMEOUT'));
  await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.match(await page.locator('#query-state').innerText(), /조회 실패/);
  await refresh(page); assert.equal(await page.locator('#query-state').evaluate(node => node.classList.contains('sr-only')), true);
  await refresh(page); assert.match(await page.locator('#query-state').innerText(), /이전 조회 결과/);
  assert.equal(await page.locator('.recommendation-timing').isVisible(), false);
  assert.equal(await page.locator('#usage-five-hour .usage-percent').innerText(), '65%');
  await refresh(page); assert.match(await page.locator('#recommendation-target').innerText(), /오늘 20:30/);
});
test('zero credits, missing information, restriction and logout keep different meanings', async t => {
  let signedOut = false;
  const { page } = await open(t, { read: n => n === 1 ? fixture() : n === 2 ? { ...fixture(), availableCount: 0, credits: [] } : n === 3 ? { ...fixture(), detailState: 'unavailable', availableCount: null, credits: [] } : { ...fixture(), ordinaryUsageAllowed: false },
    status: () => ({ connected: true, authState: signedOut ? 'signed-out' : 'chatgpt', revision: signedOut ? 1 : 0 }) });
  await refresh(page); assert.equal(await page.locator('#count').innerText(), '0');
  assert.equal(await page.locator('.recommendation-timing').isVisible(), false);
  await refresh(page); assert.equal(await page.locator('#count').innerText(), '확인 불가');
  await refresh(page); assert.match(await page.locator('#recommendation-title').innerText(), /일반 사용을 제한/);
  assert.match(await page.locator('#recommendation-reason').innerText(), /사용 허용 여부/);
  assert.equal(await page.locator('#recommendation').getAttribute('data-tone'), 'error');
  signedOut = true; await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelector('#count').textContent === '확인 전');
  assert.equal(await page.locator('.recommendation-timing').isVisible(), false);
  assert.equal(await page.locator('.credit').count(), 0);
});

for (const theme of ['light', 'dark']) test(`readability layout ${theme} preserves hierarchy, breakpoints and usable targets`, async t => {
  const { page } = await open(t, { theme, read: () => ({ ...fixture(), credits: fixture().credits.map(c => ({ ...c, title: '긴 제목 '.repeat(24) })) }) });
  for (const width of [320, 375, 640, 767, 768, 1023, 1024, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    await page.waitForFunction(width => innerWidth === width, width);
    await page.clock.runFor(20);
    const sizes = await page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { h1: parseFloat(style('h1').fontSize), balance: parseFloat(style('.usage-percent').fontSize),
        heading: parseFloat(style('#recommendation-title').fontSize), body: parseFloat(style('#recommendation-reason').fontSize),
        time: parseFloat(style('#recommendation-target').fontSize), between: parseFloat(style('#usage-weekly').paddingLeft),
        fullTimeLine: parseFloat(style('.usage-reset-full').lineHeight), fullTimerLine: parseFloat(style('.usage-remaining-full').lineHeight),
        metaLine: parseFloat(style('.recommendation-meta').lineHeight), noteLine: parseFloat(style('.calendar-note').lineHeight),
        usage: rect('#usage-panel'), recommendation: rect('#recommendation'), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(sizes.h1, width < 768 ? 24 : 28, `${width}px page title`);
    assert.equal(sizes.balance, width < 768 ? 32 : 40);
    assert.equal(sizes.heading, 20); assert.equal(sizes.body, 16); assert.equal(sizes.time, 18); assert.equal(sizes.between, 0);
    assert.equal(sizes.fullTimeLine, 21); assert.equal(sizes.fullTimerLine, 21); assert.equal(sizes.metaLine, 21); assert.equal(sizes.noteLine, 21);
    assert.equal(sizes.overflow, false);
    if (width >= 1024) { assert.ok(Math.abs(sizes.usage.top - sizes.recommendation.top) < 1); assert.ok(sizes.usage.width > sizes.recommendation.width); }
    else assert.ok(sizes.recommendation.top >= sizes.usage.bottom);
    if (width === 375 || width === 1280) await page.screenshot({ path: join(screenshotDir, `summary-${theme}-${width}.png`), fullPage: true });
    await page.locator('#tab-calendar').click();
    const calendar = await page.evaluate(() => {
      const rect = id => document.getElementById(id)?.getBoundingClientRect().toJSON();
      const buttons = [...document.querySelectorAll('button')].filter(n => n.getClientRects().length);
      return { month: rect('calendar-month-panel'), agenda: rect('calendar-agenda-panel'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: buttons.map(n => ({ date: Boolean(n.dataset.calendarDate), width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })),
        countFont: parseFloat(getComputedStyle(document.querySelector('.calendar-count')).fontSize),
        upcoming: rect('calendar-upcoming') };
    });
    assert.ok(calendar.month && calendar.agenda && calendar.upcoming, 'calendar, upcoming events and selected date have stable regions');
    assert.equal(calendar.overflow, false); assert.equal(calendar.countFont, 14);
    for (const box of calendar.controls) { assert.ok(box.width >= (box.date ? 24 : 44)); assert.ok(box.height >= (box.date ? 56 : 44)); }
    if (width >= 1024) assert.ok(Math.abs(calendar.month.top - calendar.upcoming.top) < 1);
    else assert.ok(calendar.upcoming.top >= calendar.month.bottom);
    await page.screenshot({ path: join(screenshotDir, `calendar-${theme}-${width}.png`), fullPage: true });
  }
});

async function readableContrasts(page, selectors) {
  return page.evaluate(selectors => {
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = color => rgb(color).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(n => n.getClientRects().length).map(n => {
      let parent = n, background;
      while (parent) { const color = getComputedStyle(parent).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; } parent = parent.parentElement; }
      return { selector, ratio: ratio(getComputedStyle(n).color, background), text: n.textContent.slice(0, 40) };
    }));
  }, selectors);
}
for (const theme of ['light', 'dark']) test(`readability ${theme} distinguishes neutral, deadline, pending and error without low contrast`, async t => {
  let mode = 'deadline', release;
  const { page } = await open(t, { theme, read: () => {
    if (mode === 'pending') return new Promise(resolve => { release = () => resolve(fixture()); });
    return mode === 'neutral' ? { ...fixture(), credits: fixture().credits.map(c => ({ ...c, expiresAt: N + 8 * D })) }
      : mode === 'error' ? { ...fixture(), ordinaryUsageAllowed: false } : fixture();
  } });
  for (const tone of ['deadline', 'neutral', 'error', 'pending']) {
    if (tone !== 'deadline') {
      mode = tone; await page.locator('#refresh').click();
      await page.waitForFunction(tone => document.querySelector('#recommendation').dataset.tone === tone, tone);
    }
    await page.clock.runFor(20); // Let the virtual rendering frame apply the new style state.
    assert.equal(await page.locator('#recommendation').getAttribute('data-tone'), tone);
    assert.equal(await page.locator('#recommendation-urgency').isVisible(), tone === 'deadline');
    if (tone === 'neutral') {
      const colors = await page.evaluate(() => ({ tone: document.querySelector('#recommendation').dataset.tone,
        actual: getComputedStyle(document.querySelector('#recommendation')).backgroundColor }));
      assert.equal(colors.actual, 'rgba(0, 0, 0, 0)', JSON.stringify(colors));
    }
    for (const entry of await readableContrasts(page, ['#recommendation-title', '#recommendation-reason', '#recommendation-target', '#query-state'])) {
      assert.ok(entry.ratio >= 4.5, `${theme} ${tone} ${JSON.stringify(entry)}`);
    }
    assert.equal(await page.locator('#recommendation').evaluate(n => getComputedStyle(n).opacity), '1');
  }
  for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  release(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  await page.locator('#usage-rules summary').click();
  for (const entry of await readableContrasts(page, ['#usage-rules summary', '#usage-rules dt', '#usage-rules dd', '#usage-rules a'])) {
    assert.ok(entry.ratio >= 4.5, `${theme} rules ${JSON.stringify(entry)}`);
  }
  await page.locator('#tab-calendar').click();
  for (const entry of await readableContrasts(page, ['#calendar-legend span', '#calendar-upcoming-title', '.calendar-upcoming-name', '.calendar-upcoming-button time', '.calendar-upcoming-remaining', '#calendar-events strong', '#calendar-selected', '.calendar-date[aria-pressed="true"]', '.calendar-count'])) assert.ok(entry.ratio >= 4.5, `${theme} calendar ${JSON.stringify(entry)}`);
});

test('calendar rows preserve node identity, focus and open exact-time details through ticks and identical reads', async t => {
  const { page } = await open(t);
  await page.locator('#tab-calendar').click();
  const row = page.locator('#calendar-events [data-kind="credit-expiry"]');
  assert.equal(await row.locator('details').count(), 1);
  await row.locator('summary').click(); await row.locator('summary').focus();
  assert.match(await row.locator('details').innerText(), /2026-10-04 21:30:00 KST/);
  assert.match(await row.locator('time').innerText(), /오늘 21:30/);
  await page.evaluate(() => {
    globalThis.__calendarRow = document.querySelector('#calendar-events [data-kind="credit-expiry"]');
    globalThis.__calendarDetails = __calendarRow.querySelector('details');
    globalThis.__calendarSummary = __calendarDetails.querySelector('summary');
    globalThis.__calendarLive = 0;
    const observer = new MutationObserver(records => { __calendarLive += records.length; });
    observer.observe(document.getElementById('calendar-selected'), { childList: true, subtree: true, characterData: true });
  });
  await page.clock.runFor(61000);
  assert.deepEqual(await page.evaluate(() => ({ same: __calendarRow === document.querySelector('#calendar-events [data-kind="credit-expiry"]'), open: __calendarDetails.open, focus: document.activeElement === __calendarSummary, live: __calendarLive })), { same: true, open: true, focus: true, live: 0 });
  assert.match(await row.locator('.calendar-remaining').innerText(), /12시간 29분 남음/);
  await refresh(page);
  assert.equal(await page.evaluate(() => __calendarRow === document.querySelector('#calendar-events [data-kind="credit-expiry"]') && __calendarDetails.open), true);
  assert.match(await page.locator('#calendar-selected').innerText(), /2026-10-04 일정 · 2건/);
});
test('upcoming rows keep focus through ticks and recover it when an event time passes', async t => {
  const sample = fixture();
  sample.credits = [
    { ...sample.credits[0], title: '곧 만료되는 리셋권', expiresAt: N + 60 },
    { ...sample.credits[1], title: '다음 리셋권', expiresAt: N + 3 * D },
  ];
  const { page, reads } = await open(t, { read: () => sample });
  await page.locator('#tab-calendar').click();
  const soon = page.locator('#calendar-upcoming-events [data-kind="credit-expiry"] button').first();
  await soon.focus();
  await page.evaluate(() => { globalThis.__upcomingButton = document.activeElement; });
  await page.clock.runFor(5000);
  assert.equal(await page.evaluate(() => document.activeElement === __upcomingButton), true);
  assert.equal(reads(), 1);
  await page.clock.runFor(55000);
  assert.equal(await page.locator('#calendar-upcoming-events [data-calendar-upcoming-date]').count(), 3);
  assert.doesNotMatch(await page.locator('#calendar-upcoming-events').innerText(), /곧 만료되는 리셋권/);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.calendarDate), '2026-10-04');
  assert.match(await page.locator('#calendar-upcoming-events').innerText(), /다음 리셋권/);
  assert.equal(reads(), 1);
});
test('calendar reconciles duplicate keys, removals and title changes while recovering focus from removed details', async t => {
  let value = fixture(), deferred = false, release;
  const { page } = await open(t, { read: () => deferred ? new Promise(resolve => { release = () => resolve(value); }) : value });
  await page.locator('#tab-calendar').click();
  assert.equal(await page.locator('#calendar-events details').count(), 2);
  await page.evaluate(() => { globalThis.__originalCredit = document.querySelector('#calendar-events [data-kind="credit-expiry"]'); });
  value = { ...fixture(), credits: [...fixture().credits, { ...fixture().credits[0] }] };
  await refresh(page);
  assert.equal(await page.locator('#calendar-events [data-kind="credit-expiry"]').count(), 2);
  assert.equal(await page.evaluate(() => __originalCredit === document.querySelector('#calendar-events [data-kind="credit-expiry"]')), true);
  value = { ...fixture(), credits: [{ ...fixture().credits[0], title: '새 제목' }] };
  deferred = true; await page.locator('#refresh').click();
  const summary = page.locator('#calendar-events [data-kind="credit-expiry"] summary').first(); await summary.focus();
  for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  release(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.locator('#calendar-events [data-kind="credit-expiry"]').count(), 1);
  assert.match(await page.locator('#calendar-events').innerText(), /새 제목/);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.calendarDate), '2026-10-04');
  assert.equal(await page.evaluate(() => __originalCredit.isConnected), false);
  assert.equal(await page.locator('#calendar-events details[open]').count(), 0);
});
test('calendar restores date focus after event changes and changes only the today marker across KST midnight', async t => {
  const late = Date.parse('2026-10-04T14:59:59Z') / 1000;
  let value = { ...fixture(), queriedAt: late }, deferred = false, release;
  const { page } = await open(t, { now: late, read: () => deferred ? new Promise(resolve => { release = () => resolve(value); }) : value });
  await page.locator('#tab-calendar').click();
  assert.equal(await page.locator('#calendar-events details').count(), 2);
  await page.locator('[data-calendar-date="2026-10-04"]').focus();
  await page.clock.runFor(2000);
  assert.equal(await page.locator('[aria-current="date"]').getAttribute('data-calendar-date'), '2026-10-05');
  assert.equal(await page.locator('[data-calendar-date="2026-10-04"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.calendarDate), '2026-10-04');
  value = { ...value, credits: [...value.credits, { ...value.credits[0], number: 3, title: '추가 일정' }] };
  deferred = true; await page.locator('#refresh').click();
  await page.locator('[data-calendar-date="2026-10-04"]').focus();
  for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  release(); await page.waitForFunction(() => document.body.dataset.loading === 'false');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.calendarDate), '2026-10-04');
  assert.match(await page.locator('#calendar-selected').innerText(), /3건/);
});
test('calendar account changes erase open details and reset month selection', async t => {
  let value = fixture();
  const { page } = await open(t, { read: () => value });
  await page.locator('#tab-calendar').click();
  assert.equal(await page.locator('#calendar-events details').count(), 2);
  await page.locator('#calendar-events summary').first().click();
  await page.locator('#calendar-next').click();
  value = { ...fixture(), accountScope: 'new-readability-account', revision: 1, credits: [], availableCount: 0 };
  await refresh(page);
  assert.match(await page.locator('#calendar-month').innerText(), /2026년 10월/);
  assert.equal(await page.locator('[data-calendar-date="2026-10-04"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#calendar-events details[open]').count(), 0);
  assert.equal(await page.locator('#calendar-events [data-kind="credit-expiry"]').count(), 0);
});

test('data guidance opens with the keyboard while current restriction and partial coverage stay visible', async t => {
  const { page } = await open(t, { read: () => ({ ...fixture(), ordinaryUsageAllowed: false, detailState: 'partial' }) });
  assert.equal(await page.locator('details#data-guidance').count(), 1);
  assert.equal(await page.locator('#data-guidance').getAttribute('open'), null);
  assert.equal(await page.locator('#data-guidance summary').innerText(), '데이터 안내');
  assert.match(await page.locator('#recommendation-title').innerText(), /일반 사용을 제한/);
  assert.equal(await page.locator('#recommendation-scope-note').isVisible(), true);
  await page.locator('#data-guidance summary').focus(); await page.locator('#data-guidance summary').press('Enter');
  assert.equal(await page.locator('#data-guidance').getAttribute('open'), '');
  assert.match(await page.locator('#data-guidance').innerText(), /PC 시계 기준/);
  await page.locator('#data-guidance summary').press('Space');
  assert.equal(await page.locator('#data-guidance').getAttribute('open'), null);
});
test('live recommendation and natural reset boundaries announce once while further ticks remain silent', async t => {
  const { page } = await open(t, { read: () => ({ ...fixture(), credits: [{ ...fixture().credits[0], expiresAt: N + H + 30 }] }) });
  await page.evaluate(() => {
    globalThis.__boundaryAnnouncements = [];
    new MutationObserver(() => { __boundaryAnnouncements.push(document.getElementById('usage-announcement').textContent); }).observe(document.getElementById('usage-announcement'), { childList: true });
  });
  await page.clock.runFor(31000);
  assert.equal(await page.locator('#recommendation').getAttribute('data-code'), 'refresh-needed');
  assert.equal(await page.evaluate(() => __boundaryAnnouncements.filter(s => s.includes('재조회')).length), 1);
  await page.clock.runFor(5000);
  assert.equal(await page.evaluate(() => __boundaryAnnouncements.length), 1);
  await page.clock.fastForward(5 * H * 1000);
  assert.match(await page.locator('#usage-announcement').innerText(), /5시간 리셋 시각이 지났습니다/);
  const count = await page.evaluate(() => __boundaryAnnouncements.length);
  await page.clock.runFor(5000); assert.equal(await page.evaluate(() => __boundaryAnnouncements.length), count);
});

for (const mode of ['text-200', 'text-spacing']) for (const theme of ['light', 'dark']) {
  test(`${mode} ${theme} preserves readable content in all panels at 320px`, async t => {
    const { page } = await open(t, { width: 320, theme, read: () => ({ ...fixture(), detailState: 'partial', credits: fixture().credits.map(c => ({ ...c, title: '긴 리셋권 이름 '.repeat(12) })) }) });
    assert.equal(await page.locator('details#data-guidance').count(), 1);
    await page.evaluate(mode => {
      const nodes = [...document.querySelectorAll('h1,h2,h3,p,button,summary,span,dt,dd,strong,time')];
      const sizes = nodes.map(n => [n, parseFloat(getComputedStyle(n).fontSize)]);
      for (const [n, size] of sizes) {
        if (mode === 'text-200') n.style.fontSize = `${size * 2}px`;
        else { n.style.lineHeight = '1.5'; n.style.letterSpacing = '.12em'; n.style.wordSpacing = '.16em'; if (n.tagName === 'P') n.style.marginBottom = '2em'; }
      }
      globalThis.__scaledSizes = sizes.map(([n, size]) => ({ node: n, want: size * 2 }));
      for (const details of document.querySelectorAll('details')) details.open = true;
    }, mode);
    if (mode === 'text-200') {
      assert.equal(await page.evaluate(() => __scaledSizes.every(item => Math.abs(parseFloat(getComputedStyle(item.node).fontSize) - item.want) < .1)), true);
      const balances = await page.locator('.usage-percent').evaluateAll(nodes => nodes.map(n => ({ value: n.getBoundingClientRect().toJSON(), column: n.closest('.usage-window').getBoundingClientRect().toJSON() })));
      for (const { value, column } of balances) assert.ok(value.left >= column.left && value.right <= column.right + 1, 'enlarged balances must stay inside their own readable column');
      const [a, b] = balances.map(item => item.value);
      assert.ok(a.right <= b.left || a.bottom <= b.top || b.right <= a.left || b.bottom <= a.top, 'enlarged balances must not overlap');
    }
    for (const tab of ['credits', 'calendar', 'alerts']) {
      await page.locator(`#tab-${tab}`).click();
      const geometry = await page.evaluate(tab => {
        const root = document.querySelector(`#panel-${tab}`);
        const clipped = [...root.querySelectorAll('p,dt,dd,strong,time,summary')].filter(n => n.getClientRects().length && n.scrollWidth > n.clientWidth + 1).map(n => n.tagName + ':' + n.textContent.slice(0, 25));
        return { overflow: document.documentElement.scrollWidth > innerWidth, clipped, text: root.innerText };
      }, tab);
      assert.equal(geometry.overflow, false, `${mode} ${theme} ${tab}`);
      assert.deepEqual(geometry.clipped, [], `${mode} ${theme} ${tab}`);
      assert.ok(geometry.text.length > 0);
      if (tab === 'credits') assert.match(geometry.text, /2026-10-04/);
      if (tab === 'calendar') assert.match(geometry.text, /2026-10-04 21:30:00 KST/);
    }
    await page.screenshot({ path: join(screenshotDir, `${mode}-${theme}-320.png`), fullPage: true });
  });
}
