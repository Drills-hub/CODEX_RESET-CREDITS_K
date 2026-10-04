import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAB, TAB_IDS, normalizeTab, tabUrl } from '../public/tabs.mjs';

test('tab values use the approved order and fall back to schedule', () => {
  assert.deepEqual(TAB_IDS, ['schedule', 'forecast', 'alerts', 'credits']);
  assert.equal(DEFAULT_TAB, 'schedule');
  assert.equal(normalizeTab('forecast'), 'forecast');
  assert.equal(normalizeTab('unknown'), 'schedule');
  assert.equal(normalizeTab(null), 'schedule');
});

test('tab URL preserves unrelated query values and removes the bootstrap hash', () => {
  assert.equal(
    tabUrl('http://127.0.0.1:1234/?source=desktop&tab=alerts#secret-token', 'credits'),
    '/?source=desktop&tab=credits',
  );
  assert.equal(tabUrl('http://127.0.0.1:1234/#secret-token', 'invalid'), '/?tab=schedule');
});
