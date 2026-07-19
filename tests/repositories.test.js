import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { requestToPromise, resetDatabaseForTests, runTransaction } from '../src/data/indexeddb/database.js';
import { createBackup, restoreBackup, settingsRepository, taskRepository, workDayRepository, workEntryRepository } from '../src/data/repositories.js';

async function reset() {
  await resetDatabaseForTests();
}

async function createTask(overrides = {}) {
  return taskRepository.save({
    spprNumber: overrides.spprNumber ?? `СППР-${Math.random().toString(16).slice(2, 8)}`,
    title: overrides.title ?? 'Тестовая задача',
    description: '',
    status: 'active',
    excludeFromSppr: overrides.excludeFromSppr === true,
    maxSpprMinutes: null,
  });
}

async function createEntry(task, localDate, overrides = {}) {
  return workEntryRepository.save({
    taskId: task.id,
    localDate,
    entryType: overrides.entryType ?? 'text',
    note: overrides.note ?? 'Выполненная работа',
    actualMinutes: overrides.actualMinutes ?? 60,
  }, overrides.attachments ?? []);
}

async function finishDay(localDate, entries, targetMinutes = 480) {
  await workDayRepository.saveResult({
    localDate,
    targetMinutes,
    strategy: 'manual',
    allocations: entries.map((entry) => ({
      taskId: entry.taskId,
      spprMinutes: targetMinutes / entries.length,
      description: entry.note,
      entryAllocations: [{ entryId: entry.id, spprMinutes: targetMinutes / entries.length }],
    })),
  });
}

async function storeContents(storeName) {
  return runTransaction([storeName], 'readonly', (transaction) =>
    requestToPromise(transaction.objectStore(storeName).getAll()),
  );
}

test('excludeFromSppr is captured only when an entry is created', async () => {
  await reset();
  const task = await createTask();
  const oldEntry = await createEntry(task, '2026-07-01');
  const updatedTask = await taskRepository.save({ ...task, excludeFromSppr: true });
  const excludedEntry = await createEntry(updatedTask, '2026-07-02');
  const editedOldEntry = await workEntryRepository.save({ ...oldEntry, note: 'Исправленный текст' });

  assert.equal(oldEntry.excludeFromSppr, false);
  assert.equal(excludedEntry.excludeFromSppr, true);
  assert.equal(editedOldEntry.excludeFromSppr, false);
});

test('moving the last allocated entry deletes the old day and creates a draft destination', async () => {
  await reset();
  const task = await createTask();
  const entry = await createEntry(task, '2026-07-03');
  await finishDay('2026-07-03', [entry]);

  const impact = await workEntryRepository.getMoveImpact(entry.id, '2026-07-04');
  assert.deepEqual(impact, { requiresConfirmation: true, affectedDates: ['2026-07-03'] });
  assert.equal((await workEntryRepository.get(entry.id)).localDate, '2026-07-03', 'impact check does not move the entry');

  const moved = await workEntryRepository.save({ ...entry, localDate: '2026-07-04' });
  assert.equal(moved.localDate, '2026-07-04');
  assert.equal(await workDayRepository.get('2026-07-03'), undefined);
  assert.equal((await workDayRepository.get('2026-07-04')).state, 'draft');
});

test('moving between finished days invalidates both while keeping only one started active day', async () => {
  await reset();
  const firstTask = await createTask({ spprNumber: 'СППР-101' });
  const secondTask = await createTask({ spprNumber: 'СППР-102' });
  const moving = await createEntry(firstTask, '2026-07-05', { note: 'Перенести' });
  const remaining = await createEntry(secondTask, '2026-07-05', { note: 'Остаётся' });
  const destination = await createEntry(secondTask, '2026-07-06', { note: 'Назначение' });
  await workDayRepository.start({ localDate: '2026-07-05', targetMinutes: 480 });
  await finishDay('2026-07-05', [moving, remaining]);
  await workDayRepository.start({ localDate: '2026-07-06', targetMinutes: 480 });
  await finishDay('2026-07-06', [destination]);

  const impact = await workEntryRepository.getMoveImpact(moving.id, '2026-07-06');
  assert.deepEqual(impact.affectedDates.sort(), ['2026-07-05', '2026-07-06']);
  await workEntryRepository.save({ ...moving, localDate: '2026-07-06' });

  const days = await workDayRepository.list();
  assert.equal(days.filter((day) => day.state === 'active' && day.startedAt).length, 1);
  assert.ok(days.every((day) => day.state !== 'finished'));
  assert.ok(days.every((day) => (day.allocations ?? []).length === 0));
});

test('moving from a zero-only finished day deletes it when it becomes empty', async () => {
  await reset();
  const task = await createTask();
  const entry = await createEntry(task, '2026-07-07', { actualMinutes: 0 });
  await finishDay('2026-07-07', [entry]);

  await workEntryRepository.save({ ...entry, localDate: '2026-07-08' });
  assert.equal(await workDayRepository.get('2026-07-07'), undefined);
  assert.equal((await workDayRepository.get('2026-07-08')).state, 'draft');
});

test('a second active work day is rejected with the active date', async () => {
  await reset();
  await workDayRepository.start({ localDate: '2026-07-09', targetMinutes: 480 });
  await assert.rejects(
    workDayRepository.start({ localDate: '2026-07-10', targetMinutes: 480 }),
    (error) => error.code === 'ACTIVE_DAY_EXISTS' && error.activeLocalDate === '2026-07-09',
  );
});

test('legacy multiple active days keep the latest startedAt', async () => {
  await reset();
  await runTransaction(['workDays'], 'readwrite', (transaction) => {
    const store = transaction.objectStore('workDays');
    store.put({ id: 'old', localDate: '2026-07-11', state: 'active', startedAt: '2026-07-11T08:00:00.000Z', allocations: [] });
    store.put({ id: 'new', localDate: '2026-07-12', state: 'active', startedAt: '2026-07-12T09:00:00.000Z', allocations: [] });
  });

  const result = await workDayRepository.normalizeMultipleActiveDays();
  assert.deepEqual(result, { keptDate: '2026-07-12', normalized: 1 });
  assert.equal((await workDayRepository.get('2026-07-11')).state, 'draft');
  assert.equal((await workDayRepository.get('2026-07-12')).state, 'active');
});

test('deleting an entry physically removes its revisions and attachments', async () => {
  await reset();
  const task = await createTask();
  const entry = await createEntry(task, '2026-07-13', {
    attachments: [{
      blob: new Blob(['вложение'], { type: 'text/plain' }),
      filename: 'пример.txt',
      mimeType: 'text/plain',
      kind: 'file',
    }],
  });
  await workEntryRepository.save({ ...entry, note: 'Новая редакция' });
  assert.equal((await storeContents('entryRevisions')).length, 1);
  assert.equal((await workEntryRepository.listAttachments(entry.id)).length, 1);

  await workEntryRepository.remove(entry.id);
  assert.equal(await workEntryRepository.get(entry.id), undefined);
  assert.equal((await storeContents('entryRevisions')).length, 0);
  assert.equal((await storeContents('audioAttachments')).length, 0);
  assert.equal(await workDayRepository.get('2026-07-13'), undefined);
});

test('deleting a task cascades entries, revisions, attachments and invalidates its day', async () => {
  await reset();
  const removedTask = await createTask({ spprNumber: 'СППР-201' });
  const keptTask = await createTask({ spprNumber: 'СППР-202' });
  const removedEntry = await createEntry(removedTask, '2026-07-14', {
    attachments: [{ blob: new Blob(['x']), filename: 'x.bin', kind: 'file' }],
  });
  await workEntryRepository.save({ ...removedEntry, note: 'Редакция' });
  const keptEntry = await createEntry(keptTask, '2026-07-14');
  await finishDay('2026-07-14', [removedEntry, keptEntry]);

  await taskRepository.remove(removedTask.id);
  assert.equal(await taskRepository.get(removedTask.id), undefined);
  assert.equal(await workEntryRepository.get(removedEntry.id), undefined);
  assert.ok(await workEntryRepository.get(keptEntry.id));
  assert.equal((await storeContents('entryRevisions')).length, 0);
  assert.equal((await storeContents('audioAttachments')).length, 0);
  const day = await workDayRepository.get('2026-07-14');
  assert.notEqual(day.state, 'finished');
  assert.deepEqual(day.allocations, []);
});

test('a backup excludes the AI key and restores stored records', async () => {
  await reset();
  const task = await createTask();
  const entry = await createEntry(task, '2026-07-15');
  await settingsRepository.set('aiConfig', { apiKey: 'secret-key', model: 'openai/gpt-5.4-mini' });

  const backup = await createBackup();
  assert.equal(backup.stores.settings.find((setting) => setting.key === 'aiConfig').value.apiKey, undefined);
  await reset();
  await restoreBackup(backup);

  assert.equal((await taskRepository.get(task.id)).title, task.title);
  assert.equal((await workEntryRepository.get(entry.id)).note, entry.note);
  assert.equal((await settingsRepository.get('aiConfig')).apiKey, undefined);
});
