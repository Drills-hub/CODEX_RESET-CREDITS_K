import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTab, tabUrl } from '../public/tabs.mjs';

test('valid tab values are preserved and unknown values fall back to schedule', () => {
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
