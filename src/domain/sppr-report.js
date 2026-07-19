import { addDays, formatDate, parseLocalDate, startOfWeek, toLocalDate } from '../utils/format.js';

const DAY_STATUS_LABELS = {
  draft: 'Черновик',
  active: 'Активный',
  finished: 'Завершён',
};

function minutes(value) {
  return Math.max(0, Number(value) || 0);
}

function mergeText(values) {
  const unique = new Set(values.map((value) => String(value ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean));
  return [...unique].join(' ');
}

function allocationText(allocation, entryMap, fallbackEntries) {
  const allocatedEntries = (allocation?.entryAllocations ?? [])
    .map((item) => entryMap.get(item.entryId))
    .filter(Boolean);
  return mergeText([
    ...allocatedEntries.map((entry) => entry.spprDescription || entry.note || entry.transcript),
    allocation?.description,
  ]) || mergeText(fallbackEntries.map((entry) => entry.spprDescription || entry.note || entry.transcript));
}

function inclusiveDayCount(fromDate, toDate) {
  return Math.round((parseLocalDate(toDate) - parseLocalDate(fromDate)) / 86400000) + 1;
}

function chartGroup(localDate, periodDays) {
  if (periodDays <= 31) {
    return {
      key: localDate,
      label: new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(parseLocalDate(localDate)),
    };
  }
  if (periodDays <= 180) {
    const weekStart = startOfWeek(parseLocalDate(localDate));
    const weekEnd = addDays(weekStart, 6);
    return {
      key: `week-${toLocalDate(weekStart)}`,
      label: `${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(weekStart)}–${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(weekEnd)}`,
    };
  }
  const monthDate = parseLocalDate(`${localDate.slice(0, 7)}-01`);
  return {
    key: `month-${localDate.slice(0, 7)}`,
    label: new Intl.DateTimeFormat('ru-RU', { month: 'short', year: '2-digit' }).format(monthDate),
  };
}

function buildTopTasks(rows) {
  const totals = new Map();
  rows.forEach((row) => {
    const current = totals.get(row.taskId) ?? {
      taskId: row.taskId,
      label: row.taskNumber || row.taskTitle || 'Задача',
      actualMinutes: 0,
      spprMinutes: 0,
    };
    current.actualMinutes += row.actualMinutes;
    current.spprMinutes += row.spprMinutes ?? 0;
    totals.set(row.taskId, current);
  });
  const sorted = [...totals.values()].sort((left, right) =>
    right.spprMinutes - left.spprMinutes
    || right.actualMinutes - left.actualMinutes
    || left.label.localeCompare(right.label, 'ru'),
  );
  if (sorted.length <= 10) return sorted;
  const other = sorted.slice(10).reduce((result, item) => ({
    taskId: 'other',
    label: 'Другие',
    actualMinutes: result.actualMinutes + item.actualMinutes,
    spprMinutes: result.spprMinutes + item.spprMinutes,
  }), { actualMinutes: 0, spprMinutes: 0 });
  return [...sorted.slice(0, 10), other];
}

export function buildSpprExportReport({ fromDate, toDate, tasks, entries, workDays }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error('Укажите корректный период отчёта.');
  }
  if (fromDate > toDate) throw new Error('Дата начала не может быть позже даты окончания.');

  const periodEntries = entries.filter((entry) =>
    !entry.deletedAt && entry.localDate >= fromDate && entry.localDate <= toDate,
  );
  const periodDays = workDays.filter((day) => day.localDate >= fromDate && day.localDate <= toDate);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const entryMap = new Map(periodEntries.map((entry) => [entry.id, entry]));
  const dayMap = new Map(periodDays.map((day) => [day.localDate, day]));
  const dates = [...new Set([
    ...periodEntries.map((entry) => entry.localDate),
    ...periodDays.map((day) => day.localDate),
  ])].sort();

  const rows = [];
  const days = dates.map((localDate) => {
    const day = dayMap.get(localDate);
    const dayEntries = periodEntries.filter((entry) => entry.localDate === localDate);
    const state = day?.state ?? 'draft';
    const allocations = state === 'finished' ? day?.allocations ?? [] : [];
    const allocationMap = new Map(allocations.map((allocation) => [allocation.taskId, allocation]));
    const taskIds = [...new Set([
      ...dayEntries.map((entry) => entry.taskId),
      ...allocations.map((allocation) => allocation.taskId),
    ])];
    const dayRows = taskIds.map((taskId) => {
      const task = taskMap.get(taskId);
      const taskEntries = dayEntries.filter((entry) => entry.taskId === taskId);
      const allocation = allocationMap.get(taskId);
      const row = {
        localDate,
        state,
        status: DAY_STATUS_LABELS[state] ?? state,
        taskId,
        taskNumber: task?.spprNumber ?? 'Удалённая задача',
        taskTitle: task?.title ?? '',
        actualMinutes: taskEntries.reduce((total, entry) => total + minutes(entry.actualMinutes), 0),
        spprMinutes: state === 'finished' ? minutes(allocation?.spprMinutes) : null,
        description: state === 'finished' && allocation
          ? allocationText(allocation, entryMap, taskEntries)
          : mergeText(taskEntries.map((entry) => entry.note || entry.transcript || entry.spprDescription)),
      };
      rows.push(row);
      return row;
    });
    return {
      localDate,
      formattedDate: formatDate(localDate, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }),
      state,
      status: DAY_STATUS_LABELS[state] ?? state,
      actualMinutes: dayRows.reduce((total, row) => total + row.actualMinutes, 0),
      spprMinutes: state === 'finished'
        ? allocations.reduce((total, allocation) => total + minutes(allocation.spprMinutes), 0)
        : null,
      targetMinutes: state === 'finished' ? minutes(day?.targetMinutes) : null,
      rows: dayRows,
    };
  });

  const periodLength = inclusiveDayCount(fromDate, toDate);
  const chartMap = new Map();
  days.forEach((day) => {
    const group = chartGroup(day.localDate, periodLength);
    const current = chartMap.get(group.key) ?? { ...group, actualMinutes: 0, spprMinutes: 0 };
    current.actualMinutes += day.actualMinutes;
    current.spprMinutes += day.spprMinutes ?? 0;
    chartMap.set(group.key, current);
  });
  const totalActualMinutes = rows.reduce((total, row) => total + row.actualMinutes, 0);
  const totalSpprMinutes = days.reduce((total, day) => total + (day.spprMinutes ?? 0), 0);

  return {
    fromDate,
    toDate,
    periodLabel: `${formatDate(fromDate, { day: 'numeric', month: 'long', year: 'numeric' })} — ${formatDate(toDate, { day: 'numeric', month: 'long', year: 'numeric' })}`,
    generatedAt: new Date().toISOString(),
    totalActualMinutes,
    totalSpprMinutes,
    differenceMinutes: totalSpprMinutes - totalActualMinutes,
    dayCount: days.length,
    finishedDayCount: days.filter((day) => day.state === 'finished').length,
    activeDayCount: days.filter((day) => day.state === 'active').length,
    draftDayCount: days.filter((day) => day.state === 'draft').length,
    taskCount: new Set(rows.map((row) => row.taskId)).size,
    days,
    rows,
    chartPoints: [...chartMap.values()],
    topTasks: buildTopTasks(rows),
  };
}
