import { distributeRoundedMinutes, roundToInterval } from '../utils/format.js';

export function normalizeSpprLimitMinutes(value, interval = 30) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return roundToInterval(minutes, interval);
}

export function getRemainingSpprMinutes(maxSpprMinutes, allocatedMinutes, interval = 30) {
  const limit = normalizeSpprLimitMinutes(maxSpprMinutes, interval);
  if (limit === null) return null;
  const remaining = Math.max(0, limit - Math.max(0, Number(allocatedMinutes) || 0));
  return Math.floor(remaining / interval) * interval;
}

export function distributeSpprWithLimits(items, targetMinutes, weightKey = 'actualMinutes', interval = 30) {
  const normalizedTarget = roundToInterval(targetMinutes, interval);
  const allocations = new Map(items.map((item) => [item, 0]));
  let remainingTarget = normalizedTarget;

  while (remainingTarget > 0) {
    const candidates = items.filter((item) => {
      const allocated = allocations.get(item) ?? 0;
      const capacity = item.remainingSpprMinutes === null || item.remainingSpprMinutes === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Number(item.remainingSpprMinutes) || 0);
      return allocated < capacity && Math.max(0, Number(item[weightKey]) || 0) > 0;
    });
    if (!candidates.length) break;

    const proposed = distributeRoundedMinutes(candidates, remainingTarget, weightKey, interval);
    let distributed = 0;
    proposed.forEach((item) => {
      const source = candidates.find((candidate) => candidate === item || candidate.taskId === item.taskId);
      if (!source) return;
      const alreadyAllocated = allocations.get(source) ?? 0;
      const capacity = source.remainingSpprMinutes === null || source.remainingSpprMinutes === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Number(source.remainingSpprMinutes) || 0);
      const granted = Math.min(item.spprMinutes, Math.max(0, capacity - alreadyAllocated));
      allocations.set(source, alreadyAllocated + granted);
      distributed += granted;
    });
    if (distributed <= 0) break;
    remainingTarget -= distributed;
  }

  return items.map((item) => ({ ...item, spprMinutes: allocations.get(item) ?? 0 }));
}
