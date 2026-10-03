const lockName = 'reset-check.usage-read.lock.v1';
const channelName = 'reset-check.usage-read.channel.v1';
const connectionError = () => ({ code: 'CONNECTION', message: '사용량 조회 연결이 종료되었습니다. 다시 조회해 주세요.', clearPrevious: false });
const timeoutError = () => ({ code: 'TIMEOUT', message: '사용량 조회를 기다리는 시간이 초과됐습니다. 다시 조회해 주세요.', clearPrevious: false });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function snapshotPayload(value) {
  if (!value || !Number.isSafeInteger(value.queriedAt) || !Number.isSafeInteger(value.revision)) throw connectionError();
  const result = pick(value, ['queriedAt', 'availableCount', 'detailState', 'ordinaryUsageAllowed', 'revision', 'accountScope']);
  if (Array.isArray(value.credits)) result.credits = value.credits.map(row => pick(row, ['number', 'title', 'status', 'grantedAt', 'expiresAt', 'expiryState', 'reminderKey']));
  if (Array.isArray(value.usageWindows)) result.usageWindows = value.usageWindows.map(row => pick(row, ['kind', 'windowDurationMins', 'usedPercent', 'remainingPercent', 'resetsAt', 'state']));
  return result;
}
function errorPayload(error) {
  const codes = ['CONNECTION', 'TIMEOUT', 'BUSY', 'LOGIN_REQUIRED', 'AUTH_UNSUPPORTED', 'ACCOUNT_CHANGED', 'INCOMPATIBLE', 'UPSTREAM', 'INVALID_DATA', 'FORBIDDEN'];
  if (!codes.includes(error?.code) || typeof error.message !== 'string') return connectionError();
  return { code: error.code, message: error.message, clearPrevious: error.clearPrevious === true };
}

export function createUsageReadCoordinator({ locks, BroadcastChannel, read, timeoutMs = 18000,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  let channel; let active; let closed = false; let lastResult;
  try { if (locks?.request && BroadcastChannel) channel = new BroadcastChannel(channelName); } catch {}
  const post = data => { try { channel?.postMessage(data); } catch {} };
  function finish(operation, packet) {
    if (operation.done) return;
    operation.done = true;
    if (operation.timer !== undefined) cancel(operation.timer);
    if (operation.delayTimer !== undefined) cancel(operation.delayTimer);
    operation.delayResolve?.();
    if (packet.ok) {
      try { operation.resolve(snapshotPayload(packet.value)); } catch (error) { operation.reject(errorPayload(error)); }
    } else operation.reject(errorPayload(packet.error));
  }
  if (channel) channel.onmessage = ({ data }) => {
    if (closed || !data || typeof data.id !== 'string') return;
    if (data.type === 'request') {
      if (active && !active.done) active.participants.add(data.id);
      else if (lastResult && Number.isFinite(data.startedAt) && data.startedAt <= lastResult.finishedAt) {
        post({ ...lastResult, targets: [data.id] });
      }
    } else if (data.type === 'result' && Array.isArray(data.targets) && active && data.targets.includes(active.id)) {
      finish(active, data);
    }
  };
  async function perform(operation) {
    if (closed || operation.done) return;
    operation.leader = true;
    // Let queued join messages arrive before a fast read can finish.
    if (channel) await new Promise(resolve => { operation.delayResolve = resolve; operation.delayTimer = schedule(resolve, 0); });
    if (closed || operation.done) return;
    let packet;
    try {
      let value;
      try { value = await read(); }
      catch (error) {
        if (locks?.request || error?.code !== 'BUSY') throw error;
        await new Promise(resolve => { operation.delayResolve = resolve; operation.delayTimer = schedule(resolve, 250); });
        if (closed || operation.done) return;
        value = await read();
      }
      packet = { ok: true, value: snapshotPayload(value) };
    } catch (error) { packet = { ok: false, error: errorPayload(error) }; }
    if (closed || operation.done) return;
    lastResult = { ...packet, type: 'result', id: operation.id, finishedAt: Date.now(), targets: [...operation.participants] };
    post(lastResult);
    finish(operation, packet);
  }
  function run() {
    if (closed) return Promise.reject(connectionError());
    if (active) return active.promise;
    const operation = { id: globalThis.crypto.randomUUID(), startedAt: Date.now(), participants: new Set(), done: false };
    operation.participants.add(operation.id);
    const promise = new Promise((resolve, reject) => { operation.resolve = resolve; operation.reject = reject; });
    operation.promise = promise.finally(() => { if (active === operation) active = undefined; });
    active = operation;
    if (channel) operation.timer = schedule(() => finish(operation, { ok: false, error: timeoutError() }), timeoutMs);
    post({ type: 'request', id: operation.id, startedAt: operation.startedAt });
    const work = locks?.request ? locks.request(lockName, channel ? { mode: 'exclusive', ifAvailable: true } : { mode: 'exclusive' },
      lock => lock ? perform(operation) : undefined) : perform(operation);
    Promise.resolve(work).catch(error => finish(operation, { ok: false, error: errorPayload(error) }));
    return operation.promise;
  }
  return { run, close() {
    if (closed) return;
    closed = true; lastResult = undefined;
    if (active) finish(active, { ok: false, error: connectionError() });
    channel?.close();
  } };
}
