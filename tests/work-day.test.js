import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecordedWork } from '../src/domain/work-day.js';

test('an empty day has no recorded work', () => {
  assert.equal(hasRecordedWork([]), false);
});

test('zero-minute entries do not complete a work day', () => {
  assert.equal(hasRecordedWork([{ actualMinutes: 0 }, { actualMinutes: '0' }]), false);
});

test('a positive-duration entry makes the day eligible for completion', () => {
  assert.equal(hasRecordedWork([{ actualMinutes: 0 }, { actualMinutes: 15 }]), true);
});
