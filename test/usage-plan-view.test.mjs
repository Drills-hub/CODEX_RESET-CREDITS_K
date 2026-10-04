import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const publicDir = new URL('../public/', import.meta.url);
const origin = 'http://usage-plan.test';
const now = 1791072000; // 2026-10-04 09:00:00 KST
const day = 86400;
const fixture = {
  state: 'ready', code: 'depletion-first', title: '주간 잔여량을 먼저 활용하세요.',
  reason: '소진 후 다시 조회하고 첫 리셋권 사용을 검토하세요.',
  queriedAt: now, targetAt: now + day * 2, requiredRatePerDay: 20,
  ratePerDay: 40, rateSource: 'manual', exhaustsAt: now + day,
  remainingAtTarget: 0, coverage: 'complete',
  firstCredit: { number: 1, title: '첫 리셋권', expiresAt: now + day * 2 + 3600, deadlineAt: now + day * 2, resetType: 'codexRateLimits' },
  nextCredit: { number: 2, title: '다음 리셋권', expiresAt: now + day * 3 + 3600, deadlineAt: now + day * 3, resetType: 'codexRateLimits' },
  firstUseAt: now + day, nextGapSeconds: day * 2,
  nextRequiredRatePerDay: 50, nextRemainingPercent: 20,
  events: [
    { kind: 'now', at: now, label: '현재', creditNumber: null, assumed: false },
    { kind: 'credit-use', at: now + day, label: '첫 리셋권 사용 검토', creditNumber: 1, assumed: true },
    { kind: 'credit-expiry', at: now + day * 2 + 3600, label: '첫 리셋권 만료', creditNumber: 1, assumed: false },
    { kind: 'credit-expiry', at: now + day * 3 + 3600, label: '다음 리셋권 만료', creditNumber: 2, assumed: false },
    { kind: 'weekly-reset', at: now + day * 4, label: '주간 리셋 · 재조회 필요', creditNumber: null, assumed: false },
  ],
  segments: [
    { kind: 'estimate', fromAt: now, toAt: now + day, fromPercent: 40, toPercent: 0 },
    { kind: 'estimate', fromAt: now + day, toAt: now + day * 2, fromPercent: 0, toPercent: 0 },
    { kind: 'scenario', fromAt: now + day, toAt: now + day * 3, fromPercent: 100, toPercent: 20 },
  ],
  warnings: ['최근 사용 속도가 계속 유지된다고 가정합니다.', '리셋권 사용 후 100% 주간 충전 시나리오는 보장되지 않습니다.'],
};

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

async function openFixture(t, plan = fixture) {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  t.after(() => page.close());
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/app.mjs') return route.fulfill({ contentType: 'text/javascript', body: '' });
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'style.css', 'usage-plan-view.mjs', 'time.mjs'].includes(name)) return route.abort();
    try {
      const body = await readFile(new URL(name, publicDir), 'utf8');
      return route.fulfill({ contentType: name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return route.fulfill({ status: 404, body: 'Missing view module' });
    }
  });
  await page.goto(origin);
  if (plan) await page.evaluate(async plan => {
    const { createUsagePlanView } = await import('/usage-plan-view.mjs');
    window.planView = createUsagePlanView(document.querySelector('#usage-plan-chart'));
    window.planView.update(plan);
  }, plan);
  return page;
}

test('schedule inputs are labelled, memory-only and do not enlarge the empty main card', async t => {
  const page = await openFixture(t, null);
  assert.equal(await page.locator('#panel-schedule #usage-plan').count(), 1);
  assert.equal(await page.getByRole('group', { name: '하루 소모량 설정' }).count(), 1);
  assert.equal(await page.locator('[name="usage-plan-rate-mode"][value="auto"]').isChecked(), true);
  await page.getByLabel('직접 입력').check();
  assert.equal(await page.getByLabel('직접 입력').isChecked(), true);
  const input = page.getByLabel('예상 하루 소모량 (%p/일)');
  await input.fill('0.05');
  assert.equal(await input.evaluate(node => node.validity.valid), true);
  assert.equal(await input.getAttribute('step'), 'any');
  assert.equal(await page.locator('#usage-plan-input-error').getAttribute('aria-live'), 'polite');
  const hint = await page.locator('#usage-plan-rate-hint').innerText();
  assert.match(hint, /24시간/);
  assert.match(hint, /메모리/);
  for (const id of ['usage-plan-summary', 'usage-plan-first-use', 'usage-plan-leftover', 'usage-plan-next-gap']) {
    assert.equal(await page.locator(`#recommendation #${id}`).count(), 1);
    assert.equal(await page.locator(`#${id}`).evaluate(node => node.getBoundingClientRect().height), 0);
  }
  for (const selector of ['.usage-plan-rate-choice', '#usage-plan-rate']) {
    const boxes = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getClientRects().length > 0).map(node => node.getBoundingClientRect().toJSON()));
    assert.ok(boxes.length > 0, `${selector} must expose visible controls`);
    for (const box of boxes) {
      assert.ok(box.height >= 44 && box.width >= 44, `${selector} touch target`);
    }
  }
  await input.focus();
  assert.ok(await input.evaluate(node => Number.parseFloat(getComputedStyle(node).outlineWidth) >= 2));
});

test('renderer shows plan summaries, KST events, semantic charts and equivalent segment text', async t => {
  const page = await openFixture(t);
  const text = await page.locator('#usage-plan-chart').innerText();
  assert.match(text, /주간 잔여량을 먼저 활용/);
  assert.match(text, /소진 후 다시 조회/);
  assert.match(text, /2026-10-06 09:00:00 KST \(UTC\+09:00\)/);
  assert.match(text, /40 %p\/일/);
  assert.match(text, /20 %p\/일/);
  assert.match(text, /직접 입력/);
  assert.match(text, /목표 시점 예상 잔여량[\s\S]*0%/);
  assert.match(text, /시나리오[\s\S]*100% → 20%/);
  assert.match(text, /예상[\s\S]*40% → 0%/);
  assert.match(text, /예상[\s\S]*0% → 0%/);
  assert.equal(await page.locator('#usage-plan-chart svg[role="img"]').count(), 2);
  for (const svg of await page.locator('#usage-plan-chart svg').all()) {
    assert.ok((await svg.locator('title').textContent()).length > 0);
    assert.ok((await svg.locator('desc').textContent()).length > 0);
    assert.ok(await svg.getAttribute('aria-labelledby'));
    assert.ok(await svg.getAttribute('aria-describedby'));
  }
  assert.equal(await page.locator('.usage-plan-event-list li').count(), 5);
  assert.equal(await page.locator('svg [data-event-kind]').count(), 5);
  assert.equal(await page.locator('svg [data-segment-kind="estimate"]').count(), 2);
  assert.equal(await page.locator('svg [data-segment-kind="scenario"]').count(), 1);
  const lines = await page.locator('svg [data-segment-kind]').evaluateAll(nodes => nodes.map(n => Object.fromEntries(['x1', 'x2', 'y1', 'y2'].map(k => [k, Number(n.getAttribute(k))]))));
  assert.ok(lines.every(line => Object.values(line).every(Number.isFinite) && line.x1 <= line.x2));
  assert.ok(lines[0].y1 < lines[0].y2);
  assert.equal(lines[1].y1, lines[1].y2, 'flat zero interval is not spread into decline');
  assert.equal(lines[0].x2, lines[2].x1, 'scenario begins at depletion without joining the two lines');
  assert.equal(await page.locator('[name="usage-plan-rate-mode"][value="auto"]').isChecked(), true, 'renderer does not control input mode');
});

test('without a rate the first-use time is labelled as a safety deadline, with no numeric refill scenario', async t => {
  const plan = { ...fixture, title: '안전 마감 전에 리셋권 사용을 검토하세요.', reason: '속도가 없어 소진 시각을 추정할 수 없습니다.',
    ratePerDay: null, exhaustsAt: null, remainingAtTarget: null, firstUseAt: now + day * 2,
    nextGapSeconds: day, nextRequiredRatePerDay: null, nextRemainingPercent: null, segments: [], warnings: [],
    events: fixture.events.map(event => event.kind === 'credit-use' ? { ...event, at: now + day * 2 } : event) };
  const page = await openFixture(t, plan);
  const text = await page.locator('#usage-plan-chart').innerText();
  assert.match(text, /첫 리셋권 안전 마감/);
  assert.match(text, /소진 예상 아님/);
  assert.doesNotMatch(await page.locator('.usage-plan-metrics').innerText(), /100% 충전 가정/);
});

test('a positive rate below 0.1 is displayed without rounding it to zero', async t => {
  const page = await openFixture(t, { ...fixture, ratePerDay: 0.00001 });
  assert.match(await page.locator('.usage-plan-metrics').innerText(), /0\.00001 %p\/일/);
});

test('identical plans and clock updates preserve SVG nodes while meaningful values update', async t => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    window.previousSvg = document.querySelector('#usage-plan-chart svg');
    window.previousLine = document.querySelector('[data-segment-kind="estimate"]');
    window.mutations = [];
    window.observer = new MutationObserver(records => window.mutations.push(...records));
    window.observer.observe(document.querySelector('#usage-plan-chart'), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.evaluate(plan => window.planView.update({ ...plan, unusedClock: 123 }), fixture);
  assert.equal(await page.evaluate(() => window.mutations.length), 0, 'only visible plan values determine rendering');
  const next = structuredClone(fixture);
  next.events[0].at++;
  next.segments[0].fromAt++;
  next.ratePerDay = 30;
  next.reason = '새 사용 속도에 맞춰 재조회하세요.';
  await page.evaluate(plan => window.planView.update(plan), next);
  assert.equal(await page.evaluate(() => window.previousSvg === document.querySelector('#usage-plan-chart svg')), true);
  assert.equal(await page.evaluate(() => window.previousLine === document.querySelector('[data-segment-kind="estimate"]')), true);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /30 %p\/일/);
  assert.match(await page.locator('.usage-plan-event-list').innerText(), /2026-10-04 09:00:01 KST/);
});

test('unavailable states clear estimates, and clear/destroy release the owned display', async t => {
  const page = await openFixture(t);
  for (const state of ['not-ready', 'refreshing', 'refresh-needed', 'server-restricted', 'incomplete']) {
    await page.evaluate(({ plan, state }) => window.planView.update({ ...plan, state, title: '계획 보류', reason: '최신 사용량을 다시 확인하세요.', events: [], segments: [], targetAt: null, ratePerDay: null, requiredRatePerDay: null, remainingAtTarget: null, firstUseAt: null, nextGapSeconds: null, nextRequiredRatePerDay: null, nextRemainingPercent: null }), { plan: fixture, state });
    const text = await page.locator('#usage-plan-chart').innerText();
    assert.match(text, /계획 보류/);
    assert.doesNotMatch(text, /NaN|Infinity|1970-|40 %p\/일/);
    assert.equal(await page.locator('#usage-plan-chart [data-segment-kind]').count(), 0);
  }
  await page.evaluate(() => window.planView.clear());
  assert.equal(await page.locator('#usage-plan-chart').textContent(), '');
  await page.evaluate(plan => window.planView.update(plan), fixture);
  assert.equal(await page.locator('#usage-plan-chart svg').count(), 2);
  await page.evaluate(plan => { window.planView.destroy(); window.planView.update(plan); }, fixture);
  assert.equal(await page.locator('#usage-plan-chart').textContent(), '');
  assert.equal(await page.locator('#usage-plan-rate').count(), 1, 'display lifecycle does not remove controls');
});

test('coincident events stay readable and untrusted labels never become markup', async t => {
  const plan = structuredClone(fixture);
  const unsafe = '<img src=x onerror="window.injected=true">';
  plan.title = unsafe;
  plan.reason = unsafe;
  plan.warnings = [unsafe];
  plan.events[1].label = unsafe;
  plan.events[2].at = plan.events[1].at;
  plan.events[3].at = plan.events[1].at;
  plan.events[3].label = '긴 제목 '.repeat(30);
  const page = await openFixture(t, plan);
  assert.equal(await page.locator('#usage-plan-chart img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.match(await page.locator('#usage-plan-chart').innerText(), /<img src=x/);
  const rows = await page.locator('.usage-plan-event-list li').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].top >= rows[i - 1].bottom, 'coincident event text uses separate rows');
});

test('count-only, unknown effect and natural-reset fixtures never invent chart intervals', async t => {
  const page = await openFixture(t);
  const plans = [
    { ...fixture, coverage: 'count-only', targetAt: now + day * 4, requiredRatePerDay: 10, remainingAtTarget: null, exhaustsAt: null, firstCredit: null, nextCredit: null, firstUseAt: null, nextGapSeconds: null, nextRequiredRatePerDay: null, nextRemainingPercent: null, ratePerDay: null, rateSource: 'auto', segments: [], events: [fixture.events[0], fixture.events[4]], warnings: ['개수만 제공되어 리셋권 날짜를 확인할 수 없습니다.'] },
    { ...fixture, coverage: 'partial', firstCredit: { ...fixture.firstCredit, resetType: 'unknown' }, nextRequiredRatePerDay: null, nextRemainingPercent: null, segments: fixture.segments.slice(0, 2), warnings: ['조회된 항목 중 첫 리셋권의 효과를 확인할 수 없습니다.'] },
    { ...fixture, targetAt: now + day / 2, requiredRatePerDay: 80, remainingAtTarget: 20, firstUseAt: null, nextGapSeconds: null, nextRequiredRatePerDay: null, nextRemainingPercent: null,
      segments: [{ kind: 'estimate', fromAt: now, toAt: now + day / 2, fromPercent: 40, toPercent: 20 }],
      events: [fixture.events[0], { ...fixture.events[4], at: now + day / 2 }, fixture.events[2], fixture.events[3]], warnings: ['자연 리셋 후 재조회하세요.'] },
  ];
  for (const plan of plans) {
    await page.evaluate(plan => window.planView.update(plan), plan);
    assert.equal(await page.locator('[data-segment-kind="scenario"]').count(), 0);
    assert.equal(await page.locator('[data-segment-kind]').count(), plan.segments.length);
    assert.equal(await page.locator('.usage-plan-event-list li').count(), plan.events.length);
    assert.match(await page.locator('#usage-plan-chart').innerText(), new RegExp(plan.warnings[0]));
    assert.doesNotMatch(await page.locator('.usage-plan-metrics').innerText(), /100% 충전 가정/);
    if (plan.segments.length) assert.doesNotMatch(await page.locator('.usage-plan-figure').last().innerText(), /100% 충전 가정/);
  }
});

test('fractional times, a single event and a zero deadline gap have finite text and geometry', async t => {
  const plan = { ...fixture, targetAt: now + 0.5, firstUseAt: now + 0.5, nextGapSeconds: 0, nextRequiredRatePerDay: null, nextRemainingPercent: null, events: [{ ...fixture.events[0], at: now + 0.5 }], segments: [{ kind: 'estimate', fromAt: now + 0.5, toAt: now + 0.5, fromPercent: 0, toPercent: 0 }] };
  const page = await openFixture(t, plan);
  const text = await page.locator('#usage-plan-chart').innerText();
  assert.match(text, /2026-10-04 09:00:00 KST/);
  assert.match(text, /0시간/);
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.equal(await page.locator('svg').evaluateAll(nodes => nodes.some(node => /NaN|Infinity/.test(node.outerHTML))), false);
});

test('charts and controls fit 320/375/768/1280 light/dark reduced-motion screens', async t => {
  const page = await openFixture(t);
  await page.getByLabel('직접 입력').check();
  await page.getByLabel('예상 하루 소모량 (%p/일)').fill('40');
  const output = process.env.VISUAL_QA_OUTPUT_DIR;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [320, 375, 768, 1280]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    // Chromium exposes new media tokens before SVG inherited styles repaint.
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('[data-segment-kind="estimate"]')).stroke === expected,
      colorScheme === 'dark' ? 'rgb(225, 138, 90)' : 'rgb(163, 79, 44)');
    await page.waitForFunction(() => document.querySelector('#usage-plan-chart').getAnimations({ subtree: true }).length === 0);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('#usage-plan, #usage-plan-chart svg, .usage-plan-event-list li, .usage-plan-segment-list li, #usage-plan-rate')].map(n => ({ ...n.getBoundingClientRect().toJSON(), scroll: n.scrollWidth, client: n.clientWidth })),
      stroke: getComputedStyle(document.querySelector('[data-segment-kind="estimate"]')).stroke,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    }));
    assert.ok(layout.scroll <= layout.width, `${width}/${colorScheme} page overflow`);
    for (const box of layout.elements) {
      assert.ok(box.left >= 0 && box.right <= width, `${width}/${colorScheme} element overflow`);
      assert.ok(box.scroll <= box.client + 1, `${width}/${colorScheme} clipped text`);
    }
    assert.equal(layout.stroke, colorScheme === 'dark' ? 'rgb(225, 138, 90)' : 'rgb(163, 79, 44)');
    assert.equal(await page.locator('#usage-plan-chart').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    if (output) {
      // Keep the sticky tab bar in its natural location in the complete page.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${output}/task-C-${width}-${colorScheme}.png`, fullPage: true });
    }
  }
});
