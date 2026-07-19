export function hasRecordedWork(entries) {
  return entries.some((entry) => Number(entry.actualMinutes) > 0);
}
