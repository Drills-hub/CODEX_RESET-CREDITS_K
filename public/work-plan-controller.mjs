import { parseKstInput, estimateConsumption, buildWorkSchedulePlan } from './usage-scheduler.mjs';
import { formatKst } from './time.mjs';

// Inputs and explicitly marked work samples stay in this page's memory.
export function createWorkPlanController(root, { now = () => Date.now() / 1000, onChange = () => {} } = {}) {
  const get = id => root.querySelector(`#${id}`);
  const enabled = get('work-plan-enabled');
  const settings = get('work-plan-settings');
  const weekly = get('work-hour-rate');
  const five = get('work-five-rate');
  const tracking = get('work-active');
  const status = get('work-rate-status');
  const error = get('work-plan-error');
  const list = get('work-slots');
  const modes = [...root.querySelectorAll('[name="work-rate-mode"]')];
  let entries = [];
  let samples = [];
  let session = 0;
  let version = 0;
  let cache;
  let expiredSnapshot;
  const automatic = () => modes.find(input => input.checked)?.value === 'auto';
  const changed = () => { version++; cache = undefined; onChange(); };
  function renderSlots() {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const li = root.ownerDocument.createElement('li');
      li.textContent = `${entry.accessOnly ? '리셋권 확인만' : '작업·리셋권 확인'}: ${formatKst(entry.startAt)} → ${formatKst(entry.endAt)} `;
      const remove = root.ownerDocument.createElement('button');
      remove.type = 'button'; remove.className = 'button-secondary'; remove.textContent = '시간 삭제';
      remove.setAttribute('aria-label', `${index + 1}번째 시간 삭제`);
      remove.addEventListener('click', () => { entries.splice(index, 1); error.textContent = ''; renderSlots(); changed(); });
      li.append(remove); list.append(li);
    });
  }
  get('work-slot-add').addEventListener('click', () => {
    const startAt = parseKstInput(get('work-slot-start').value);
    const endAt = parseKstInput(get('work-slot-end').value);
    if (startAt === null || endAt === null || startAt >= endAt) { error.textContent = '유효한 시작과 종료를 입력하세요. 종료는 시작 이후여야 합니다.'; return; }
    if (endAt <= now()) { error.textContent = '이미 끝난 구간은 추가할 수 없습니다.'; return; }
    if (entries.length >= 8) { error.textContent = '시간은 최대 8개까지 추가할 수 있습니다.'; return; }
    entries.push({ startAt, endAt, accessOnly: get('work-slot-access-only').checked });
    error.textContent = ''; renderSlots(); changed();
  });
  enabled.addEventListener('change', () => { settings.hidden = !enabled.checked; changed(); });
  for (const mode of modes) mode.addEventListener('change', () => { error.textContent = ''; changed(); });
  for (const input of [weekly, five]) input.addEventListener('input', () => { error.textContent = ''; changed(); });
  tracking.addEventListener('change', () => { session++; samples = []; changed(); });

  function record(snapshot) {
    if (!tracking.checked || !snapshot) return;
    const w = snapshot.usageWindows?.find(row => row.kind === 'weekly');
    const f = snapshot.usageWindows?.find(row => row.kind === 'five-hour');
    samples.push({ at: snapshot.queriedAt, weeklyRemaining: w?.state === 'complete' ? w.remainingPercent : null,
      fiveRemaining: f?.state === 'complete' ? f.remainingPercent : null, weeklyResetsAt: w?.resetsAt, fiveResetsAt: f?.resetsAt,
      accountScope: snapshot.accountScope, revision: snapshot.revision, activeSession: session });
    samples = samples.filter(sample => sample.at >= now() - 1800).slice(-64);
    expiredSnapshot = undefined; version++; cache = undefined;
  }
  function read(snapshot, { stale = false, refreshing = false } = {}) {
    settings.hidden = !enabled.checked;
    weekly.disabled = automatic(); five.disabled = automatic();
    const speed = estimateConsumption(samples, { now: Math.floor(now()) });
    status.textContent = speed.state === 'ready'
      ? `작업 중 성공 조회 ${speed.samples}건: 주간 ${new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 6 }).format(speed.weeklyPerHour)} %p/작업시간. 자동 조회를 새로 켜지 않습니다.`
      : `작업 중 성공 조회 ${speed.samples ?? 0}건. ${speed.state === 'no-decrease' ? '감소가 없어 속도를 확정하지 않습니다.' : '동일 작업 세션의 성공 조회 3건부터 계산합니다.'} 추세 켜기나 새로고침으로 표본을 수집하세요.`;
    if (!enabled.checked) return null;
    const clockInvalid = snapshot && (!Number.isFinite(now()) || now() < 0 || !Number.isSafeInteger(snapshot.queriedAt) || snapshot.queriedAt < 0 || snapshot.queriedAt > now());
    if (clockInvalid) expiredSnapshot = snapshot;
    const manualBad = !automatic() && (!weekly.validity.valid || !Number.isFinite(weekly.valueAsNumber) || weekly.valueAsNumber <= 0
      || (five.value !== '' && (!five.validity.valid || !Number.isFinite(five.valueAsNumber) || five.valueAsNumber < 0)));
    weekly.setAttribute('aria-invalid', String(manualBad && (!Number.isFinite(weekly.valueAsNumber) || weekly.valueAsNumber <= 0)));
    five.setAttribute('aria-invalid', String(manualBad && five.value !== '' && (!five.validity.valid || five.valueAsNumber < 0)));
    const positive = snapshot?.usageWindows?.some(row => row.kind === 'weekly' && row.remainingPercent > 0);
    const previous = cache?.plan;
    if (snapshot && cache?.snapshot === snapshot && previous?.state === 'ready') {
      const edge = previous.schedule?.recommendedEnd ?? previous.firstUseAt;
      if ((edge > snapshot.queriedAt && edge <= now()) || (previous.firstCredit?.deadlineAt > snapshot.queriedAt && previous.firstCredit.deadlineAt <= now())) expiredSnapshot = snapshot;
      if (positive && previous.exhaustsAt !== null && previous.exhaustsAt >= snapshot.queriedAt && previous.exhaustsAt <= now()) expiredSnapshot = snapshot;
    }
    const realResetPassed = snapshot?.usageWindows?.some(row => Number.isSafeInteger(row.resetsAt) && row.resetsAt <= now());
    const speedKey = [speed.state, speed.weeklyPerHour, speed.fiveHourPerHour];
    const key = JSON.stringify([version, stale, refreshing, realResetPassed, expiredSnapshot === snapshot, manualBad, speedKey]);
    if (!cache || cache.snapshot !== snapshot || cache.key !== key) {
      let plan = buildWorkSchedulePlan(snapshot, { now: snapshot?.queriedAt ?? now(), stale: stale || Boolean(realResetPassed) || Boolean(snapshot && expiredSnapshot === snapshot), refreshing,
        workSlots: entries.filter(entry => !entry.accessOnly), accessSlots: entries,
        weeklyPerHour: automatic() ? speed.weeklyPerHour : manualBad ? null : weekly.valueAsNumber,
        fiveHourPerHour: automatic() ? speed.fiveHourPerHour : five.value === '' || manualBad ? null : five.valueAsNumber,
        rateSource: automatic() ? 'auto' : 'manual' });
      const edge = plan.schedule?.recommendedEnd ?? plan.firstUseAt;
      const first = plan.firstCredit;
      const deadlinePassed = first && ((first.deadlineAt > snapshot?.queriedAt && first.deadlineAt <= now()) || first.expiresAt <= now());
      if (plan.state === 'ready' && ((edge > snapshot?.queriedAt && edge <= now()) || deadlinePassed)) {
        expiredSnapshot = snapshot;
        plan = buildWorkSchedulePlan(snapshot, { now: now(), stale: true, workSlots: [], rateSource: automatic() ? 'auto' : 'manual' });
      }
      if (manualBad && !stale && !refreshing && !realResetPassed && !(snapshot && expiredSnapshot === snapshot)) {
        error.textContent = '주간 속도는 0보다 큰 유한한 숫자, 5시간 속도는 비워 두거나 0 이상으로 입력하세요.';
      }
      plan = { ...plan, schedule: plan.schedule ?? { workSlots: [], scenarios: [], candidates: [] } };
      if (plan.state !== 'ready') plan = { ...plan, events: [], segments: [], firstUseAt: null, remainingAtTarget: null, nextGapSeconds: null };
      cache = { snapshot, key, plan };
    }
    return cache.plan;
  }
  function clear() {
    entries = []; samples = []; session++; version++; cache = undefined; expiredSnapshot = undefined;
    enabled.checked = false; settings.hidden = true; tracking.checked = false;
    weekly.value = ''; five.value = ''; error.textContent = '';
    for (const mode of modes) mode.checked = mode.value === 'manual';
    get('work-slot-start').value = ''; get('work-slot-end').value = ''; get('work-slot-access-only').checked = false;
    weekly.removeAttribute('aria-invalid'); five.removeAttribute('aria-invalid'); renderSlots();
  }
  return { get enabled() { return enabled.checked; }, record, read, clear, invalidate() { cache = undefined; expiredSnapshot = undefined; } };
}
