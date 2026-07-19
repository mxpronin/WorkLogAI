import test from 'node:test';
import assert from 'node:assert/strict';

import { distributeRoundedMinutes, roundToInterval } from '../src/utils/format.js';

test('rounded distribution keeps the target total and 30-minute step', () => {
  const result = distributeRoundedMinutes([
    { id: 'a', actualMinutes: 148 },
    { id: 'b', actualMinutes: 92 },
    { id: 'c', actualMinutes: 40 },
  ], 480);

  assert.equal(result.reduce((total, item) => total + item.spprMinutes, 0), 480);
  assert.ok(result.every((item) => item.spprMinutes % 30 === 0));
});

test('target is normalized to the nearest 30 minutes', () => {
  assert.equal(roundToInterval(465, 30), 480);
  assert.equal(roundToInterval(450, 30), 450);
});
