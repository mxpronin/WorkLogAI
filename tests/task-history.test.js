import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskHistory, getTaskSpprTotals } from '../src/domain/task-history.js';

test('task history combines actual entries with their saved SPPR allocation', () => {
  const entries = [
    { id: 'entry-1', taskId: 'task-1', localDate: '2026-07-14', actualMinutes: 60 },
    { id: 'entry-2', taskId: 'task-1', localDate: '2026-07-15', actualMinutes: 30 },
  ];
  const days = [
    { localDate: '2026-07-14', allocations: [{ taskId: 'task-1', spprMinutes: 480, entryAllocations: [{ entryId: 'entry-1', spprMinutes: 480 }] }] },
    { localDate: '2026-07-15', allocations: [] },
  ];

  const history = buildTaskHistory(entries, days, 'task-1');

  assert.equal(history.actualMinutes, 90);
  assert.equal(history.spprMinutes, 480);
  assert.equal(history.entries[0].spprMinutes, 480);
  assert.equal(history.entries[1].spprMinutes, null);
});

test('task history never redistributes a legacy day across several entries', () => {
  const entries = [
    { id: 'entry-1', taskId: 'task-1', localDate: '2026-07-14', actualMinutes: 60 },
    { id: 'entry-2', taskId: 'task-1', localDate: '2026-07-14', actualMinutes: 30 },
  ];
  const days = [{ localDate: '2026-07-14', allocations: [{ taskId: 'task-1', spprMinutes: 480 }] }];

  const history = buildTaskHistory(entries, days, 'task-1');

  assert.equal(history.spprMinutes, 480);
  assert.deepEqual(history.entries.map((entry) => entry.spprMinutes), [null, null]);
});

test('task history supports a legacy allocation when the day has one entry', () => {
  const entries = [{ id: 'entry-1', taskId: 'task-1', localDate: '2026-07-14', actualMinutes: 60 }];
  const days = [{ localDate: '2026-07-14', allocations: [{ taskId: 'task-1', spprMinutes: 480 }] }];

  assert.equal(buildTaskHistory(entries, days, 'task-1').entries[0].spprMinutes, 480);
});

test('task list SPPR totals use all saved day allocations', () => {
  const totals = getTaskSpprTotals([
    { allocations: [{ taskId: 'task-1', spprMinutes: 240 }, { taskId: 'task-2', spprMinutes: 120 }] },
    { allocations: [{ taskId: 'task-1', spprMinutes: 180 }] },
  ]);

  assert.equal(totals.get('task-1'), 420);
  assert.equal(totals.get('task-2'), 120);
});
