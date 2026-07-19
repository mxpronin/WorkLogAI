import test from 'node:test';
import assert from 'node:assert/strict';

import { distributeSpprWithLimits, getRemainingSpprMinutes, normalizeSpprLimitMinutes } from '../src/domain/sppr-limits.js';

test('task without a limit keeps the previous proportional distribution', () => {
  const result = distributeSpprWithLimits([
    { taskId: 'a', actualMinutes: 60, remainingSpprMinutes: null },
    { taskId: 'b', actualMinutes: 60, remainingSpprMinutes: null },
  ], 480);

  assert.deepEqual(result.map((item) => item.spprMinutes), [240, 240]);
});

test('distribution never exceeds remaining task capacity and redistributes the rest', () => {
  const result = distributeSpprWithLimits([
    { taskId: 'a', actualMinutes: 60, remainingSpprMinutes: 60 },
    { taskId: 'b', actualMinutes: 60, remainingSpprMinutes: null },
  ], 480);

  assert.deepEqual(result.map((item) => item.spprMinutes), [60, 420]);
});

test('distribution may stay below the day target when all task limits are exhausted', () => {
  const result = distributeSpprWithLimits([
    { taskId: 'a', actualMinutes: 60, remainingSpprMinutes: 30 },
    { taskId: 'b', actualMinutes: 60, remainingSpprMinutes: 60 },
  ], 480);

  assert.equal(result.reduce((sum, item) => sum + item.spprMinutes, 0), 90);
});

test('historic allocation is deducted without changing it and sub-slot remainder is unavailable', () => {
  assert.equal(getRemainingSpprMinutes(600, 420), 180);
  assert.equal(getRemainingSpprMinutes(600, 590), 0);
  assert.equal(getRemainingSpprMinutes(null, 420), null);
  assert.equal(normalizeSpprLimitMinutes(615), 630);
});
