import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTab, tabUrl } from '../public/tabs.mjs';

test('valid tab values are preserved and schedule aliases to credits', () => {
  assert.equal(normalizeTab('calendar'), 'calendar');
  assert.equal(normalizeTab('credits'), 'credits');
  assert.equal(normalizeTab('schedule'), 'credits');
  assert.equal(normalizeTab('forecast'), 'credits');
  assert.equal(normalizeTab('unknown'), 'credits');
  assert.equal(normalizeTab(null), 'credits');
});

test('tab URL preserves unrelated query values and removes the bootstrap hash', () => {
  assert.equal(
    tabUrl('http://127.0.0.1:1234/?source=desktop&tab=alerts#secret-token', 'credits'),
    '/?source=desktop&tab=credits',
  );
  assert.equal(tabUrl('http://127.0.0.1:1234/#secret-token', 'invalid'), '/?tab=credits');
});
