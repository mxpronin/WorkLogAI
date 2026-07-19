export function toLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatDate(value, options = { weekday: 'short', day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('ru-RU', options).format(parseLocalDate(value));
}

export function formatMinutes(value) {
  const minutes = Math.max(0, Number(value) || 0);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}ч ${String(remainder).padStart(2, '0')}м`;
}

export function parseMinutes(value) {
  const source = String(value ?? '').trim().toLowerCase();
  if (!source) return 0;
  if (/^\d+$/.test(source)) return Number(source);
  const clock = source.match(/^(\d{1,2}):([0-5]\d)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const hours = Number(source.match(/(\d+(?:[.,]\d+)?)\s*(?:ч|час)/)?.[1]?.replace(',', '.') ?? 0);
  const minutes = Number(source.match(/(\d+)\s*(?:м|мин)/)?.[1] ?? 0);
  return Math.round(hours * 60) + minutes;
}

export function startOfWeek(date = new Date()) {
  const result = new Date(date);
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

export function distributeMinutes(items, targetMinutes, weightKey = 'actualMinutes') {
  const totalWeight = items.reduce((total, item) => total + Math.max(0, Number(item[weightKey]) || 0), 0);
  if (!items.length || totalWeight === 0) return [];
  const raw = items.map((item) => targetMinutes * item[weightKey] / totalWeight);
  const rounded = raw.map(Math.floor);
  let remainder = targetMinutes - rounded.reduce((total, value) => total + value, 0);
  raw
    .map((value, index) => ({ index, fraction: value - rounded[index] }))
    .sort((left, right) => right.fraction - left.fraction)
    .forEach(({ index }) => {
      if (remainder > 0) {
        rounded[index] += 1;
        remainder -= 1;
      }
    });
  return items.map((item, index) => ({ ...item, spprMinutes: rounded[index] }));
}

export function roundToInterval(minutes, interval = 30) {
  const normalizedInterval = Math.max(1, Math.round(Number(interval) || 1));
  return Math.max(0, Math.round((Number(minutes) || 0) / normalizedInterval) * normalizedInterval);
}

export function distributeRoundedMinutes(items, targetMinutes, weightKey = 'actualMinutes', interval = 30) {
  const normalizedInterval = Math.max(1, Math.round(Number(interval) || 1));
  const normalizedTarget = roundToInterval(targetMinutes, normalizedInterval);
  const totalWeight = items.reduce((total, item) => total + Math.max(0, Number(item[weightKey]) || 0), 0);
  if (!items.length || totalWeight === 0 || normalizedTarget === 0) return items.map((item) => ({ ...item, spprMinutes: 0 }));
  const totalSlots = normalizedTarget / normalizedInterval;
  const rawSlots = items.map((item) => totalSlots * Math.max(0, Number(item[weightKey]) || 0) / totalWeight);
  const slots = rawSlots.map(Math.floor);
  let remaining = totalSlots - slots.reduce((total, value) => total + value, 0);
  rawSlots
    .map((value, index) => ({ index, fraction: value - slots[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    .forEach(({ index }) => {
      if (remaining > 0) {
        slots[index] += 1;
        remaining -= 1;
      }
    });
  return items.map((item, index) => ({ ...item, spprMinutes: slots[index] * normalizedInterval }));
}
