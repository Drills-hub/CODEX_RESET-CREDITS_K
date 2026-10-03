import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, updateState } from '../public/state.mjs';

const snapshot = { queriedAt: 100, availableCount: 1, detailState: 'complete', credits: [], revision: 1 };
test('failed refresh preserves prior data and its original query time', () => {
  const loaded = updateState(initialState(), { type: 'success', snapshot });
  const failed = updateState(loaded, { type: 'failure', error: { code: 'TIMEOUT', message: 'timeout', clearPrevious: false } });
  assert.equal(failed.snapshot, snapshot);
  assert.equal(failed.snapshot.queriedAt, 100);
  assert.match(failed.message, /최신 정보 확인 실패/);
});
test('confirmed account changes clear previous data immediately', () => {
  const loaded = updateState(initialState(), { type: 'success', snapshot });
  assert.equal(loaded.snapshot, snapshot);
  const changed = updateState(loaded, { type: 'status', status: { revision: 2, authState: 'chatgpt', connected: true } });
  assert.equal(changed.snapshot, null);
  const signedOut = updateState(loaded, { type: 'failure', error: { code: 'LOGIN_REQUIRED', message: 'login', clearPrevious: true } });
  assert.equal(signedOut.snapshot, null);
});
test('late results from an invalidated account are never redisplayed', () => {
  const changed = updateState(initialState(), { type: 'status', status: { revision: 2, authState: 'chatgpt', connected: true } });
  assert.equal(changed.revision, 2);
  assert.equal(updateState(changed, { type: 'success', snapshot: { ...snapshot, revision: 2 } }).snapshot.availableCount, 1);
  assert.equal(updateState(changed, { type: 'success', snapshot }).snapshot, null);
});
test('starting a refresh marks it busy while retaining the last good result', () => {
  const loaded = updateState(initialState(), { type: 'success', snapshot });
  const loading = updateState(loaded, { type: 'loading' });
  assert.equal(loading.loading, true);
  assert.equal(loading.snapshot, snapshot);
});
test('out-of-order status responses cannot restore a previous account snapshot', () => {
  const loaded = updateState(initialState(), { type: 'success', snapshot });
  const signedOut = updateState(loaded, { type: 'status', status: { revision: 2, authState: 'signed-out', connected: true } });
  const stale = updateState(signedOut, { type: 'status', status: { revision: 1, authState: 'chatgpt', connected: true } });
  assert.equal(stale.revision, 2);
  assert.equal(stale.authState, 'signed-out');
  assert.equal(updateState(stale, { type: 'success', snapshot }).snapshot, null);
});

test('usage read failure stays stale through status polling and retries until a successful usage read', () => {
  const loaded = updateState(initialState(), { type: 'success', snapshot });
  assert.equal(loaded.usageStale, false);
  const failed = updateState(loaded, { type: 'failure', error: { code: 'TIMEOUT', message: 'timeout', clearPrevious: false } });
  assert.equal(failed.usageStale, true);
  const polled = updateState(failed, { type: 'status', status: { revision: 1, authState: 'chatgpt', connected: true } });
  assert.equal(polled.usageStale, true);
  const retrying = updateState(polled, { type: 'loading' });
  assert.equal(retrying.usageStale, true);
  assert.equal(updateState(retrying, { type: 'success', snapshot }).usageStale, false);
});
