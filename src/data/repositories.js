import { requestToPromise, runTransaction } from './indexeddb/database.js';
import { hasRecordedWork } from '../domain/work-day.js';
import { normalizeSpprLimitMinutes } from '../domain/sppr-limits.js';

const STORE_NAMES = [
  'tasks',
  'workDays',
  'workEntries',
  'entryRevisions',
  'audioAttachments',
  'settings',
];

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function allocatedSpprMinutes(workDays, taskId) {
  return workDays.reduce((total, day) => total + (day.allocations ?? [])
    .filter((allocation) => allocation.taskId === taskId)
    .reduce((sum, allocation) => sum + Math.max(0, Number(allocation.spprMinutes) || 0), 0), 0);
}

function limitNotBelowAllocated(limit, allocated) {
  if (limit === null) return null;
  return Math.max(limit, Math.ceil(allocated / 30) * 30);
}

function entryHasSavedAllocation(workDay, entry) {
  const allocation = workDay?.allocations?.find((item) => item.taskId === entry.taskId);
  if (!allocation) return false;
  const entryAllocations = Array.isArray(allocation.entryAllocations) ? allocation.entryAllocations : [];
  if (!entryAllocations.length) return true;
  return entryAllocations.some((item) => item.entryId === entry.id);
}

function reconcileDayAfterEntryMutation(workDays, day, remainingEntries, {
  invalidateFinished = false,
  timestamp = now(),
} = {}) {
  if (!day) return;
  if (!remainingEntries.length) {
    workDays.delete(day.id);
    return;
  }
  if (day.state !== 'finished' || !invalidateFinished) return;
  if (hasRecordedWork(remainingEntries)) {
    workDays.put({
      ...day,
      state: 'active',
      finishedAt: null,
      allocationStrategy: null,
      allocations: [],
      aiWarnings: [],
      updatedAt: timestamp,
    });
    return;
  }
  workDays.put({
    ...day,
    state: 'draft',
    startedAt: null,
    finishedAt: null,
    allocationStrategy: null,
    allocations: [],
    aiWarnings: [],
    updatedAt: timestamp,
  });
}

async function keepSingleStartedDay(workDays, timestamp = now()) {
  const activeDays = (await requestToPromise(workDays.getAll()))
    .filter((day) => day.state === 'active' && day.startedAt)
    .sort((left, right) =>
      String(right.startedAt).localeCompare(String(left.startedAt))
      || right.localDate.localeCompare(left.localDate),
    );
  activeDays.slice(1).forEach((day) => workDays.put({
    ...day,
    state: 'draft',
    startedAt: null,
    finishedAt: null,
    allocationStrategy: null,
    allocations: [],
    aiWarnings: [],
    updatedAt: timestamp,
  }));
  return { keptDate: activeDays[0]?.localDate ?? null, normalized: Math.max(0, activeDays.length - 1) };
}

function isValidLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]);
}

export const taskRepository = {
  async list({ includeArchived = false } = {}) {
    return runTransaction(['tasks'], 'readonly', async (transaction) => {
      const tasks = await requestToPromise(transaction.objectStore('tasks').getAll());
      return tasks
        .filter((task) => includeArchived || task.status !== 'archived')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  },

  async get(id) {
    if (!id) return null;
    return runTransaction(['tasks'], 'readonly', (transaction) =>
      requestToPromise(transaction.objectStore('tasks').get(id)),
    );
  },

  async save(input) {
    const title = normalizeText(input.title);
    const spprNumber = normalizeText(input.spprNumber).toUpperCase();
    if (!title) throw new Error('Укажите название задачи.');
    if (!spprNumber) throw new Error('Укажите номер СППР.');

    return runTransaction(['tasks', 'workDays'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('tasks');
      const tasks = await requestToPromise(store.getAll());
      const duplicate = tasks.find((task) =>
        task.id !== input.id && task.status !== 'archived' && task.spprNumber === spprNumber,
      );
      if (duplicate) throw new Error('Задача с таким номером СППР уже существует.');

      const existing = input.id ? await requestToPromise(store.get(input.id)) : null;
      const workDays = await requestToPromise(transaction.objectStore('workDays').getAll());
      const requestedLimit = normalizeSpprLimitMinutes(input.maxSpprMinutes);
      if (input.maxSpprMinutes !== null && input.maxSpprMinutes !== undefined && input.maxSpprMinutes !== '' && requestedLimit === null) {
        throw new Error('Максимум часов должен быть неотрицательным числом с шагом 30 минут.');
      }
      const alreadyAllocated = allocatedSpprMinutes(workDays, existing?.id ?? input.id);
      const maxSpprMinutes = limitNotBelowAllocated(requestedLimit, alreadyAllocated);
      const timestamp = now();
      const task = {
        id: existing?.id ?? createId(),
        spprNumber,
        title,
        description: String(input.description ?? '').trim(),
        status: ['active', 'paused', 'completed', 'archived'].includes(input.status)
          ? input.status
          : 'active',
        excludeFromSppr: input.excludeFromSppr === true,
        maxSpprMinutes,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        archivedAt: input.status === 'archived' ? existing?.archivedAt ?? timestamp : null,
      };
      store.put(task);
      return task;
    });
  },

  async archive(id) {
    const task = await this.get(id);
    if (!task) throw new Error('Задача не найдена.');
    return this.save({ ...task, status: 'archived' });
  },

  async applyGlobalSpprLimit({ enabled, maxMinutes }) {
    const normalizedLimit = normalizeSpprLimitMinutes(maxMinutes);
    if (enabled && normalizedLimit === null) throw new Error('Укажите общий лимит часов.');
    return runTransaction(['tasks', 'workDays', 'settings'], 'readwrite', async (transaction) => {
      const tasksStore = transaction.objectStore('tasks');
      const settingsStore = transaction.objectStore('settings');
      const [tasks, workDays] = await Promise.all([
        requestToPromise(tasksStore.getAll()),
        requestToPromise(transaction.objectStore('workDays').getAll()),
      ]);
      const timestamp = now();
      let adjustedCount = 0;
      tasks.forEach((task) => {
        const allocated = allocatedSpprMinutes(workDays, task.id);
        const taskLimit = enabled ? limitNotBelowAllocated(normalizedLimit, allocated) : null;
        if (enabled && taskLimit > normalizedLimit) adjustedCount += 1;
        tasksStore.put({ ...task, maxSpprMinutes: taskLimit, updatedAt: timestamp });
      });
      settingsStore.put({ key: 'globalTaskLimitEnabled', value: enabled === true, updatedAt: timestamp });
      settingsStore.put({ key: 'globalTaskLimitMinutes', value: normalizedLimit, updatedAt: timestamp });
      return { adjustedCount, maxMinutes: normalizedLimit };
    });
  },

  async remove(id) {
    if (!id) throw new Error('Задача не найдена.');
    return runTransaction(['tasks', 'workDays', 'workEntries', 'entryRevisions', 'audioAttachments'], 'readwrite', async (transaction) => {
      const tasks = transaction.objectStore('tasks');
      const task = await requestToPromise(tasks.get(id));
      if (!task) throw new Error('Задача не найдена.');
      const entries = transaction.objectStore('workEntries');
      const taskEntries = (await requestToPromise(entries.getAll())).filter((entry) => entry.taskId === id);
      const entryIds = new Set(taskEntries.map((entry) => entry.id));
      taskEntries.forEach((entry) => entries.delete(entry.id));

      const revisions = transaction.objectStore('entryRevisions');
      (await requestToPromise(revisions.getAll())).filter((revision) => entryIds.has(revision.workEntryId)).forEach((revision) => revisions.delete(revision.id));
      const attachments = transaction.objectStore('audioAttachments');
      (await requestToPromise(attachments.getAll())).filter((attachment) => entryIds.has(attachment.workEntryId)).forEach((attachment) => attachments.delete(attachment.id));

      const workDays = transaction.objectStore('workDays');
      const timestamp = now();
      const remainingEntries = (await requestToPromise(entries.getAll())).filter((entry) => !entryIds.has(entry.id) && !entry.deletedAt);
      (await requestToPromise(workDays.getAll())).forEach((day) => {
        const invalidateFinished = day.allocations?.some((allocation) => allocation.taskId === id) === true;
        const dayEntries = remainingEntries.filter((entry) => entry.localDate === day.localDate);
        if (invalidateFinished || taskEntries.some((entry) => entry.localDate === day.localDate)) {
          reconcileDayAfterEntryMutation(workDays, day, dayEntries, { invalidateFinished, timestamp });
        }
      });
      await keepSingleStartedDay(workDays, timestamp);
      tasks.delete(id);
    });
  },
};

export const workEntryRepository = {
  async list({ taskId, localDate, fromDate, toDate, includeDeleted = false } = {}) {
    return runTransaction(['workEntries'], 'readonly', async (transaction) => {
      let entries = await requestToPromise(transaction.objectStore('workEntries').getAll());
      if (!includeDeleted) entries = entries.filter((entry) => !entry.deletedAt);
      if (taskId) entries = entries.filter((entry) => entry.taskId === taskId);
      if (localDate) entries = entries.filter((entry) => entry.localDate === localDate);
      if (fromDate) entries = entries.filter((entry) => entry.localDate >= fromDate);
      if (toDate) entries = entries.filter((entry) => entry.localDate <= toDate);
      return entries.sort((left, right) =>
        right.localDate.localeCompare(left.localDate) || right.createdAt.localeCompare(left.createdAt),
      );
    });
  },

  async get(id) {
    if (!id) return null;
    return runTransaction(['workEntries'], 'readonly', (transaction) =>
      requestToPromise(transaction.objectStore('workEntries').get(id)),
    );
  },

  async getMoveImpact(id, nextLocalDate) {
    if (!id || !isValidLocalDate(nextLocalDate)) return { requiresConfirmation: false, affectedDates: [] };
    return runTransaction(['workEntries', 'workDays'], 'readonly', async (transaction) => {
      const entry = await requestToPromise(transaction.objectStore('workEntries').get(id));
      if (!entry || entry.deletedAt || entry.localDate === nextLocalDate) {
        return { requiresConfirmation: false, affectedDates: [] };
      }
      const workDays = transaction.objectStore('workDays');
      const [sourceDay, destinationDay] = await Promise.all([
        requestToPromise(workDays.index('localDate').get(entry.localDate)),
        requestToPromise(workDays.index('localDate').get(nextLocalDate)),
      ]);
      const affectedDates = [];
      if (sourceDay?.state === 'finished' && entryHasSavedAllocation(sourceDay, entry)) affectedDates.push(entry.localDate);
      if (destinationDay?.state === 'finished' && entry.excludeFromSppr !== true) affectedDates.push(nextLocalDate);
      return { requiresConfirmation: affectedDates.length > 0, affectedDates };
    });
  },

  async save(input, newAttachments = []) {
    const note = String(input.note ?? '').trim();
    const actualMinutes = Number(input.actualMinutes);
    if (!input.taskId) throw new Error('Выберите задачу.');
    if (!isValidLocalDate(input.localDate)) throw new Error('Укажите корректную дату.');
    if (!Number.isInteger(actualMinutes) || actualMinutes < 0 || actualMinutes > 1440) {
      throw new Error('Время должно быть от 0 до 24 часов.');
    }
    if (!note && input.entryType === 'text') throw new Error('Введите текст заметки.');
    const normalizedAttachments = (Array.isArray(newAttachments) ? newAttachments : [newAttachments])
      .filter(Boolean)
      .map((attachment) => attachment instanceof Blob
        ? { blob: attachment, filename: 'worklog-attachment', mimeType: attachment.type, kind: 'file' }
        : attachment)
      .filter((attachment) => attachment?.blob instanceof Blob);
    if (normalizedAttachments.some((attachment) => attachment.blob.size > 25 * 1024 * 1024)) {
      throw new Error('Размер каждого вложения не должен превышать 25 МБ.');
    }

    return runTransaction(
      ['tasks', 'workDays', 'workEntries', 'entryRevisions', 'audioAttachments'],
      'readwrite',
      async (transaction) => {
        const task = await requestToPromise(transaction.objectStore('tasks').get(input.taskId));
        if (!task || task.status === 'archived') throw new Error('Выбранная задача недоступна.');

        const entries = transaction.objectStore('workEntries');
        const existing = input.id ? await requestToPromise(entries.get(input.id)) : null;
        if (!existing && input.submissionKey) {
          const alreadySaved = await requestToPromise(entries.index('submissionKey').get(input.submissionKey));
          if (alreadySaved) return alreadySaved;
        }
        const timestamp = now();
        if (existing) {
          transaction.objectStore('entryRevisions').put({
            id: createId(),
            workEntryId: existing.id,
            revision: existing.revision,
            taskId: existing.taskId,
            note: existing.note,
            actualMinutes: existing.actualMinutes,
            localDate: existing.localDate,
            changedAt: timestamp,
          });
        }

        const submissionKey = existing?.submissionKey ?? input.submissionKey;
        const entry = {
          id: existing?.id ?? createId(),
          taskId: input.taskId,
          localDate: input.localDate,
          entryType: ['text', 'voice', 'file'].includes(input.entryType) ? input.entryType : 'text',
          ...(submissionKey ? { submissionKey } : {}),
          note,
          actualMinutes,
          excludeFromSppr: existing ? existing.excludeFromSppr === true : task.excludeFromSppr === true,
          source: input.entryType === 'text' ? 'manual' : input.entryType === 'voice' ? 'audio' : 'attachment',
          transcript: input.entryType === 'text' ? null : existing?.transcript ?? null,
          spprDescription: existing?.spprDescription ?? null,
          aiMeta: existing?.aiMeta ?? null,
          revision: (existing?.revision ?? 0) + 1,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          deletedAt: null,
        };
        entries.put(entry);

        const workDays = transaction.objectStore('workDays');
        const dayIndex = workDays.index('localDate');
        const workDay = await requestToPromise(dayIndex.get(input.localDate));
        const sourceDay = existing && existing.localDate !== input.localDate
          ? await requestToPromise(dayIndex.get(existing.localDate))
          : null;
        const allWorkDays = await requestToPromise(workDays.getAll());
        const taskLimit = normalizeSpprLimitMinutes(task.maxSpprMinutes);
        const taskLimitReached = taskLimit !== null && taskLimit - allocatedSpprMinutes(allWorkDays, task.id) < 30;
        if (!workDay) {
          workDays.put({
            id: createId(),
            localDate: input.localDate,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            // A note may be added before the user explicitly starts the day.
            state: 'draft',
            startedAt: null,
            finishedAt: null,
            targetMinutes: 480,
          });
        } else if (workDay.state === 'finished') {
          const sameDayAllocatedEdit = existing
            && existing.localDate === input.localDate
            && entryHasSavedAllocation(workDay, existing);
          const addedEligibleEntry = (!existing || existing.localDate !== input.localDate)
            && entry.excludeFromSppr !== true
            && !taskLimitReached;
          if (sameDayAllocatedEdit || addedEligibleEntry) {
            const currentEntries = (await requestToPromise(entries.index('localDate').getAll(input.localDate)))
              .filter((item) => !item.deletedAt);
            reconcileDayAfterEntryMutation(workDays, workDay, currentEntries, {
              invalidateFinished: true,
              timestamp,
            });
          }
        }
        if (sourceDay?.state === 'finished' && entryHasSavedAllocation(sourceDay, existing)) {
          const remainingSourceEntries = (await requestToPromise(entries.index('localDate').getAll(existing.localDate)))
            .filter((item) => !item.deletedAt && item.id !== entry.id);
          reconcileDayAfterEntryMutation(workDays, sourceDay, remainingSourceEntries, {
            invalidateFinished: true,
            timestamp,
          });
        }
        await keepSingleStartedDay(workDays, timestamp);

        const attachments = transaction.objectStore('audioAttachments');
        const current = await requestToPromise(attachments.index('workEntryId').getAll(entry.id));
        if (current.length + normalizedAttachments.length > 10) throw new Error('К одной записи можно прикрепить не более 10 файлов.');
        normalizedAttachments.forEach((attachment) => {
          attachments.put({
            id: createId(),
            workEntryId: entry.id,
            blob: attachment.blob,
            filename: String(attachment.filename || 'worklog-attachment').slice(0, 255),
            mimeType: attachment.mimeType || attachment.blob.type || 'application/octet-stream',
            kind: attachment.kind || 'file',
            sizeBytes: attachment.blob.size,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        });

        return entry;
      },
    );
  },

  async remove(id) {
    return runTransaction(['workEntries', 'workDays', 'entryRevisions', 'audioAttachments'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workEntries');
      const entry = await requestToPromise(store.get(id));
      if (!entry) return;
      const timestamp = now();
      store.delete(entry.id);
      const revisions = transaction.objectStore('entryRevisions');
      (await requestToPromise(revisions.index('workEntryId').getAll(entry.id)))
        .forEach((revision) => revisions.delete(revision.id));
      const attachments = transaction.objectStore('audioAttachments');
      (await requestToPromise(attachments.index('workEntryId').getAll(entry.id)))
        .forEach((attachment) => attachments.delete(attachment.id));
      const workDays = transaction.objectStore('workDays');
      const workDay = await requestToPromise(workDays.index('localDate').get(entry.localDate));
      const remainingEntries = (await requestToPromise(store.index('localDate').getAll(entry.localDate)))
        .filter((item) => !item.deletedAt && item.id !== entry.id);
      reconcileDayAfterEntryMutation(workDays, workDay, remainingEntries, {
        invalidateFinished: workDay?.state === 'finished' && entryHasSavedAllocation(workDay, entry),
        timestamp,
      });
      await keepSingleStartedDay(workDays, timestamp);
    });
  },

  async saveAiResult(id, { spprDescription, transcript = null, warnings = [], mode }) {
    return runTransaction(['workEntries'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workEntries');
      const entry = await requestToPromise(store.get(id));
      if (!entry || entry.deletedAt) throw new Error('Запись не найдена.');
      const updated = {
        ...entry,
        transcript: transcript ?? entry.transcript ?? null,
        spprDescription: String(spprDescription ?? '').trim(),
        aiMeta: { mode, warnings: Array.isArray(warnings) ? warnings : [], promptVersion: 1, processedAt: now() },
        updatedAt: now(),
      };
      store.put(updated);
      return updated;
    });
  },

  async saveSpprDescription(id, spprDescription) {
    const text = String(spprDescription ?? '').trim();
    if (!text) throw new Error('Введите описание СППР.');
    return runTransaction(['workEntries'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workEntries');
      const entry = await requestToPromise(store.get(id));
      if (!entry || entry.deletedAt) throw new Error('Запись не найдена.');
      const updatedAt = now();
      const updated = {
        ...entry,
        spprDescription: text,
        aiMeta: { ...(entry.aiMeta ?? {}), mode: 'manual', editedAt: updatedAt },
        updatedAt,
      };
      store.put(updated);
      return updated;
    });
  },

  async saveTranscript(id, transcript) {
    const text = String(transcript ?? '').trim();
    if (!text) throw new Error('Расшифровка аудио пуста.');
    return runTransaction(['workEntries'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workEntries');
      const entry = await requestToPromise(store.get(id));
      if (!entry || entry.deletedAt) throw new Error('Запись не найдена.');
      const updated = { ...entry, transcript: text, updatedAt: now() };
      store.put(updated);
      return updated;
    });
  },

  async listAttachments(workEntryId) {
    return runTransaction(['audioAttachments'], 'readonly', (transaction) =>
      requestToPromise(transaction.objectStore('audioAttachments').index('workEntryId').getAll(workEntryId)),
    );
  },

  async getAudio(workEntryId) {
    const attachments = await this.listAttachments(workEntryId);
    return attachments.find((attachment) => String(attachment.mimeType || attachment.blob?.type || '').startsWith('audio/')) ?? null;
  },
};

export const workDayRepository = {
  async get(localDate) {
    if (!localDate) return null;
    return runTransaction(['workDays'], 'readonly', (transaction) =>
      requestToPromise(transaction.objectStore('workDays').index('localDate').get(localDate)),
    );
  },

  async saveResult({ localDate, targetMinutes, strategy, allocations, aiWarnings = [] }) {
    return runTransaction(['workDays'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workDays');
      const existing = await requestToPromise(store.index('localDate').get(localDate));
      const timestamp = now();
      const workDay = {
        id: existing?.id ?? createId(),
        localDate,
        timeZone: existing?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        state: 'finished',
        startedAt: existing?.startedAt ?? null,
        finishedAt: timestamp,
        targetMinutes,
        allocationStrategy: strategy,
        allocations,
        aiWarnings,
        updatedAt: timestamp,
      };
      store.put(workDay);
      return workDay;
    });
  },

  async resetEmpty(localDate) {
    return runTransaction(['workDays', 'workEntries'], 'readwrite', async (transaction) => {
      const days = transaction.objectStore('workDays');
      const existing = await requestToPromise(days.index('localDate').get(localDate));
      if (!existing) return { removed: false, draft: false };
      const entries = await requestToPromise(transaction.objectStore('workEntries').index('localDate').getAll(localDate));
      const hasEntries = entries.some((entry) => !entry.deletedAt);
      if (!hasEntries) {
        days.delete(existing.id);
        return { removed: true, draft: false };
      }
      days.put({
        ...existing,
        state: 'draft',
        startedAt: null,
        finishedAt: null,
        allocationStrategy: null,
        allocations: [],
        aiWarnings: [],
        updatedAt: now(),
      });
      return { removed: false, draft: true };
    });
  },

  async ensureDraft({ localDate, targetMinutes }) {
    return runTransaction(['workDays'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workDays');
      const existing = await requestToPromise(store.index('localDate').get(localDate));
      if (existing) return existing;
      const timestamp = now();
      const workDay = {
        id: createId(),
        localDate,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        state: 'draft',
        startedAt: null,
        finishedAt: null,
        targetMinutes,
        allocationStrategy: null,
        allocations: [],
        updatedAt: timestamp,
      };
      store.put(workDay);
      return workDay;
    });
  },

  async start({ localDate, targetMinutes }) {
    return runTransaction(['workDays'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workDays');
      const existing = await requestToPromise(store.index('localDate').get(localDate));
      if (existing?.state === 'finished') throw new Error('Этот день уже завершён. Откройте результат или внесите новую запись для перерасчёта.');
      const activeDay = (await requestToPromise(store.getAll())).find((day) =>
        day.localDate !== localDate && day.state === 'active' && day.startedAt,
      );
      if (activeDay) {
        const error = new Error(`Уже активен рабочий день за ${activeDay.localDate}. Завершите его перед запуском другого.`);
        error.code = 'ACTIVE_DAY_EXISTS';
        error.activeLocalDate = activeDay.localDate;
        throw error;
      }
      const timestamp = now();
      if (existing) {
        const started = {
          ...existing,
          state: 'active',
          startedAt: existing.startedAt ?? timestamp,
          targetMinutes: existing.targetMinutes ?? targetMinutes,
          updatedAt: timestamp,
        };
        store.put(started);
        return started;
      }
      const workDay = {
        id: createId(),
        localDate,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        state: 'active',
        startedAt: timestamp,
        finishedAt: null,
        targetMinutes,
        allocationStrategy: null,
        allocations: [],
        updatedAt: timestamp,
      };
      store.put(workDay);
      return workDay;
    });
  },

  async list({ fromDate, toDate } = {}) {
    return runTransaction(['workDays'], 'readonly', async (transaction) => {
      let days = await requestToPromise(transaction.objectStore('workDays').getAll());
      if (fromDate) days = days.filter((day) => day.localDate >= fromDate);
      if (toDate) days = days.filter((day) => day.localDate <= toDate);
      return days.sort((left, right) => left.localDate.localeCompare(right.localDate));
    });
  },

  async normalizeLegacyDrafts() {
    return runTransaction(['workDays'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workDays');
      const days = await requestToPromise(store.getAll());
      const timestamp = now();
      let migrated = 0;
      days.forEach((day) => {
        if (day.state === 'active' && !day.startedAt && !day.finishedAt) {
          store.put({ ...day, state: 'draft', updatedAt: timestamp });
          migrated += 1;
        }
      });
      return migrated;
    });
  },

  async normalizeMultipleActiveDays() {
    return runTransaction(['workDays'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('workDays');
      return keepSingleStartedDay(store);
    });
  },

  async normalizeEmptyFinishedDays() {
    return runTransaction(['workDays', 'workEntries'], 'readwrite', async (transaction) => {
      const days = transaction.objectStore('workDays');
      const allDays = await requestToPromise(days.getAll());
      const allEntries = await requestToPromise(transaction.objectStore('workEntries').getAll());
      const entriesByDate = allEntries.reduce((map, entry) => {
        if (entry.deletedAt) return map;
        const entries = map.get(entry.localDate) ?? [];
        entries.push(entry);
        map.set(entry.localDate, entries);
        return map;
      }, new Map());
      const timestamp = now();
      let migrated = 0;
      allDays.forEach((day) => {
        if (day.state !== 'finished') return;
        const entries = entriesByDate.get(day.localDate) ?? [];
        if (hasRecordedWork(entries)) return;
        if (!entries.length) days.delete(day.id);
        else days.put({
          ...day,
          state: 'draft',
          startedAt: null,
          finishedAt: null,
          allocationStrategy: null,
          allocations: [],
          aiWarnings: [],
          updatedAt: timestamp,
        });
        migrated += 1;
      });
      return migrated;
    });
  },
};

export const settingsRepository = {
  async get(key, fallback = null) {
    const setting = await runTransaction(['settings'], 'readonly', (transaction) =>
      requestToPromise(transaction.objectStore('settings').get(key)),
    );
    return setting?.value ?? fallback;
  },

  async set(key, value) {
    await runTransaction(['settings'], 'readwrite', (transaction) => {
      transaction.objectStore('settings').put({ key, value, updatedAt: now() });
    });
    return value;
  },

  async all() {
    const settings = await runTransaction(['settings'], 'readonly', (transaction) =>
      requestToPromise(transaction.objectStore('settings').getAll()),
    );
    return Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
  },
};

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(',');
  const mimeType = header.match(/^data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

export async function createBackup() {
  const values = await runTransaction(STORE_NAMES, 'readonly', (transaction) =>
    Promise.all(STORE_NAMES.map((storeName) =>
      requestToPromise(transaction.objectStore(storeName).getAll()),
    )),
  );
  const stores = Object.fromEntries(STORE_NAMES.map((name, index) => [name, values[index]]));
  stores.settings = stores.settings.map((setting) => {
    if (setting.key !== 'aiConfig' || !setting.value || typeof setting.value !== 'object') return setting;
    const { apiKey, ...aiConfig } = setting.value;
    return { ...setting, value: aiConfig };
  });
  stores.audioAttachments = await Promise.all(stores.audioAttachments.map(async (attachment) => ({
    ...attachment,
    blob: undefined,
    dataUrl: attachment.blob ? await blobToDataUrl(attachment.blob) : null,
  })));
  return {
    app: 'worklog-ai',
    backupVersion: 1,
    createdAt: now(),
    stores,
  };
}

export async function restoreBackup(backup) {
  if (backup?.app !== 'worklog-ai' || backup?.backupVersion !== 1 || !backup.stores) {
    throw new Error('Это не резервная копия WorkLog AI.');
  }
  const restoredStores = Object.fromEntries(STORE_NAMES.map((name) => [
    name,
    Array.isArray(backup.stores[name]) ? backup.stores[name] : [],
  ]));
  restoredStores.audioAttachments = restoredStores.audioAttachments.map(({ dataUrl, ...attachment }) => ({
    ...attachment,
    blob: dataUrl ? dataUrlToBlob(dataUrl) : null,
  }));

  await runTransaction(STORE_NAMES, 'readwrite', (transaction) => {
    for (const storeName of STORE_NAMES) {
      const store = transaction.objectStore(storeName);
      store.clear();
      for (const record of restoredStores[storeName]) store.put(record);
    }
  });
}

export async function seedInitialData() {
  // Kept as a no-op for backwards-compatible imports. Production installations
  // must start with an empty journal instead of synthetic work records.
}
