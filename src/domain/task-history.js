export function buildTaskHistory(entries, workDays, taskId) {
  const taskEntries = entries.filter((entry) => entry.taskId === taskId);
  const entryById = new Map(taskEntries.map((entry) => [entry.id, entry]));
  const spprByEntry = new Map();
  let spprMinutes = 0;

  workDays.forEach((day) => {
    const allocation = day.allocations?.find((item) => item.taskId === taskId);
    if (!allocation) return;
    spprMinutes += Math.max(0, Number(allocation.spprMinutes) || 0);

    const entryAllocations = Array.isArray(allocation.entryAllocations) ? allocation.entryAllocations : [];
    if (entryAllocations.length) {
      entryAllocations.forEach((item) => {
        if (!entryById.has(item.entryId)) return;
        const minutes = Math.max(0, Number(item.spprMinutes) || 0);
        spprByEntry.set(item.entryId, (spprByEntry.get(item.entryId) ?? 0) + minutes);
      });
      return;
    }

    // Old results may not contain entryAllocations. The task total can be
    // attributed safely only when the task has exactly one entry on that day.
    const entriesForDay = taskEntries.filter((entry) => entry.localDate === day.localDate);
    if (entriesForDay.length === 1) spprByEntry.set(entriesForDay[0].id, Math.max(0, Number(allocation.spprMinutes) || 0));
  });

  return {
    actualMinutes: taskEntries.reduce((total, entry) => total + Math.max(0, Number(entry.actualMinutes) || 0), 0),
    spprMinutes,
    entries: taskEntries.map((entry) => ({
      ...entry,
      spprMinutes: spprByEntry.has(entry.id) ? spprByEntry.get(entry.id) : null,
    })),
  };
}

export function getTaskSpprTotals(workDays) {
  const totals = new Map();
  workDays.forEach((day) => {
    (day.allocations ?? []).forEach((allocation) => {
      const minutes = Math.max(0, Number(allocation.spprMinutes) || 0);
      totals.set(allocation.taskId, (totals.get(allocation.taskId) ?? 0) + minutes);
    });
  });
  return totals;
}
