import {
  createBackup,
  restoreBackup,
  seedInitialData,
  settingsRepository,
  taskRepository,
  workDayRepository,
  workEntryRepository,
} from './data/repositories.js';
import { addDays, distributeRoundedMinutes, formatDate, formatMinutes, parseLocalDate, roundToInterval, startOfWeek, toLocalDate } from './utils/format.js';
import { buildPrompt, DEFAULT_PROMPTS, DEFAULT_PROMPTS_VERSION, LEGACY_DEFAULT_PROMPTS, parseAiResult, withRolePrefix } from './ai/contracts.js';
import { completeJson, transcribeAudio } from './ai/client.js';
import { improveEntryDescription } from './ai/improve.js';
import { getNativePlugin } from './platform/capacitor.js';
import { hasRecordedWork } from './domain/work-day.js';
import { buildTaskHistory, getTaskSpprTotals } from './domain/task-history.js';
import { distributeSpprWithLimits, getRemainingSpprMinutes } from './domain/sppr-limits.js';
import { buildSpprExportReport } from './domain/sppr-report.js';
import { createExcelReportBlob, createPdfReportBlob, deliverReportFile } from './reports/export.js';

const screens = new Map([...document.querySelectorAll('[data-screen]')].map((screen) => [screen.dataset.screen, screen]));
const primaryRoutes = new Set(['tasks', 'calendar', 'reports', 'more']);
const routeAliases = new Map([
  ['task-real', 'tasks'], ['task-editor', 'tasks'],
  ['add-entry', 'calendar'], ['end-day', 'calendar'], ['day-result', 'calendar'],
  ['report-sppr', 'reports'], ['settings', 'more'], ['ai-settings', 'more'], ['states', 'more'],
]);
const statusLabels = { active: 'Активная', paused: 'На паузе', completed: 'Завершена', archived: 'В архиве' };
const DEFAULT_AI_BASE_URL = 'https://openai.api.proxyapi.ru/v1';
const DEFAULT_AI_MODEL = 'openai/gpt-5.4-mini';
const DEFAULT_TRANSCRIPTION_MODEL = 'openai/gpt-4o-mini-transcribe';
const REMINDER_CHANNEL_ID = 'worklog-reminders-v2';
const REMINDER_ID_START = 41000;
const REMINDER_ID_END = 42000;
const MAX_SCHEDULED_REMINDERS = 96;
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

const state = {
  selectedTaskId: null,
  selectedDate: toLocalDate(),
  weekStart: startOfWeek(),
  reportFromDate: toLocalDate(startOfWeek()),
  reportToDate: toLocalDate(addDays(startOfWeek(), 6)),
  taskFilter: 'active',
  taskSearch: '',
  editingTaskId: null,
  editingEntryId: null,
  editingSpprEntryId: null,
  entryType: 'text',
  entryTasks: [],
  entryTaskSelection: '',
  recordingBlob: null,
  audioTranscript: null,
  audioProcessingPromise: null,
  isSavingEntry: false,
  mediaRecorder: null,
  mediaStream: null,
  attachmentUrls: new Set(),
  pendingAttachments: [],
  resultView: 'tasks',
  settingsSection: 'reminders',
  settings: {
    remindersEnabled: false,
    reminderInterval: 90,
    dailyTargetMinutes: 480,
    globalTaskLimitEnabled: false,
    globalTaskLimitMinutes: null,
    themeMode: 'dark',
    followSystemTheme: false,
  },
  reminderTimer: null,
  reminderCountdownTimer: null,
  reminderNextAt: null,
  currentRoute: 'calendar',
  routeStack: ['calendar'],
  reportText: '',
  reportRows: [],
  exportBusy: false,
  backupBusy: false,
  ai: {
    provider: 'openai-compatible',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    apiKey: '',
    prompts: { ...DEFAULT_PROMPTS },
  },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(selector, text) {
  const node = document.querySelector(selector);
  if (node) node.textContent = text;
}

function formatReportPeriod(from, to, month = 'long') {
  const formatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month });
  return `${formatter.format(from)} — ${formatter.format(to)}`;
}

function attachmentName(attachment) {
  return String(attachment.filename || (String(attachment.mimeType || attachment.blob?.type || '').startsWith('audio/') ? 'Аудиофайл' : 'Вложение'));
}

function formatFileSize(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.ceil(size / 1024))} КБ`;
  return `${(size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}

function parseOptionalHoursLimit(value) {
  const source = String(value ?? '').trim().replace(',', '.');
  if (!source) return null;
  const hours = Number(source);
  if (!Number.isFinite(hours) || hours < 0 || hours > 100000 || !Number.isInteger(hours * 2)) {
    throw new Error('Лимит должен быть от 0 до 100000 часов с шагом 30 минут.');
  }
  return roundToInterval(hours * 60, 30);
}

function renderPendingAttachments() {
  const list = document.querySelector('#entry-attachment-list');
  if (!list) return;
  list.replaceChildren();
  list.hidden = !state.pendingAttachments.length;
  state.pendingAttachments.forEach((attachment, index) => {
    const row = element('div', 'attachment-picker-item');
    row.append(element('span', '', `${attachmentName(attachment)} · ${formatFileSize(attachment.blob.size)}`));
    const remove = element('button', '', '×');
    remove.type = 'button';
    remove.dataset.action = 'remove-pending-attachment';
    remove.dataset.attachmentIndex = String(index);
    remove.setAttribute('aria-label', `Убрать ${attachmentName(attachment)}`);
    row.append(remove);
    list.append(row);
  });
}

function addPendingAttachments(files, kind = 'file') {
  const candidates = Array.from(files ?? []).map((file) => {
    const blob = file instanceof Blob ? file : file?.blob;
    if (!(blob instanceof Blob)) return null;
    return {
      blob,
      filename: file.name || file.filename || `worklog-${kind}-${Date.now()}`,
      mimeType: file.type || file.mimeType || blob.type || 'application/octet-stream',
      kind,
    };
  }).filter(Boolean);
  if (!candidates.length) return;
  if (state.pendingAttachments.length + candidates.length > MAX_ATTACHMENT_COUNT) throw new Error(`К одной записи можно прикрепить не более ${MAX_ATTACHMENT_COUNT} файлов.`);
  if (candidates.some((attachment) => attachment.blob.size > MAX_ATTACHMENT_SIZE_BYTES)) throw new Error('Размер каждого вложения не должен превышать 25 МБ.');
  state.pendingAttachments.push(...candidates);
  renderPendingAttachments();
}

async function captureAttachmentPhoto() {
  const camera = nativePlugin('Camera');
  if (!camera) {
    document.querySelector('#entry-camera-file')?.click();
    return;
  }
  try {
    const photo = await camera.getPhoto({
      quality: 90,
      width: 1920,
      height: 1920,
      correctOrientation: true,
      resultType: 'uri',
      source: 'CAMERA',
      saveToGallery: false,
    });
    if (!photo?.webPath) throw new Error('Камера не вернула снимок.');
    const response = await fetch(photo.webPath);
    if (!response.ok) throw new Error('Не удалось прочитать снимок с камеры.');
    const blob = await response.blob();
    addPendingAttachments([{
      blob,
      name: `photo-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.${photo.format || 'jpeg'}`,
      type: blob.type || `image/${photo.format || 'jpeg'}`,
    }], 'camera');
  } catch (error) {
    if (/cancel/i.test(String(error?.message ?? ''))) return;
    if (error?.name === 'NotAllowedError') throw new Error('Разрешите доступ к камере в настройках Android и попробуйте снова.');
    throw new Error(error?.message || 'Не удалось сделать фото.');
  }
}

function selectOptionValue(select, value) {
  if (!select) return;
  if (![...select.options].some((option) => option.value === value)) {
    const option = element('option', '', `${value} · сохранённая модель`);
    option.value = value;
    select.append(option);
  }
  select.value = value;
}

function sumMinutes(entries) {
  return entries.reduce((total, entry) => total + entry.actualMinutes, 0);
}

function durationFromForm(form) {
  const hours = Number(form.get('actualHours') || 0);
  const minutes = Number(form.get('actualMinutesPart') || 0);
  if (!Number.isInteger(hours) || hours < 0 || hours > 24 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    throw new Error('Укажите корректное количество часов и минут.');
  }
  if (hours === 24 && minutes > 0) throw new Error('Максимальное время — 24 часа.');
  return hours * 60 + minutes;
}

function signedMinutes(value) {
  if (!value) return '0ч 00м';
  return `${value > 0 ? '+' : '−'}${formatMinutes(Math.abs(value))}`;
}

function reminderIntervalLabel(minutes) {
  const value = Number(minutes) || 0;
  if (value === 1) return '1 минуту';
  if (value >= 2 && value <= 4) return `${value} минуты`;
  return `${value} минут`;
}

function mergeDescriptions(entries, descriptions = new Map()) {
  const unique = new Set();
  entries.forEach((entry) => {
    const text = String(descriptions.get(entry.id) ?? entry.spprDescription ?? entry.note ?? entry.transcript ?? '').trim().replace(/\s+/g, ' ');
    if (text) unique.add(text);
  });
  return [...unique].join(' ');
}

function allocationDescription(allocation, entryMap, fallback = '') {
  return mergeDescriptions((allocation.entryAllocations ?? []).map((item) => entryMap.get(item.entryId)).filter(Boolean))
    || String(allocation.description ?? '').trim()
    || fallback;
}

function isAiReady() {
  return Boolean(state.ai.baseUrl && state.ai.model && state.ai.transcriptionModel && state.ai.apiKey);
}

function requireAiConsent(summary) {
  if (!isAiReady()) throw new Error('Сначала заполните адрес API, модель и ключ в настройках ИИ.');
  if (!navigator.onLine) throw new Error('Нет подключения к интернету.');
  if (!confirm(`Отправить ${summary} в настроенный сервис ИИ? Реальные данные не будут изменены автоматически.`)) throw new Error('Отправка в ИИ отменена.');
}

function isReminderNotification(notification) {
  return notification.id >= REMINDER_ID_START && notification.id < REMINDER_ID_END;
}

async function clearReminderState({ cancelNative = false } = {}) {
  state.reminderNextAt = null;
  await saveSetting('reminderNextAt', null);
  if (cancelNative) await cancelNativeReminders();
  renderReminderCountdown();
}

async function prepareNativeNotifications() {
  const localNotifications = nativePlugin('LocalNotifications');
  if (!localNotifications) return null;
  let permission = await localNotifications.checkPermissions();
  if (permission.display === 'prompt' || permission.display === 'prompt-with-rationale') {
    permission = await localNotifications.requestPermissions();
  }
  if (permission.display !== 'granted') throw new Error('Разрешите уведомления для WorkLog AI в настройках Android.');
  const enabled = await localNotifications.areEnabled();
  if (!enabled.value) throw new Error('Уведомления WorkLog AI отключены в настройках Android.');
  const exactAlarm = await localNotifications.checkExactNotificationSetting?.();
  if (exactAlarm?.exact_alarm === 'denied') {
    await localNotifications.changeExactNotificationSetting?.();
    throw new Error('Разрешите точные напоминания в открывшихся настройках Android, затем включите напоминания снова.');
  }
  await localNotifications.createChannel({
    id: REMINDER_CHANNEL_ID,
    name: 'Напоминания WorkLog AI',
    description: 'Напоминания о рабочих записях',
    importance: 5,
    sound: 'default',
    vibration: true,
    lightColor: '#6750A4',
  });
  const channelList = await localNotifications.listChannels?.();
  const channel = channelList?.channels?.find((item) => item.id === REMINDER_CHANNEL_ID);
  if (channel?.importance === 0) throw new Error('Канал напоминаний WorkLog AI отключён в настройках Android.');
  return localNotifications;
}

async function scheduleNativeReminders(localNotifications, minutes, { announceDayStart = false } = {}) {
  await cancelNativeReminders(localNotifications);
  const now = Date.now();
  const nextAt = now + minutes * 60 * 1000;
  const notificationCount = Math.min(Math.floor((24 * 60) / minutes), MAX_SCHEDULED_REMINDERS);
  const notifications = Array.from({ length: notificationCount }, (_, index) => ({
    id: REMINDER_ID_START + 1 + index,
    title: 'WorkLog AI',
    body: 'Пора зафиксировать, чем вы занимались.',
    channelId: REMINDER_CHANNEL_ID,
    autoCancel: false,
    schedule: { at: new Date(now + (index + 1) * minutes * 60 * 1000), allowWhileIdle: true },
  }));
  if (announceDayStart) {
    notifications.unshift({
      id: REMINDER_ID_START,
      title: 'WorkLog AI',
      body: `Рабочий день начат. Следующее напоминание через ${formatReminderCountdown(nextAt - now)}.`,
      channelId: REMINDER_CHANNEL_ID,
      autoCancel: false,
      schedule: { at: new Date(now + 1000), allowWhileIdle: true },
    });
  }
  const result = await localNotifications.schedule({ notifications });
  if ((result.notifications?.length ?? 0) !== notifications.length) {
    await cancelNativeReminders(localNotifications);
    throw new Error('Android запланировал не все напоминания. Проверьте системные ограничения приложения.');
  }
  state.reminderNextAt = nextAt;
  await saveSetting('reminderNextAt', nextAt);
  renderReminderCountdown();
  return notificationCount;
}

async function notifyDayStart({ announceDayStart = true } = {}) {
  if (!state.settings.remindersEnabled) {
    await clearReminderState({ cancelNative: true });
    return false;
  }
  const minutes = state.settings.reminderInterval;
  const body = `Следующее напоминание через ${reminderIntervalLabel(minutes)}.`;
  const localNotifications = await prepareNativeNotifications();
  if (localNotifications) {
    await scheduleNativeReminders(localNotifications, minutes, { announceDayStart });
    return true;
  }
  if (globalThis.Notification?.permission === 'default') await Notification.requestPermission();
  if (globalThis.Notification?.permission !== 'granted') throw new Error('Разрешите уведомления в настройках браузера.');
  const nextAt = Date.now() + minutes * 60 * 1000;
  state.reminderNextAt = nextAt;
  await saveSetting('reminderNextAt', nextAt);
  renderReminderCountdown();
  if (announceDayStart) new Notification('Рабочий день начат', { body });
  return true;
}

async function cancelNativeReminders(localNotifications = nativePlugin('LocalNotifications')) {
  if (!localNotifications) return;
  const pending = await localNotifications.getPending();
  const notifications = (pending.notifications ?? [])
    .filter(isReminderNotification)
    .map((notification) => ({ id: notification.id }));
  if (notifications.length) await localNotifications.cancel({ notifications });
}

async function reconcileNativeReminders() {
  const localNotifications = nativePlugin('LocalNotifications');
  if (!localNotifications || !state.reminderNextAt) return;
  const pending = await localNotifications.getPending();
  if (!(pending.notifications ?? []).some(isReminderNotification)) await clearReminderState();
}

function nativePlugin(name) {
  return getNativePlugin(name);
}

async function openNewEntryFromNotification() {
  state.editingEntryId = null;
  await showScreen('add-entry', { updateHistory: true });
}

async function goBackInApp() {
  if (state.mediaRecorder?.state === 'recording') {
    cancelActiveRecording();
    showToast('Запись остановлена');
    return;
  }
  if (state.routeStack.length > 1) {
    state.routeStack.pop();
    const previousRoute = state.routeStack.at(-1) ?? 'calendar';
    await showScreen(previousRoute);
    if (resolveRoute() !== previousRoute) location.hash = `/${previousRoute}`;
    return;
  }
  const app = nativePlugin('App');
  if (app?.minimizeApp) await app.minimizeApp();
}

function formatReminderCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderReminderCountdown() {
  const node = document.querySelector('#calendar-reminder-countdown');
  if (!node) return;
  if (state.settings.remindersEnabled && nativePlugin('LocalNotifications') && state.reminderNextAt && state.reminderNextAt <= Date.now()) {
    while (state.reminderNextAt <= Date.now()) state.reminderNextAt += state.settings.reminderInterval * 60 * 1000;
    void saveSetting('reminderNextAt', state.reminderNextAt);
  }
  const isActive = state.settings.remindersEnabled && state.reminderNextAt && state.reminderNextAt > Date.now();
  node.hidden = !isActive;
  if (isActive) node.textContent = `Следующее напоминание через ${formatReminderCountdown(state.reminderNextAt - Date.now())}`;
}

function startReminderCountdown() {
  clearInterval(state.reminderCountdownTimer);
  renderReminderCountdown();
  state.reminderCountdownTimer = setInterval(renderReminderCountdown, 1000);
}

async function setupNativeHandlers() {
  const app = nativePlugin('App');
  if (app?.addListener) {
    await app.addListener('backButton', () => { goBackInApp().catch((error) => showToast(error.message, 'error')); });
  }
  const localNotifications = nativePlugin('LocalNotifications');
  if (localNotifications?.addListener) {
    await localNotifications.addListener('localNotificationActionPerformed', () => { openNewEntryFromNotification().catch((error) => showToast(error.message, 'error')); });
  }
}

function entryPayload(entry, task) {
  return { entryId: entry.id, task: { spprNumber: task.spprNumber, title: task.title, description: task.description || '' }, realNote: entry.note || entry.transcript || '', actualMinutes: entry.actualMinutes, localDate: entry.localDate };
}

function downloadFile(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme() {
  const systemTheme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.settings.followSystemTheme ? systemTheme : state.settings.themeMode;
}

function scheduleReminder() {
  clearTimeout(state.reminderTimer);
  state.reminderTimer = null;
  if (!state.settings.remindersEnabled || !state.reminderNextAt || nativePlugin('LocalNotifications')) return;
  const fireReminder = async () => {
    const message = 'Пора записать, чем вы занимались.';
    showToast(message);
    if (globalThis.Notification?.permission === 'granted') new Notification('WorkLog AI', { body: message });
    state.reminderNextAt = Date.now() + state.settings.reminderInterval * 60 * 1000;
    await saveSetting('reminderNextAt', state.reminderNextAt);
    renderReminderCountdown();
    state.reminderTimer = setTimeout(() => { fireReminder().catch((error) => showToast(error.message, 'error')); }, state.settings.reminderInterval * 60 * 1000);
  };
  const delay = Math.max(0, state.reminderNextAt - Date.now());
  state.reminderTimer = setTimeout(() => { fireReminder().catch((error) => showToast(error.message, 'error')); }, delay);
}

async function saveSetting(key, value) {
  state.settings[key] = value;
  await settingsRepository.set(key, value);
}

async function applyGlobalTaskLimit(enabled) {
  const input = document.querySelector('#global-task-limit-hours');
  const maxMinutes = parseOptionalHoursLimit(input?.value);
  const result = await taskRepository.applyGlobalSpprLimit({ enabled, maxMinutes });
  state.settings.globalTaskLimitEnabled = enabled;
  state.settings.globalTaskLimitMinutes = result.maxMinutes;
  return result;
}

async function saveAiConfig() {
  await settingsRepository.set('aiConfig', {
    provider: state.ai.provider,
    baseUrl: state.ai.baseUrl,
    model: state.ai.model,
    transcriptionModel: state.ai.transcriptionModel,
    apiKey: state.ai.apiKey,
    promptVersion: DEFAULT_PROMPTS_VERSION,
    prompts: { ...state.ai.prompts },
  });
}

function emptyState(title, description, actionLabel, action) {
  const card = element('article', 'inline-empty');
  card.append(element('strong', '', title), element('p', '', description));
  if (actionLabel) {
    const button = element('button', 'secondary-button', actionLabel);
    button.type = 'button';
    button.dataset.action = action;
    card.append(button);
  }
  return card;
}

function showToast(message, type = 'success') {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.dataset.type = type;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function resolveRoute() {
  const route = location.hash.replace(/^#\/?/, '');
  if (route === 'task-sppr') return 'task-real';
  return screens.has(route) ? route : 'calendar';
}

async function showScreen(route, { updateHistory = false } = {}) {
  if (!screens.has(route)) route = 'calendar';
  if (updateHistory && route !== state.currentRoute) state.routeStack.push(route);
  if (route !== 'add-entry') cancelActiveRecording();
  screens.forEach((screen, name) => {
    const current = name === route;
    screen.hidden = !current;
    screen.classList.toggle('is-active', current);
  });
  const primary = primaryRoutes.has(route) ? route : routeAliases.get(route);
  document.querySelectorAll('.bottom-nav [data-route]').forEach((button) => {
    const active = button.dataset.route === primary;
    button.classList.toggle('is-active', active);
    active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
  });
  if (updateHistory && resolveRoute() !== route) location.hash = `/${route}`;
  state.currentRoute = route;
  window.scrollTo({ top: 0, behavior: 'auto' });
  try { await renderRoute(route); } catch (error) { showToast(error.message || 'Не удалось загрузить данные.', 'error'); }
}

function createTaskCard(task, actualMinutes, { compact = false, spprMinutes = 0, listActions = false } = {}) {
  const card = element('button', 'task-card');
  card.type = 'button';
  card.dataset.action = 'open-task';
  card.dataset.taskId = task.id;
  const info = element('span');
  info.append(element('strong', '', task.spprNumber), element('small', '', task.title));
  const times = element('span', compact ? 'inline-times' : 'task-card__times');
  times.append(element('b', '', formatMinutes(actualMinutes)), element('em', '', formatMinutes(spprMinutes)));
  card.append(info, times);
  if (!listActions || task.status === 'completed') return card;
  const row = element('div', 'task-list-item');
  const actions = element('div', 'task-card-actions');
  const actionButton = (action, icon, label, className = '') => {
    const button = element('button', `icon-button ${className}`.trim());
    button.type = 'button'; button.dataset.action = action; button.dataset.taskId = task.id; button.setAttribute('aria-label', label);
    button.innerHTML = `<svg><use href="#${icon}" /></svg>`;
    return button;
  };
  actions.append(
    actionButton('edit-task-list', 'i-edit', 'Изменить задачу'),
    actionButton('complete-task-list', 'i-check', 'Завершить задачу', 'icon-button--complete'),
    actionButton('delete-task-list', 'i-trash', 'Удалить задачу', 'icon-button--delete'),
  );
  row.append(card, actions);
  return row;
}

async function taskTotals() {
  const entries = await workEntryRepository.list();
  return entries.reduce((map, entry) => map.set(entry.taskId, (map.get(entry.taskId) ?? 0) + entry.actualMinutes), new Map());
}

async function renderToday() {
  const date = state.selectedDate;
  const [tasks, entries, workDay] = await Promise.all([
    taskRepository.list(),
    workEntryRepository.list({ localDate: date }),
    workDayRepository.get(date),
  ]);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const grouped = entries.reduce((map, entry) => map.set(entry.taskId, (map.get(entry.taskId) ?? 0) + entry.actualMinutes), new Map());
  const spprByTask = new Map((workDay?.allocations ?? []).map((allocation) => [allocation.taskId, allocation.spprMinutes]));
  setText('#today-date-label', formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' }));
  document.querySelector('#today-date-picker').value = date;
  setText('#today-actual-total', formatMinutes(sumMinutes(entries)));
  const spprTotal = (workDay?.allocations ?? []).reduce((total, allocation) => total + allocation.spprMinutes, 0);
  setText('#today-sppr-total', formatMinutes(spprTotal));
  setText('#today-sppr-caption', workDay?.state === 'finished' ? 'норма: ' + formatMinutes(workDay.targetMinutes) : 'ещё не сформировано');

  const status = document.querySelector('#today-day-status');
  const action = document.querySelector('#today-day-action');
  const actionLabel = document.querySelector('#today-day-action-label');
  const addEntry = document.querySelector('#today-add-entry');
  const startedAt = workDay?.startedAt ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(workDay.startedAt)) : '—';
  if (!workDay || workDay.state === 'draft' || (workDay.state === 'active' && !workDay.startedAt)) {
    status.replaceChildren(element('span', 'status-dot'), document.createTextNode(' Рабочий день ещё не начат '), element('span', '', '—'));
    action.dataset.action = 'begin-today'; actionLabel.textContent = 'Начать день'; addEntry.disabled = false;
  } else if (workDay.state === 'finished') {
    status.replaceChildren(element('span', 'status-dot'), document.createTextNode(' Рабочий день завершён '), element('span', '', formatMinutes(workDay.targetMinutes)));
    action.dataset.action = 'open-today-result'; actionLabel.textContent = 'Открыть результат'; addEntry.disabled = false;
  } else {
    status.replaceChildren(element('span', 'status-dot'), document.createTextNode(' Рабочий день начат '), element('span', '', startedAt));
    action.dataset.action = 'end-today'; actionLabel.textContent = 'Завершить день'; addEntry.disabled = false;
  }

  const list = document.querySelector('#today-task-list');
  list.replaceChildren();
  if (workDay?.state === 'active') {
    tasks.filter((task) => ['active', 'paused'].includes(task.status)).forEach((task) => list.append(createTaskCard(task, grouped.get(task.id) ?? 0)));
  } else {
    grouped.forEach((minutes, taskId) => { if (taskMap.has(taskId)) list.append(createTaskCard(taskMap.get(taskId), minutes, { spprMinutes: spprByTask.get(taskId) ?? 0 })); });
  }
  if (!list.children.length) list.append(emptyState(workDay ? 'Сегодня записей нет' : 'Начните рабочий день', workDay ? 'Добавьте заметку о выполненной работе.' : 'После начала дня здесь появятся задачи.', workDay ? 'Добавить запись' : null, workDay ? 'new-entry' : null));
}

async function renderCalendar() {
  const week = Array.from({ length: 7 }, (_, index) => addDays(state.weekStart, index));
  const [tasks, weekEntries, dayEntries, workDay] = await Promise.all([
    taskRepository.list(),
    workEntryRepository.list({ fromDate: toLocalDate(week[0]), toDate: toLocalDate(week[6]) }),
    workEntryRepository.list({ localDate: state.selectedDate }),
    workDayRepository.get(state.selectedDate),
  ]);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const datesWithEntries = new Set(weekEntries.map((entry) => entry.localDate));
  setText('#calendar-month-label', new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(parseLocalDate(state.selectedDate)));
  setText('#calendar-date-label', formatDate(state.selectedDate, { weekday: 'long', day: 'numeric', month: 'long' }));
  setText('#calendar-actual-total', formatMinutes(sumMinutes(dayEntries)));
  setText('#calendar-total-row', formatMinutes(sumMinutes(dayEntries)));
  const spprTotal = (workDay?.allocations ?? []).reduce((total, allocation) => total + allocation.spprMinutes, 0);
  setText('#calendar-sppr-total', formatMinutes(spprTotal));
  setText('#calendar-sppr-total-row', formatMinutes(spprTotal));
  const calendarAction = document.querySelector('#calendar-day-action');
  const calendarActionLabel = document.querySelector('#calendar-day-action-label');
  const calendarAddEntry = document.querySelector('#calendar-add-entry');
  if (!workDay || workDay.state === 'draft' || (workDay.state === 'active' && !workDay.startedAt)) {
    calendarAction.dataset.action = 'start-selected-day';
    calendarActionLabel.textContent = 'Начать день';
    calendarAddEntry.hidden = true;
  } else if (workDay.state === 'finished') {
    calendarAction.dataset.action = 'open-selected-result';
    calendarActionLabel.textContent = 'Открыть результат';
    calendarAddEntry.hidden = false;
  } else {
    calendarAction.dataset.action = 'open-end-day';
    calendarActionLabel.textContent = 'Завершить день';
    calendarAddEntry.hidden = false;
  }
  const strip = document.querySelector('#calendar-week');
  strip.replaceChildren();
  week.forEach((date) => {
    const localDate = toLocalDate(date);
    const button = element('button', localDate === state.selectedDate ? 'is-selected' : '');
    button.type = 'button'; button.dataset.action = 'select-date'; button.dataset.date = localDate;
    button.append(element('span', '', new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date)), element('strong', '', String(date.getDate())));
    if (datesWithEntries.has(localDate)) { const dots = element('i', 'day-dots'); dots.append(element('b')); button.append(dots); }
    strip.append(button);
  });
  const grouped = dayEntries.reduce((map, entry) => map.set(entry.taskId, (map.get(entry.taskId) ?? 0) + entry.actualMinutes), new Map());
  const spprByTask = new Map((workDay?.allocations ?? []).map((allocation) => [allocation.taskId, allocation.spprMinutes]));
  const list = document.querySelector('#calendar-task-list'); list.replaceChildren();
  grouped.forEach((minutes, taskId) => { if (taskMap.has(taskId)) list.append(createTaskCard(taskMap.get(taskId), minutes, { compact: true, spprMinutes: spprByTask.get(taskId) ?? 0 })); });
  renderReminderCountdown();
  if (!list.children.length) list.append(emptyState('Нет записей за этот день', 'Записи появятся здесь после добавления.'));
}

async function renderTasks() {
  const [tasks, totals, entries, workDays] = await Promise.all([
    taskRepository.list({ includeArchived: state.taskFilter === 'all' }),
    taskTotals(),
    workEntryRepository.list(),
    workDayRepository.list(),
  ]);
  const spprTotals = getTaskSpprTotals(workDays);
  const query = state.taskSearch.toLocaleLowerCase('ru-RU');
  const entryTextByTask = entries.reduce((result, entry) => {
    const current = result.get(entry.taskId) ?? '';
    result.set(entry.taskId, `${current} ${entry.note ?? ''} ${entry.transcript ?? ''} ${entry.spprDescription ?? ''}`.toLocaleLowerCase('ru-RU'));
    return result;
  }, new Map());
  const filtered = tasks.filter((task) => {
    const matchesFilter = state.taskFilter === 'all' || (state.taskFilter === 'completed' ? task.status === 'completed' : ['active', 'paused'].includes(task.status));
    const searchable = `${task.spprNumber} ${task.title} ${task.description ?? ''} ${entryTextByTask.get(task.id) ?? ''}`.toLocaleLowerCase('ru-RU');
    return matchesFilter && searchable.includes(query);
  });
  const list = document.querySelector('#all-task-list'); list.replaceChildren();
  filtered.forEach((task) => list.append(createTaskCard(task, totals.get(task.id) ?? 0, { spprMinutes: spprTotals.get(task.id) ?? 0, listActions: true })));
  if (!filtered.length) list.append(emptyState('Задачи не найдены', query ? 'Измените запрос поиска.' : 'Создайте первую задачу СППР.', query ? null : 'Создать задачу', query ? null : 'new-task'));
}

async function ensureSelectedTask() {
  let task = await taskRepository.get(state.selectedTaskId);
  if (!task) { const tasks = await taskRepository.list(); task = tasks[0] ?? null; state.selectedTaskId = task?.id ?? null; }
  return task;
}

async function renderTaskDetail() {
  const task = await ensureSelectedTask();
  if (!task) { await showScreen('tasks', { updateHistory: true }); return; }
  const [entries, workDays] = await Promise.all([
    workEntryRepository.list({ taskId: task.id }),
    workDayRepository.list(),
  ]);
  const history = buildTaskHistory(entries, workDays, task.id);
  setText('#task-detail-number', task.spprNumber); setText('#task-detail-name', task.title);
  setText('#task-detail-status', `${statusLabels[task.status]}${task.excludeFromSppr ? ' · без СППР' : ''}`);
  setText('#task-detail-actual', formatMinutes(history.actualMinutes));
  setText('#task-detail-sppr', formatMinutes(history.spprMinutes));
  const statusAction = document.querySelector('#task-status-action');
  statusAction.hidden = task.status === 'archived' || task.status === 'completed';
  statusAction.textContent = task.status === 'completed' ? 'Вернуть в активные' : 'Завершить задачу';
  document.querySelector('[data-screen="task-real"] [data-action="edit-task"]')?.toggleAttribute('hidden', task.status === 'completed');
  const description = document.querySelector('#task-detail-description');
  description.hidden = !task.description;
  description.textContent = task.description || '';
  const list = document.querySelector('#task-entry-list');
  state.attachmentUrls.forEach((url) => URL.revokeObjectURL(url)); state.attachmentUrls.clear();
  const cards = history.entries.length
    ? await Promise.all(history.entries.map((entry) => createEntryCard(entry, { spprMinutes: entry.spprMinutes })))
    : [emptyState('У задачи нет заметок', 'Добавьте первую фактическую запись.', 'Добавить запись', 'new-entry')];
  // Commit the whole list at once. Concurrent route/hash renders may finish in
  // either order, but each commit replaces the previous DOM instead of appending duplicates.
  list.replaceChildren(...cards);
}

async function createEntryCard(entry, { spprMinutes = null } = {}) {
  const card = element('article', 'entry-card');
  const header = element('header');
  const times = element('span', 'entry-card__times');
  times.append(
    element('b', '', `Реально ${formatMinutes(entry.actualMinutes)}`),
    element('em', spprMinutes === null ? 'is-pending' : '', `СППР ${spprMinutes === null ? '—' : formatMinutes(spprMinutes)}`),
  );
  header.append(element('strong', '', formatDate(entry.localDate)), times);
  const body = element('div', 'entry-card__body entry-card__body--actions');
  const content = element('div', 'entry-content');
  const attachments = await workEntryRepository.listAttachments(entry.id);
  content.append(element('p', '', entry.note || entry.transcript || (entry.entryType === 'voice' ? 'Голосовая заметка' : attachments.length ? 'Вложения к записи' : 'Заметка')));
  if (entry.entryType !== 'text' && entry.transcript && entry.transcript.trim() !== entry.note?.trim()) {
    const transcript = element('p', 'entry-transcript', entry.transcript);
    transcript.prepend(element('b', '', 'Расшифровка: '));
    content.append(transcript);
  }
  const spprDescription = entry.spprDescription?.trim();
  const aiDescription = element('p', `entry-sppr-description${spprDescription ? '' : ' entry-sppr-description--empty'}`, spprDescription || 'ещё не подготовлено');
  aiDescription.prepend(element('b', '', 'СППР: '));
  content.append(aiDescription);
  if (attachments.length) {
    const attachmentList = element('section', 'entry-attachments');
    attachmentList.append(element('b', '', `Вложения · ${attachments.length}`));
    attachments.forEach((attachment) => {
      if (!attachment.blob) return;
      const url = URL.createObjectURL(attachment.blob);
      state.attachmentUrls.add(url);
      const item = element('div', 'entry-attachment');
      const type = String(attachment.mimeType || attachment.blob.type || '');
      if (type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = attachmentName(attachment);
        image.loading = 'lazy';
        item.append(image);
      } else if (type.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = url;
        item.append(audio);
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = attachmentName(attachment);
      link.textContent = `${attachmentName(attachment)} · ${formatFileSize(attachment.sizeBytes ?? attachment.blob.size)}`;
      item.append(link);
      attachmentList.append(item);
    });
    content.append(attachmentList);
  }
  const actions = element('div', 'entry-actions');
  const edit = element('button', 'mini-button', 'Изменить'); edit.type = 'button'; edit.dataset.action = 'edit-entry'; edit.dataset.entryId = entry.id;
  const improveLabel = entry.spprDescription ? 'Улучшить снова' : 'Улучшить';
  const remove = element('button', 'mini-button mini-button--danger', 'Удалить'); remove.type = 'button'; remove.dataset.action = 'delete-entry'; remove.dataset.entryId = entry.id;
  actions.append(edit);
  if (String(entry.note || entry.transcript || '').trim()) {
    const improve = element('button', 'mini-button mini-button--ai', improveLabel); improve.type = 'button'; improve.dataset.action = 'improve-entry'; improve.dataset.entryId = entry.id;
    actions.append(improve);
  }
  if (spprDescription) {
    const editSppr = element('button', 'mini-button mini-button--ai', 'Изменить СППР'); editSppr.type = 'button'; editSppr.dataset.action = 'edit-sppr-description'; editSppr.dataset.entryId = entry.id;
    const copy = element('button', 'mini-button mini-button--copy', 'Копировать СППР'); copy.type = 'button'; copy.dataset.action = 'copy-text'; copy.dataset.copyText = spprDescription;
    actions.append(editSppr, copy);
  }
  actions.append(remove); body.append(content, actions); card.append(header, body); return card;
}

async function renderTaskEditor() {
  const form = document.querySelector('#task-form'); form.reset();
  const [task, workDays] = await Promise.all([
    taskRepository.get(state.editingTaskId),
    workDayRepository.list(),
  ]);
  const allocatedMinutes = task ? (getTaskSpprTotals(workDays).get(task.id) ?? 0) : 0;
  const limitMinutes = task?.maxSpprMinutes ?? (state.settings.globalTaskLimitEnabled ? state.settings.globalTaskLimitMinutes : null);
  setText('#task-editor-title', task ? 'Редактирование задачи' : 'Новая задача');
  document.querySelector('#archive-task-button').hidden = !task;
  document.querySelector('#delete-task-button').hidden = !task;
  if (task) { form.elements.spprNumber.value = task.spprNumber; form.elements.title.value = task.title; form.elements.description.value = task.description; form.elements.status.value = task.status; form.elements.excludeFromSppr.checked = task.excludeFromSppr === true; }
  form.elements.maxSpprHours.value = limitMinutes === null ? '' : String(limitMinutes / 60);
  form.elements.maxSpprHours.disabled = false;
  setText('#task-max-sppr-hint', state.settings.globalTaskLimitEnabled
    ? `Общий лимит: ${formatMinutes(state.settings.globalTaskLimitMinutes)}. При необходимости можно задать другой предел. Уже распределено: ${formatMinutes(allocatedMinutes)}.`
    : `Пустое значение не ограничивает СППР. Уже распределено: ${formatMinutes(allocatedMinutes)}.`);
}

function renderEntryTaskOptions() {
  const select = document.querySelector('#entry-task');
  const search = document.querySelector('#entry-task-search');
  const query = String(search?.value ?? '').trim().toLocaleLowerCase('ru-RU');
  const matchingTasks = state.entryTasks.filter((task) => `${task.spprNumber} ${task.title}`.toLocaleLowerCase('ru-RU').includes(query));
  select.replaceChildren();
  const placeholder = element('option', '', matchingTasks.length ? 'Выберите задачу' : 'Задачи не найдены');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);
  matchingTasks.forEach((task) => {
    const option = element('option', '', `${task.spprNumber} — ${task.title}`);
    option.value = task.id;
    select.append(option);
  });
  if (matchingTasks.some((task) => task.id === state.entryTaskSelection)) select.value = state.entryTaskSelection;
}

async function renderEntryForm() {
  cancelActiveRecording();
  const form = document.querySelector('#entry-form'); form.reset();
  delete form.dataset.submissionKey;
  state.recordingBlob = null;
  state.audioTranscript = null;
  state.audioProcessingPromise = null;
  state.pendingAttachments = [];
  renderPendingAttachments();
  setEntryFormBusy(false);
  setText('#recording-status', 'Нажмите, затем разрешите доступ к микрофону');
  const preview = document.querySelector('#audio-transcript-preview');
  if (preview) { preview.hidden = true; preview.textContent = ''; }
  const tasks = await taskRepository.list();
  const entry = await workEntryRepository.get(state.editingEntryId);
  state.entryTasks = tasks.filter((task) => task.status !== 'completed' || task.id === entry?.taskId);
  state.entryTaskSelection = entry?.taskId ?? state.selectedTaskId ?? state.entryTasks[0]?.id ?? '';
  document.querySelector('#entry-task-search').value = '';
  renderEntryTaskOptions();
  setText('#add-title', entry ? 'Редактирование записи' : 'Новая запись');
  state.entryType = entry?.entryType ?? 'text';
  form.elements.localDate.value = entry?.localDate ?? state.selectedDate;
  form.elements.note.value = entry?.note ?? '';
  form.elements.actualHours.value = entry ? Math.floor(entry.actualMinutes / 60) : 0;
  form.elements.actualMinutesPart.value = entry ? entry.actualMinutes % 60 : 0;
  updateEntryTypeUi();
}

function updateEntryTypeUi() {
  document.querySelectorAll('[data-format]').forEach((button) => button.classList.toggle('is-selected', button.dataset.format === state.entryType));
  document.querySelectorAll('[data-note-panel]').forEach((panel) => { panel.hidden = panel.dataset.notePanel !== state.entryType; });
}

async function renderReports() {
  const fromDate = state.reportFromDate; const toDate = state.reportToDate;
  const from = parseLocalDate(fromDate); const to = parseLocalDate(toDate);
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  const [tasks, entries, workDays] = await Promise.all([
    taskRepository.list({ includeArchived: true }),
    workEntryRepository.list({ fromDate, toDate }),
    workDayRepository.list({ fromDate, toDate }),
  ]);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const dayMap = new Map(workDays.map((day) => [day.localDate, day]));
  const periodLabel = formatReportPeriod(from, to, 'short');
  setText('#report-period-label', periodLabel);
  setText('#report-actual-total', formatMinutes(sumMinutes(entries)));
  setText('#report-average', entries.length ? `в среднем ${formatMinutes(Math.round(sumMinutes(entries) / dates.length))}/день` : 'нет записей');
  const spprTotal = workDays.reduce((total, day) => total + (day.allocations ?? []).reduce((sum, allocation) => sum + allocation.spprMinutes, 0), 0);
  const spprMetric = document.querySelector('#report-actual-total')?.closest('.metric-grid')?.querySelector('.metric-card--sppr strong');
  if (spprMetric) spprMetric.textContent = formatMinutes(spprTotal);
  const spprCaption = spprMetric?.nextElementSibling;
  if (spprCaption) spprCaption.textContent = workDays.some((day) => day.state === 'finished') ? 'по завершённым дням' : 'ещё не сформировано';

  const dayList = document.querySelector('#report-day-list');
  dayList.replaceChildren();
  dates.forEach((date) => {
    const localDate = toLocalDate(date);
    const actual = entries.filter((entry) => entry.localDate === localDate).reduce((total, entry) => total + entry.actualMinutes, 0);
    const sppr = (dayMap.get(localDate)?.allocations ?? []).reduce((total, allocation) => total + allocation.spprMinutes, 0);
    const row = element('div', 'report-table__row');
    row.append(element('span', '', formatDate(localDate, { weekday: 'short', day: 'numeric', month: 'short' })), element('b', '', formatMinutes(actual)), element('em', '', formatMinutes(sppr)));
    dayList.append(row);
  });

  const grouped = entries.reduce((map, entry) => map.set(entry.taskId, (map.get(entry.taskId) ?? 0) + entry.actualMinutes), new Map());
  const list = document.querySelector('#report-task-list'); list.replaceChildren();
  grouped.forEach((minutes, taskId) => { const task = taskMap.get(taskId); if (!task) return; const card = createTaskCard(task, minutes, { spprMinutes: getTaskSpprTotals(workDays).get(taskId) ?? 0 }); card.className = 'report-task-card'; list.append(card); });
  if (!list.children.length) list.append(emptyState('За выбранный период нет данных', 'Добавьте заметки, чтобы увидеть реальную загрузку.'));
  setText('#report-task-count', `${grouped.size} ${grouped.size === 1 ? 'задача' : grouped.size > 1 && grouped.size < 5 ? 'задачи' : 'задач'}`);
}

async function renderEndDay() {
  const [entries, workDay, tasks, workDays] = await Promise.all([
    workEntryRepository.list({ localDate: state.selectedDate }),
    workDayRepository.get(state.selectedDate),
    taskRepository.list({ includeArchived: true }),
    workDayRepository.list(),
  ]);
  const actual = sumMinutes(entries);
  const targetMinutes = roundToInterval(workDay?.targetMinutes ?? state.settings.dailyTargetMinutes, 30);
  const difference = targetMinutes - actual;
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const historicTotals = getTaskSpprTotals(workDays.filter((day) => day.localDate !== state.selectedDate));
  const groups = [...entries.filter((entry) => entry.excludeFromSppr !== true).reduce((map, entry) => {
    const current = map.get(entry.taskId) ?? { taskId: entry.taskId, actualMinutes: 0 };
    current.actualMinutes += Math.max(0, Number(entry.actualMinutes) || 0);
    map.set(entry.taskId, current);
    return map;
  }, new Map()).values()]
    .map((group) => ({ ...group, remainingSpprMinutes: getRemainingSpprMinutes(taskMap.get(group.taskId)?.maxSpprMinutes, historicTotals.get(group.taskId) ?? 0) }));
  const availableMinutes = distributeSpprWithLimits(groups, targetMinutes).reduce((sum, allocation) => sum + allocation.spprMinutes, 0);
  setText('#end-day-date', formatDate(state.selectedDate, { weekday: 'long', day: 'numeric', month: 'long' }));
  setText('#end-day-actual', formatMinutes(actual));
  setText('#end-day-target', formatMinutes(targetMinutes));
  setText('#end-day-difference', signedMinutes(difference));
  setText('#end-day-difference-caption', availableMinutes < targetMinutes ? `лимиты позволяют распределить не более ${formatMinutes(availableMinutes)}` : difference > 0 ? 'будет добавлено до нормы' : difference < 0 ? 'будет уменьшено до нормы' : 'реальное время уже равно норме');
  const proportional = document.querySelector('input[name="allocation"][value="proportional"]');
  if (proportional) proportional.checked = true;
  const aiOption = document.querySelector('input[name="allocation"][value="ai"]');
  if (aiOption) {
    aiOption.disabled = !isAiReady();
    const card = aiOption.closest('.option-card');
    card?.classList.toggle('option-card--disabled', !isAiReady());
    const hint = card?.querySelector('small');
    if (hint) hint.textContent = isAiReady() ? 'Улучшит записи и предложит распределение' : 'Заполните подключение ИИ для текущего сеанса';
  }
}

async function improveEntry(entryId) {
  const entry = await workEntryRepository.get(entryId);
  const task = await taskRepository.get(entry?.taskId);
  if (!entry || !task) throw new Error('Запись или задача не найдены.');
  const sourceText = String(entry.note || entry.transcript || '').trim();
  if (!sourceText) throw new Error('Для улучшения сначала добавьте текст заметки.');
  requireAiConsent('текст этой записи');
  const payload = entryPayload({ ...entry, note: sourceText }, task);
  const result = await improveEntryDescription({ config: state.ai, editablePrompt: state.ai.prompts.entry, payload, sourceText });
  await workEntryRepository.saveAiResult(entry.id, { ...result, mode: 'entry' });
  showToast(result.warnings.length ? 'Результат подготовлен с предупреждением' : result.retried ? 'Описание СППР подготовлено после углублённой переработки' : 'Описание СППР подготовлено');
  await renderTaskDetail();
}

async function improveTaskDescription() {
  const form = document.querySelector('#task-form');
  const description = String(form.elements.description.value ?? '').trim();
  const title = String(form.elements.title.value ?? '').trim();
  const spprNumber = String(form.elements.spprNumber.value ?? '').trim();
  if (!description) throw new Error('Сначала введите исходное описание задачи.');
  requireAiConsent('описание задачи');
  const response = await completeJson(state.ai, buildPrompt('task', state.ai.prompts.task, { task: { taskId: state.editingTaskId ?? null, spprNumber, title, description } }));
  const result = parseAiResult('task', response);
  form.elements.description.value = result.spprDescription;
  showToast(result.warnings.length ? 'Описание улучшено с предупреждением' : 'Описание задачи улучшено');
}

async function improveDayWithAi(tasks, entries, targetMinutes, eligibleGroups) {
  requireAiConsent(`все записи за ${formatDate(state.selectedDate)}`);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const eligibleTaskIds = new Set(eligibleGroups.map((group) => group.taskId));
  const payload = {
    localDate: state.selectedDate,
    targetMinutes,
    distributionTaskIds: eligibleGroups.map((group) => group.taskId),
    tasks: tasks.filter((task) => eligibleTaskIds.has(task.id)).map((task) => ({
      taskId: task.id,
      spprNumber: task.spprNumber,
      title: task.title,
    })),
    entries: entries
      .filter((entry) => eligibleTaskIds.has(entry.taskId) && entry.excludeFromSppr !== true)
      .map((entry) => entryPayload(entry, taskMap.get(entry.taskId))),
  };
  const response = await completeJson(state.ai, buildPrompt('day', state.ai.prompts.day, payload));
  const result = parseAiResult('day', response);
  const entryIds = new Set(payload.entries.map((entry) => entry.entryId));
  const warnings = [...result.warnings];
  const aiEntries = new Map();
  result.entries.forEach((item) => {
    if (!entryIds.has(item.entryId)) {
      warnings.push('ИИ вернул описание для записи вне выбранного дня — оно пропущено.');
      return;
    }
    aiEntries.set(item.entryId, item.spprDescription);
  });
  const aiAllocations = new Map();
  for (const allocation of result.allocations) {
    if (!eligibleTaskIds.has(allocation.taskId)) {
      warnings.push('ИИ включил в распределение задачу вне выбранного дня — она пропущена.');
      continue;
    }
    const current = aiAllocations.get(allocation.taskId) ?? { minutes: 0, reasons: [] };
    current.minutes += allocation.minutes;
    if (allocation.reason) current.reasons.push(allocation.reason);
    aiAllocations.set(allocation.taskId, current);
  }
  const weightedGroups = eligibleGroups.map((group) => ({ ...group, aiMinutes: aiAllocations.get(group.taskId)?.minutes ?? 0 })).filter((group) => group.aiMinutes > 0);
  const distributionSource = weightedGroups.length ? weightedGroups : eligibleGroups;
  if (!weightedGroups.length) warnings.push('ИИ не вернул пригодное распределение; применено распределение по реальному времени.');
  if (result.allocations.reduce((sum, item) => sum + item.minutes, 0) !== targetMinutes || weightedGroups.length !== aiAllocations.size) warnings.push('Время из ответа ИИ приведено к норме дня.');
  for (const [entryId, spprDescription] of aiEntries) await workEntryRepository.saveAiResult(entryId, { spprDescription, warnings, mode: 'day' });
  const weightKey = weightedGroups.length ? 'aiMinutes' : 'actualMinutes';
  return {
    warnings,
    allocations: distributeSpprWithLimits(distributionSource, targetMinutes, weightKey).filter((allocation) => allocation.spprMinutes > 0).map((allocation) => {
      const group = eligibleGroups.find((item) => item.taskId === allocation.taskId);
      const aiAllocation = aiAllocations.get(allocation.taskId);
      return {
        taskId: group.taskId, actualMinutes: group.actualMinutes, spprMinutes: allocation.spprMinutes,
        reason: aiAllocation?.reasons.join(' ') || '',
        description: mergeDescriptions(group.entries, aiEntries),
        entryAllocations: distributeRoundedMinutes(group.entries, allocation.spprMinutes, 'actualMinutes').map((entry) => ({ entryId: entry.id, actualMinutes: entry.actualMinutes, spprMinutes: entry.spprMinutes })),
      };
    }),
  };
}

async function finishDay() {
  const [tasks, entries, workDay, workDays] = await Promise.all([
    taskRepository.list({ includeArchived: true }),
    workEntryRepository.list({ localDate: state.selectedDate }),
    workDayRepository.get(state.selectedDate),
    workDayRepository.list(),
  ]);
  const targetMinutes = roundToInterval(workDay?.targetMinutes ?? state.settings.dailyTargetMinutes, 30);
  if (!hasRecordedWork(entries)) {
    await workDayRepository.resetEmpty(state.selectedDate);
    await clearReminderState({ cancelNative: true });
    scheduleReminder();
    showToast('Пустой рабочий день сброшен. Его можно начать заново.');
    await goBackInApp();
    return;
  }
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const grouped = [...entries.filter((entry) => entry.excludeFromSppr !== true).reduce((map, entry) => {
    const current = map.get(entry.taskId) ?? { taskId: entry.taskId, actualMinutes: 0, entries: [] };
    current.actualMinutes += entry.actualMinutes;
    current.entries.push(entry);
    map.set(entry.taskId, current);
    return map;
  }, new Map()).values()];
  const historicTotals = getTaskSpprTotals(workDays.filter((day) => day.localDate !== state.selectedDate));
  const eligibleGroups = grouped
    .map((group) => ({
      ...group,
      remainingSpprMinutes: getRemainingSpprMinutes(taskMap.get(group.taskId)?.maxSpprMinutes, historicTotals.get(group.taskId) ?? 0),
    }))
    .filter((group) => group.remainingSpprMinutes === null || group.remainingSpprMinutes > 0);
  const capacityPreview = distributeSpprWithLimits(eligibleGroups, targetMinutes, 'actualMinutes');
  const distributionTargetMinutes = capacityPreview.reduce((sum, allocation) => sum + allocation.spprMinutes, 0);
  const limitedByTaskCaps = distributionTargetMinutes < targetMinutes;
  const strategy = distributionTargetMinutes > 0 && document.querySelector('input[name="allocation"]:checked')?.value === 'ai' ? 'ai' : 'proportional';
  let aiWarnings = limitedByTaskCaps ? [`Распределено ${formatMinutes(distributionTargetMinutes)} из нормы ${formatMinutes(targetMinutes)}: достигнут лимит часов по задачам.`] : [];
  let taskAllocations;
  if (strategy === 'ai') {
    const aiResult = await improveDayWithAi(tasks, entries, distributionTargetMinutes, eligibleGroups);
    taskAllocations = aiResult.allocations;
    aiWarnings.push(...aiResult.warnings);
  } else taskAllocations = capacityPreview.filter((allocation) => allocation.spprMinutes > 0).map((allocation) => ({
    taskId: allocation.taskId,
    actualMinutes: allocation.actualMinutes,
    spprMinutes: allocation.spprMinutes,
    description: mergeDescriptions(allocation.entries),
    entryAllocations: distributeRoundedMinutes(allocation.entries, allocation.spprMinutes, 'actualMinutes').map((entry) => ({
      entryId: entry.id,
      actualMinutes: entry.actualMinutes,
      spprMinutes: entry.spprMinutes,
    })),
  }));
  const knownTasks = new Set(tasks.map((task) => task.id));
  if (taskAllocations.some((allocation) => !knownTasks.has(allocation.taskId))) throw new Error('Одна из задач больше недоступна.');
  await workDayRepository.saveResult({
    localDate: state.selectedDate,
    targetMinutes,
    strategy,
    allocations: taskAllocations,
    aiWarnings,
  });
  state.reminderNextAt = null;
  await saveSetting('reminderNextAt', null);
  await cancelNativeReminders();
  scheduleReminder();
  renderReminderCountdown();
  state.resultView = 'tasks';
  showToast(distributionTargetMinutes > 0
    ? (limitedByTaskCaps ? `День завершён: по лимитам распределено ${formatMinutes(distributionTargetMinutes)}` : strategy === 'ai' ? (aiWarnings.length ? 'День улучшен, распределение скорректировано' : 'День улучшен и распределён') : 'День завершён и распределён')
    : 'День завершён: задачи исключены из СППР или достигли лимита');
  await showScreen('day-result', { updateHistory: true });
}

async function renderDayResult() {
  const [day, tasks, entries] = await Promise.all([
    workDayRepository.get(state.selectedDate),
    taskRepository.list({ includeArchived: true }),
    workEntryRepository.list({ localDate: state.selectedDate }),
  ]);
  const list = document.querySelector('#day-result-list');
  list.replaceChildren();
  if (!day?.allocations?.length) {
    const finishedWithoutSppr = day?.state === 'finished';
    list.append(emptyState(finishedWithoutSppr ? 'Нет задач для распределения' : 'День ещё не подготовлен', finishedWithoutSppr ? 'Все задачи исключены из СППР или уже достигли лимита часов.' : 'Вернитесь и выполните распределение времени.', finishedWithoutSppr ? null : 'Завершить день', finishedWithoutSppr ? null : 'open-end-day'));
    setText('#result-actual', formatMinutes(sumMinutes(entries)));
    setText('#result-target', formatMinutes(0));
    setText('#result-summary', `Сумма СППР — ${formatMinutes(0)}`);
    return;
  }
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const tableHead = document.querySelector('#result-table-head span:first-child');
  if (tableHead) tableHead.textContent = state.resultView === 'tasks' ? 'Задача' : 'Запись';
  document.querySelectorAll('[data-result-view]').forEach((button) => button.classList.toggle('is-selected', button.dataset.resultView === state.resultView));
  setText('#result-actual', formatMinutes(sumMinutes(entries)));
  const distributedMinutes = day.allocations.reduce((sum, allocation) => sum + allocation.spprMinutes, 0);
  setText('#result-target', formatMinutes(distributedMinutes));
  setText('#result-summary', `Сумма СППР — ${formatMinutes(distributedMinutes)}${distributedMinutes < day.targetMinutes ? ` из нормы ${formatMinutes(day.targetMinutes)}` : ''}`);

  const rows = state.resultView === 'tasks'
    ? day.allocations.map((allocation) => ({
        title: taskMap.get(allocation.taskId)?.spprNumber ?? 'Удалённая задача',
        subtitle: allocationDescription(allocation, entryMap, taskMap.get(allocation.taskId)?.title ?? ''),
        actualMinutes: allocation.actualMinutes,
        spprMinutes: allocation.spprMinutes,
      }))
    : day.allocations.flatMap((allocation) => (allocation.entryAllocations ?? []).map((item) => {
        const entry = entryMap.get(item.entryId);
        return {
          title: taskMap.get(allocation.taskId)?.spprNumber ?? 'Задача',
          subtitle: entry?.spprDescription || entry?.note || 'Запись без текста',
          actualMinutes: item.actualMinutes,
          spprMinutes: item.spprMinutes,
        };
      }));
  rows.forEach((row) => {
    const article = element('article');
    const info = element('span');
    info.append(element('strong', '', row.title), element('small', '', row.subtitle));
    article.append(info, element('b', '', formatMinutes(row.actualMinutes)), element('em', '', formatMinutes(row.spprMinutes)));
    list.append(article);
  });
}

function buildReportText(days, taskMap, entries) {
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const lines = [`Отчёт СППР за ${document.querySelector('#sppr-report-period')?.textContent ?? 'период'}`, ''];
  days.forEach((day) => {
    const distributedMinutes = day.allocations.reduce((sum, allocation) => sum + allocation.spprMinutes, 0);
    lines.push(`${formatDate(day.localDate)} — ${formatMinutes(distributedMinutes)}${distributedMinutes < day.targetMinutes ? ` из нормы ${formatMinutes(day.targetMinutes)}` : ''}`);
    day.allocations.forEach((allocation) => {
      const task = taskMap.get(allocation.taskId);
      const notes = allocationDescription(allocation, entryMap, task?.title ?? 'Работы выполнены');
      lines.push(`${task?.spprNumber ?? 'Задача'} · ${formatMinutes(allocation.spprMinutes)} — ${notes || task?.title || 'Работы выполнены'}`);
    });
    lines.push('');
  });
  return lines.join('\n').trim();
}

async function renderSpprReport() {
  const fromDate = state.reportFromDate; const toDate = state.reportToDate;
  const [days, tasks, entries] = await Promise.all([
    workDayRepository.list({ fromDate, toDate }),
    taskRepository.list({ includeArchived: true }),
    workEntryRepository.list({ fromDate, toDate }),
  ]);
  const finishedDays = days.filter((day) => day.state === 'finished' && day.allocations?.length);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const period = formatReportPeriod(parseLocalDate(fromDate), parseLocalDate(toDate));
  setText('#sppr-report-period', period);
  const total = finishedDays.reduce((sum, day) => sum + day.allocations.reduce((daySum, allocation) => daySum + allocation.spprMinutes, 0), 0);
  setText('#sppr-report-total', formatMinutes(total));
  setText('#sppr-report-status', finishedDays.length ? `Подготовлено дней: ${finishedDays.length}` : 'Нет подготовленных дней');
  const list = document.querySelector('#sppr-day-list');
  list.replaceChildren();
  state.reportRows = [];
  finishedDays.forEach((day) => {
    const article = element('article');
    const header = element('header');
    const distributedMinutes = day.allocations.reduce((sum, allocation) => sum + allocation.spprMinutes, 0);
    header.append(element('strong', '', formatDate(day.localDate)), element('span', '', `${formatMinutes(distributedMinutes)}${distributedMinutes < day.targetMinutes ? ` / ${formatMinutes(day.targetMinutes)}` : ''}`));
    const body = element('div');
    day.allocations.forEach((allocation) => {
      const task = taskMap.get(allocation.taskId);
      const notes = allocationDescription(allocation, entryMap, task?.title ?? 'Работы выполнены');
      const paragraph = element('p');
      paragraph.append(element('b', '', `${task?.spprNumber ?? 'Задача'} · ${formatMinutes(allocation.spprMinutes)}`), document.createTextNode(notes || task?.title || 'Работы выполнены'));
      body.append(paragraph);
      state.reportRows.push({
        date: day.localDate,
        task: task?.spprNumber ?? 'Задача',
        title: task?.title ?? '',
        minutes: allocation.spprMinutes,
        description: notes,
      });
    });
    article.append(header, body);
    list.append(article);
  });
  if (!finishedDays.length) list.append(emptyState('Отчёт пока пуст', 'Завершите хотя бы один день выбранного периода.'));
  state.reportText = buildReportText(finishedDays, taskMap, entries);
}

async function renderSettings() {
  const sectionTitles = { reminders: 'Напоминания', sppr: 'Лимиты СППР', appearance: 'Оформление', data: 'Данные и резервные копии' };
  setText('#settings-title', sectionTitles[state.settingsSection] ?? 'Настройки');
  document.querySelectorAll('[data-settings-group]').forEach((group) => { group.hidden = group.dataset.settingsGroup !== state.settingsSection; });
  const reminders = document.querySelector('#reminders-enabled');
  reminders.checked = state.settings.remindersEnabled;
  document.querySelector('#reminder-interval').value = String(state.settings.reminderInterval);
  document.querySelector('#daily-target-hours').value = String(state.settings.dailyTargetMinutes / 60);
  document.querySelector('#global-task-limit-enabled').checked = state.settings.globalTaskLimitEnabled;
  document.querySelector('#global-task-limit-hours').value = state.settings.globalTaskLimitMinutes === null ? '' : String(state.settings.globalTaskLimitMinutes / 60);
  document.querySelector('#theme-system').checked = state.settings.followSystemTheme;
  document.querySelector('#theme-options').classList.toggle('is-disabled', state.settings.followSystemTheme);
  document.querySelectorAll('[data-theme-option]').forEach((button) => button.classList.toggle('is-selected', button.dataset.themeOption === state.settings.themeMode));
}

function renderMore() {
  setText('#more-reminder-summary', state.settings.remindersEnabled ? `Каждые ${reminderIntervalLabel(state.settings.reminderInterval)}` : 'Выключены');
  setText('#more-sppr-limit-summary', state.settings.globalTaskLimitEnabled && state.settings.globalTaskLimitMinutes !== null ? `${state.settings.globalTaskLimitMinutes / 60} ч на задачу` : 'Без общего лимита');
  setText('#more-theme-summary', state.settings.followSystemTheme ? 'Как на устройстве' : state.settings.themeMode === 'light' ? 'Светлая тема' : 'Тёмная тема');
  setText('#more-ai-summary', state.ai.baseUrl && state.ai.model && state.ai.transcriptionModel ? (state.ai.apiKey ? 'Подключение сохранено' : 'Настройки сохранены') : 'Провайдер не подключен');
}

async function renderAiSettings() {
  const form = document.querySelector('#ai-settings-form');
  form.elements.provider.value = state.ai.provider;
  form.elements.baseUrl.value = state.ai.baseUrl;
  selectOptionValue(form.elements.model, state.ai.model);
  selectOptionValue(form.elements.transcriptionModel, state.ai.transcriptionModel);
  form.elements.apiKey.value = state.ai.apiKey;
  form.elements.entryPrompt.value = state.ai.prompts.entry;
  form.elements.dayPrompt.value = state.ai.prompts.day;
  form.elements.audioPrompt.value = state.ai.prompts.audio;
  form.elements.taskPrompt.value = state.ai.prompts.task;
  const status = document.querySelector('#ai-connection-status');
  const ready = isAiReady();
  status.classList.toggle('is-ready', ready);
  status.textContent = ready
    ? 'Подключение готово. Аудио автоматически расшифровывается; улучшение текста запускается отдельно.'
    : state.ai.baseUrl && state.ai.model
      ? 'Параметры сохранены. Введите API-ключ для подключения.'
      : 'Подключение не настроено';
}

async function renderRoute(route) {
  if (route === 'today') return renderToday();
  if (route === 'calendar') return renderCalendar();
  if (route === 'tasks') return renderTasks();
  if (route === 'task-real') return renderTaskDetail();
  if (route === 'task-editor') return renderTaskEditor();
  if (route === 'add-entry') return renderEntryForm();
  if (route === 'end-day') return renderEndDay();
  if (route === 'day-result') return renderDayResult();
  if (route === 'reports') return renderReports();
  if (route === 'report-sppr') return renderSpprReport();
  if (route === 'settings') return renderSettings();
  if (route === 'ai-settings') return renderAiSettings();
  if (route === 'more') return renderMore();
}

function setEntryFormBusy(busy) {
  const saveButton = document.querySelector('[type="submit"][form="entry-form"]');
  if (saveButton) saveButton.disabled = busy;
  const recordButton = document.querySelector('[data-action="toggle-recording"]');
  if (recordButton) recordButton.disabled = busy;
  document.querySelector('#entry-form')?.setAttribute('aria-busy', String(busy));
}

function submissionKeyFor(form) {
  if (!form.dataset.submissionKey) {
    form.dataset.submissionKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return form.dataset.submissionKey;
}

function cancelActiveRecording() {
  const recorder = state.mediaRecorder;
  state.mediaRecorder = null;
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  if (recorder?.state === 'recording') recorder.stop();
  document.querySelector('[data-action="toggle-recording"]')?.classList.remove('is-recording');
}

function audioFilename(audio) {
  const subtype = String(audio.type || '').split('/')[1]?.split(';')[0] || 'webm';
  const extension = subtype === 'mpeg' ? 'mp3' : subtype === 'mp4' ? 'm4a' : subtype;
  return `worklog-audio.${extension}`;
}

async function processRecordedAudio(audio) {
  setEntryFormBusy(true);
  setText('#recording-status', 'Расшифровываю аудио…');
  try {
    const transcript = await transcribeAudio(
      { ...state.ai, model: state.ai.transcriptionModel, prompt: state.ai.prompts.audio },
      audio,
      audioFilename(audio),
    );
    state.audioTranscript = transcript;
    const note = document.querySelector('#entry-note');
    if (note) note.value = transcript;
    setText('#recording-status', 'Готово: аудио переведено в текст. Текст можно отредактировать.');
    const preview = document.querySelector('#audio-transcript-preview');
    if (preview) { preview.textContent = transcript; preview.hidden = false; }
    showToast('Аудио расшифровано. После сохранения текст можно улучшить отдельно.');
  } catch (error) {
    state.audioTranscript = null;
    setText('#recording-status', `Ошибка обработки: ${error.message}`);
    showToast(error.message || 'Не удалось обработать аудио.', 'error');
  } finally {
    setEntryFormBusy(false);
  }
}

async function startRecording(button) {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('Запись голоса не поддерживается этим браузером.');
  requireAiConsent('аудиозапись после её остановки для автоматической расшифровки');
  state.audioTranscript = null;
  state.recordingBlob = null;
  const preview = document.querySelector('#audio-transcript-preview');
  if (preview) { preview.hidden = true; preview.textContent = ''; }
  const chunks = [];
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    if (error?.name === 'NotAllowedError') throw new Error('Разрешите доступ к микрофону в настройках приложения и попробуйте снова.');
    if (error?.name === 'NotFoundError') throw new Error('Микрофон не найден или недоступен на устройстве.');
    throw new Error('Не удалось включить микрофон. Проверьте разрешение и попробуйте снова.');
  }
  const recorder = new MediaRecorder(stream);
  state.mediaStream = stream;
  state.mediaRecorder = recorder;
  recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener('stop', () => {
    if (state.mediaRecorder === recorder) {
      state.recordingBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      state.mediaRecorder = null;
      state.mediaStream = null;
      state.audioProcessingPromise = processRecordedAudio(state.recordingBlob)
        .finally(() => { state.audioProcessingPromise = null; });
    }
    stream.getTracks().forEach((track) => track.stop());
    button.classList.remove('is-recording');
  });
  recorder.addEventListener('error', () => {
    cancelActiveRecording();
    setEntryFormBusy(false);
    setText('#recording-status', 'Ошибка записи. Попробуйте ещё раз.');
  }, { once: true });
  recorder.start(); button.classList.add('is-recording'); setText('#recording-status', 'Идёт запись… Нажмите ещё раз для остановки');
}

async function copyReport() {
  if (!state.reportRows.length) throw new Error('Сначала завершите день, чтобы сформировать отчёт.');
  if (!navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен в этом браузере.');
  await navigator.clipboard.writeText(state.reportText);
  showToast('Отчёт скопирован');
}

async function copyText(text) {
  if (!navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен в этом браузере.');
  await navigator.clipboard.writeText(text);
  showToast('Описание скопировано');
}

async function exportReport(format) {
  if (state.exportBusy) return;
  const dialog = document.querySelector('#export-dialog');
  const status = document.querySelector('#export-status');
  const fromDate = document.querySelector('#export-from-date')?.value;
  const toDate = document.querySelector('#export-to-date')?.value;
  if (!fromDate || !toDate) {
    showToast('Укажите дату начала и окончания отчёта.');
    return;
  }
  if (fromDate > toDate) {
    showToast('Дата начала не может быть позже даты окончания.');
    return;
  }
  state.exportBusy = true;
  dialog?.setAttribute('aria-busy', 'true');
  if (status) {
    status.hidden = false;
    status.textContent = format === 'xlsx' ? 'Формируем Excel с дашбордом…' : 'Формируем PDF с дашбордом…';
  }
  try {
    const [tasks, entries, workDays] = await Promise.all([
      taskRepository.list({ includeArchived: true }),
      workEntryRepository.list({ fromDate, toDate }),
      workDayRepository.list({ fromDate, toDate }),
    ]);
    const report = buildSpprExportReport({ fromDate, toDate, tasks, entries, workDays });
    if (!report.rows.length) throw new Error('За выбранный период нет данных для отчёта.');
    const blob = format === 'xlsx'
      ? await createExcelReportBlob(report)
      : await createPdfReportBlob(report);
    const extension = format === 'xlsx' ? 'xlsx' : 'pdf';
    const filename = `worklog-sppr-${fromDate}-${toDate}.${extension}`;
    if (status) status.textContent = 'Отчёт готов. Открываем системное меню отправки…';
    await deliverReportFile({
      blob,
      filename,
      title: `Отчёт СППР ${report.periodLabel}`,
      filesystem: nativePlugin('Filesystem'),
      share: nativePlugin('Share'),
      browserDownload: downloadFile,
    });
    dialog?.close();
    showToast('Отчёт сформирован');
  } finally {
    state.exportBusy = false;
    dialog?.removeAttribute('aria-busy');
    if (status) status.hidden = true;
  }
}

function openExportDialog() {
  const weekStart = startOfWeek(new Date());
  document.querySelector('#export-from-date').value = toLocalDate(weekStart);
  document.querySelector('#export-to-date').value = toLocalDate(addDays(weekStart, 6));
  const status = document.querySelector('#export-status');
  if (status) status.hidden = true;
  document.querySelector('#export-dialog')?.showModal();
}

async function backupData() {
  if (state.backupBusy) return;
  state.backupBusy = true;
  try {
    showToast('Готовим резервную копию…');
    const backup = await createBackup();
    const filename = `worklog-ai-backup-${toLocalDate()}.json`;
    await deliverReportFile({
      blob: new Blob([JSON.stringify(backup)], { type: 'application/json;charset=utf-8' }),
      filename,
      title: `Резервная копия WorkLog AI ${formatDate(toLocalDate())}`,
      filesystem: nativePlugin('Filesystem'),
      share: nativePlugin('Share'),
      browserDownload: downloadFile,
      directoryName: 'worklog-backups',
    });
    showToast('Резервная копия создана');
  } finally {
    state.backupBusy = false;
  }
}

function decodeBase64Utf8(value) {
  const bytes = Uint8Array.from(atob(String(value ?? '')), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function restoreBackupFromText(text) {
  if (!confirm('Импорт заменит текущие локальные данные. Продолжить?')) return;
  const backup = JSON.parse(text);
  await restoreBackup(backup);
  showToast('Резервная копия восстановлена');
  setTimeout(() => location.reload(), 600);
}

async function chooseBackupFile() {
  const filePicker = nativePlugin('FilePicker');
  if (!filePicker) {
    document.querySelector('#backup-file')?.click();
    return;
  }
  const result = await filePicker.pickFiles({ limit: 1, readData: true });
  const file = result.files?.[0];
  if (!file) return;
  if (!file.data) throw new Error('Не удалось прочитать выбранный файл резервной копии.');
  await restoreBackupFromText(decodeBase64Utf8(file.data));
}

async function beginToday() {
  const date = state.selectedDate;
  state.weekStart = startOfWeek(parseLocalDate(date));
  if (!await startWorkDay(date)) return;
  await renderToday();
}

async function beginSelectedDay() {
  if (!await startWorkDay(state.selectedDate)) return;
  await renderCalendar();
}

async function startWorkDay(localDate) {
  try {
    await workDayRepository.start({ localDate, targetMinutes: roundToInterval(state.settings.dailyTargetMinutes, 30) });
  } catch (error) {
    if (error?.code !== 'ACTIVE_DAY_EXISTS' || !error.activeLocalDate) throw error;
    const activeDate = error.activeLocalDate;
    if (confirm(`Уже активен рабочий день за ${formatDate(activeDate)}. Завершите его перед запуском другого.\n\nПерейти к активному дню?`)) {
      state.selectedDate = activeDate;
      state.weekStart = startOfWeek(parseLocalDate(activeDate));
      await showScreen('calendar', { updateHistory: true });
    }
    return false;
  }
  let notificationScheduled = false;
  let notificationError = null;
  try {
    notificationScheduled = await notifyDayStart();
  } catch (error) {
    notificationError = error;
    await clearReminderState({ cancelNative: true });
  }
  scheduleReminder();
  if (notificationError) showToast(`Рабочий день начат, но напоминания не включены: ${notificationError.message}`, 'error');
  else showToast(notificationScheduled ? `Рабочий день начат. Системное напоминание через ${reminderIntervalLabel(state.settings.reminderInterval)}.` : 'Рабочий день начат');
  return true;
}

async function ensureDayForEntry(localDate) {
  const workDay = await workDayRepository.get(localDate);
  if (!workDay) await workDayRepository.ensureDraft({ localDate, targetMinutes: state.settings.dailyTargetMinutes });
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'open-task') { state.selectedTaskId = button.dataset.taskId; return showScreen('task-real', { updateHistory: true }); }
  if (action === 'new-task') { state.editingTaskId = null; return showScreen('task-editor', { updateHistory: true }); }
  if (action === 'edit-task') {
    const task = await ensureSelectedTask();
    if (task?.status === 'completed') throw new Error('Завершённую задачу нельзя изменять.');
    state.editingTaskId = state.selectedTaskId; return showScreen('task-editor', { updateHistory: true });
  }
  if (action === 'edit-task-list') { state.editingTaskId = button.dataset.taskId; return showScreen('task-editor', { updateHistory: true }); }
  if (action === 'new-entry') {
    state.editingEntryId = null;
    return showScreen('add-entry', { updateHistory: true });
  }
  if (action === 'capture-attachment') return captureAttachmentPhoto();
  if (action === 'remove-pending-attachment') {
    const index = Number(button.dataset.attachmentIndex);
    if (Number.isInteger(index) && index >= 0) state.pendingAttachments.splice(index, 1);
    renderPendingAttachments();
    return;
  }
  if (action === 'edit-entry') { state.editingEntryId = button.dataset.entryId; return showScreen('add-entry', { updateHistory: true }); }
  if (action === 'edit-sppr-description') {
    const entry = await workEntryRepository.get(button.dataset.entryId);
    if (!entry?.spprDescription?.trim()) throw new Error('Описание СППР ещё не подготовлено.');
    state.editingSpprEntryId = entry.id;
    document.querySelector('#sppr-description-editor').value = entry.spprDescription;
    document.querySelector('#sppr-description-dialog')?.showModal();
    return;
  }
  if (action === 'close-sppr-description') {
    state.editingSpprEntryId = null;
    document.querySelector('#sppr-description-dialog')?.close();
    return;
  }
  if (action === 'delete-entry') {
    if (!confirm('Удалить эту запись вместе со всеми вложениями и историей изменений? Действие нельзя отменить.')) return;
    await workEntryRepository.remove(button.dataset.entryId);
    showToast('Запись и связанные данные удалены');
    return renderTaskDetail();
  }
  if (action === 'archive-task') { if (!confirm('Архивировать задачу? Заметки сохранятся.')) return; await taskRepository.archive(state.selectedTaskId); showToast('Задача архивирована'); return showScreen('tasks', { updateHistory: true }); }
  if (action === 'delete-task') {
    if (!confirm('Удалить задачу вместе со всеми её записями, аудио и историей изменений? Это действие нельзя отменить.')) return;
    await taskRepository.remove(state.selectedTaskId);
    state.selectedTaskId = null;
    showToast('Задача и связанные записи удалены');
    return showScreen('tasks', { updateHistory: true });
  }
  if (action === 'delete-task-list') {
    if (!confirm('Удалить задачу вместе со всеми её записями, аудио и историей изменений? Это действие нельзя отменить.')) return;
    await taskRepository.remove(button.dataset.taskId);
    showToast('Задача и связанные записи удалены');
    return renderTasks();
  }
  if (action === 'complete-task-list') {
    const task = await taskRepository.get(button.dataset.taskId);
    if (!task || task.status === 'completed') return;
    await taskRepository.save({ ...task, status: 'completed' });
    showToast('Задача завершена');
    return renderTasks();
  }
  if (action === 'toggle-task-status') {
    const task = await ensureSelectedTask();
    if (!task) return;
    const status = task.status === 'completed' ? 'active' : 'completed';
    await taskRepository.save({ ...task, status });
    showToast(status === 'completed' ? 'Задача завершена' : 'Задача возвращена в активные');
    return renderTaskDetail();
  }
  if (action === 'select-date') { state.selectedDate = button.dataset.date; return renderCalendar(); }
  if (action === 'previous-week' || action === 'next-week') { state.weekStart = addDays(state.weekStart, action === 'previous-week' ? -7 : 7); state.selectedDate = toLocalDate(state.weekStart); return renderCalendar(); }
  if (action === 'toggle-recording') { if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop(); else await startRecording(button); }
  if (action === 'open-end-day') return showScreen('end-day', { updateHistory: true });
  if (action === 'begin-today') return beginToday();
  if (action === 'start-selected-day') return beginSelectedDay();
  if (action === 'end-today') return showScreen('end-day', { updateHistory: true });
  if (action === 'open-today-result') return showScreen('day-result', { updateHistory: true });
  if (action === 'open-selected-result') return showScreen('day-result', { updateHistory: true });
  if (action === 'finish-day') return finishDay();
  if (action === 'improve-entry') return improveEntry(button.dataset.entryId);
  if (action === 'improve-task-description') return improveTaskDescription();
  if (action === 'copy-report') return copyReport();
  if (action === 'copy-text') return copyText(button.dataset.copyText);
  if (action === 'open-report-period') {
    const dialog = document.querySelector('#report-period-dialog');
    document.querySelector('#report-from-date').value = state.reportFromDate;
    document.querySelector('#report-to-date').value = state.reportToDate;
    dialog?.showModal();
    return;
  }
  if (action === 'close-report-period') { document.querySelector('#report-period-dialog')?.close(); return; }
  if (action === 'open-export') {
    openExportDialog();
    return;
  }
  if (action === 'export-xlsx') return exportReport('xlsx');
  if (action === 'export-pdf') return exportReport('pdf');
  if (action === 'backup-data') return backupData();
  if (action === 'choose-backup') return chooseBackupFile();
  if (action === 'clear-ai-key') {
    state.ai.apiKey = '';
    await saveAiConfig();
    await renderAiSettings();
    showToast('Ключ удалён с устройства');
  }
  if (action === 'reset-ai-prompts') {
    state.ai.prompts = { ...DEFAULT_PROMPTS };
    await saveAiConfig();
    await renderAiSettings();
    showToast('Стандартные шаблоны восстановлены и сохранены');
  }
  if (action === 'retry-app') {
    if (navigator.onLine) { showToast('Соединение доступно'); return showScreen('calendar', { updateHistory: true }); }
    throw new Error('Интернет по-прежнему недоступен.');
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target) return;
  const actionButton = target.closest('[data-action]');
  if (actionButton) { try { await handleAction(actionButton); } catch (error) { showToast(error.message, 'error'); } return; }
  const routeButton = target.closest('[data-route]');
  if (routeButton) { if (routeButton.dataset.route === 'add-entry') state.editingEntryId = null; if (routeButton.dataset.settingsSection) state.settingsSection = routeButton.dataset.settingsSection; await showScreen(routeButton.dataset.route, { updateHistory: true }); return; }
  if (target.closest('[data-back]')) { await goBackInApp(); return; }
  const filter = target.closest('[data-task-filter]');
  if (filter) { state.taskFilter = filter.dataset.taskFilter; filter.parentElement.querySelectorAll('button').forEach((item) => item.classList.toggle('is-selected', item === filter)); await renderTasks(); return; }
  const format = target.closest('[data-format]');
  if (format) {
    if (state.mediaRecorder?.state === 'recording') cancelActiveRecording();
    state.entryType = format.dataset.format;
    state.audioTranscript = null;
    updateEntryTypeUi();
    return;
  }
  const resultView = target.closest('[data-result-view]');
  if (resultView) { state.resultView = resultView.dataset.resultView; await renderDayResult(); return; }
  const themeOption = target.closest('[data-theme-option]');
  if (themeOption) {
    await saveSetting('themeMode', themeOption.dataset.themeOption);
    applyTheme();
    await renderSettings();
  }
});

let tabSwipeStart = null;
document.addEventListener('touchstart', (event) => {
  const tabs = event.target instanceof Element ? event.target.closest('[data-swipe-tabs]') : null;
  if (!tabs || event.touches.length !== 1) return;
  tabSwipeStart = { tabs, x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
document.addEventListener('touchend', (event) => {
  if (!tabSwipeStart) return;
  const touch = event.changedTouches[0];
  const { tabs, x, y } = tabSwipeStart;
  tabSwipeStart = null;
  const horizontal = touch.clientX - x;
  const vertical = Math.abs(touch.clientY - y);
  if (vertical > 42 || Math.abs(horizontal) < 42) return;
  if (tabs.dataset.swipeTabs === 'tasks') {
    const filters = ['active', 'completed', 'all'];
    const current = filters.indexOf(state.taskFilter);
    const next = Math.max(0, Math.min(filters.length - 1, current + (horizontal < 0 ? 1 : -1)));
    if (next === current) return;
    state.taskFilter = filters[next];
    tabs.querySelectorAll('[data-task-filter]').forEach((button) => button.classList.toggle('is-selected', button.dataset.taskFilter === state.taskFilter));
    renderTasks();
  } else if (tabs.dataset.swipeTabs === 'reports') {
    const nextRoute = state.currentRoute === 'reports' ? 'report-sppr' : 'reports';
    showScreen(nextRoute, { updateHistory: true });
  }
}, { passive: true });

document.querySelector('#task-search')?.addEventListener('input', async (event) => { state.taskSearch = event.target.value; await renderTasks(); });
document.querySelector('#report-period-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const fromDate = String(form.get('fromDate') ?? ''); const toDate = String(form.get('toDate') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) {
    showToast('Укажите корректные даты периода.', 'error');
    return;
  }
  state.reportFromDate = fromDate; state.reportToDate = toDate;
  document.querySelector('#report-period-dialog')?.close();
  await renderRoute(state.currentRoute);
});
document.querySelector('#entry-task-search')?.addEventListener('input', renderEntryTaskOptions);
document.querySelector('#entry-task')?.addEventListener('change', (event) => { state.entryTaskSelection = event.target.value; });
document.querySelectorAll('#entry-hours, #entry-minutes').forEach((input) => {
  input.addEventListener('focus', () => requestAnimationFrame(() => input.select()));
  input.addEventListener('click', () => input.select());
});
document.querySelector('#today-date-picker')?.addEventListener('change', async (event) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) return;
  state.selectedDate = event.target.value;
  state.weekStart = startOfWeek(parseLocalDate(state.selectedDate));
  await renderToday();
});

document.querySelector('#task-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const requestedLimit = parseOptionalHoursLimit(event.currentTarget.elements.maxSpprHours.value);
    const task = await taskRepository.save({ id: state.editingTaskId, spprNumber: form.get('spprNumber'), title: form.get('title'), description: form.get('description'), status: form.get('status'), excludeFromSppr: form.get('excludeFromSppr') === 'on', maxSpprMinutes: requestedLimit });
    state.selectedTaskId = task.id; state.editingTaskId = task.id;
    showToast(requestedLimit !== null && task.maxSpprMinutes > requestedLimit ? `Лимит поднят до уже распределённых ${formatMinutes(task.maxSpprMinutes)}.` : 'Задача сохранена');
    await showScreen('task-real', { updateHistory: true });
  } catch (error) { showToast(error.message, 'error'); }
});

document.querySelector('#entry-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const entryForm = event.currentTarget;
  const editingEntryId = state.editingEntryId;
  const entryType = state.entryType;
  const form = new FormData(entryForm);
  const submissionKey = editingEntryId ? null : submissionKeyFor(entryForm);
  // Ignore repeated taps until IndexedDB finishes the current write.
  if (state.isSavingEntry) return;
  state.isSavingEntry = true;
  setEntryFormBusy(true);
  try {
    if (state.mediaRecorder?.state === 'recording') throw new Error('Сначала остановите запись.');
    if (state.audioProcessingPromise) await state.audioProcessingPromise;
    const attachments = entryType === 'voice' && state.recordingBlob
      ? [{ blob: state.recordingBlob, filename: audioFilename(state.recordingBlob), mimeType: state.recordingBlob.type || 'audio/webm', kind: 'voice' }]
      : state.pendingAttachments;
    const existingAudio = editingEntryId ? await workEntryRepository.getAudio(editingEntryId) : null;
    const existingAttachments = editingEntryId ? await workEntryRepository.listAttachments(editingEntryId) : [];
    if (entryType === 'voice' && !state.recordingBlob && !existingAudio) throw new Error('Запишите голосовую заметку.');
    if (entryType === 'file' && !attachments.length && !existingAttachments.length) throw new Error('Выберите хотя бы один файл или сделайте фото.');
    if (editingEntryId) {
      const nextLocalDate = String(form.get('localDate') ?? '');
      const impact = await workEntryRepository.getMoveImpact(editingEntryId, nextLocalDate);
      if (impact.requiresConfirmation) {
        const dates = impact.affectedDates.map((date) => formatDate(date)).join(', ');
        if (!confirm(`Перенос записи сбросит готовое распределение СППР за: ${dates}. Эти дни потребуется завершить повторно.\n\nПродолжить перенос?`)) return;
      }
    }
    await ensureDayForEntry(form.get('localDate'));
    const entry = await workEntryRepository.save({ id: editingEntryId, submissionKey, taskId: form.get('taskId'), localDate: form.get('localDate'), note: form.get('note'), actualMinutes: durationFromForm(form), entryType }, attachments);
    if (state.audioTranscript && entryType === 'voice') {
      await workEntryRepository.saveTranscript(entry.id, state.audioTranscript);
    }
    state.selectedTaskId = entry.taskId; state.selectedDate = entry.localDate; state.editingEntryId = entry.id; showToast('Заметка сохранена'); await showScreen('task-real', { updateHistory: true });
  } catch (error) { showToast(error.message, 'error'); }
  finally {
    state.isSavingEntry = false;
    if (state.currentRoute === 'add-entry') setEntryFormBusy(false);
  }
});

document.querySelector('#sppr-description-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (!state.editingSpprEntryId) throw new Error('Не выбрана запись для изменения описания СППР.');
    const spprDescription = String(new FormData(event.currentTarget).get('spprDescription') ?? '').trim();
    await workEntryRepository.saveSpprDescription(state.editingSpprEntryId, spprDescription);
    state.editingSpprEntryId = null;
    document.querySelector('#sppr-description-dialog')?.close();
    showToast('Описание СППР сохранено');
    await renderTaskDetail();
  } catch (error) { showToast(error.message, 'error'); }
});

document.querySelector('#entry-attachments')?.addEventListener('change', (event) => {
  try {
    addPendingAttachments(event.target.files, 'file');
    event.target.value = '';
  } catch (error) {
    event.target.value = '';
    showToast(error.message, 'error');
  }
});

document.querySelector('#entry-camera-file')?.addEventListener('change', (event) => {
  try {
    addPendingAttachments(event.target.files, 'camera');
    event.target.value = '';
  } catch (error) {
    event.target.value = '';
    showToast(error.message, 'error');
  }
});

document.querySelector('#reminders-enabled')?.addEventListener('change', async (event) => {
  try {
    await saveSetting('remindersEnabled', event.target.checked);
    if (event.target.checked) {
      const workDay = await workDayRepository.get(state.selectedDate);
      if (workDay?.state === 'active' && workDay.startedAt) {
        await notifyDayStart({ announceDayStart: false });
        scheduleReminder();
        showToast(`Напоминания включены. Следующее через ${reminderIntervalLabel(state.settings.reminderInterval)}.`);
      } else {
        await prepareNativeNotifications();
        showToast('Напоминания включены. Они начнутся вместе с рабочим днём.');
      }
    } else {
      clearTimeout(state.reminderTimer); state.reminderTimer = null;
      await clearReminderState({ cancelNative: true });
      showToast('Напоминания выключены');
    }
  } catch (error) {
    await saveSetting('remindersEnabled', false);
    event.target.checked = false;
    await clearReminderState({ cancelNative: true });
    showToast(error.message, 'error');
  }
});

document.querySelector('#reminder-interval')?.addEventListener('change', async (event) => {
  try {
    const value = Number(event.target.value);
    await saveSetting('reminderInterval', value);
    const workDay = await workDayRepository.get(state.selectedDate);
    if (state.settings.remindersEnabled && workDay?.state === 'active' && workDay.startedAt) {
      await notifyDayStart({ announceDayStart: false });
      scheduleReminder();
      showToast(`Интервал сохранён. Следующее напоминание через ${reminderIntervalLabel(value)}.`);
    } else {
      showToast('Интервал сохранён');
    }
  } catch (error) {
    await clearReminderState({ cancelNative: true });
    showToast(`Интервал сохранён, но перепланировать напоминания не удалось: ${error.message}`, 'error');
  }
});

document.querySelector('#daily-target-hours')?.addEventListener('change', async (event) => {
  const hours = Number(event.target.value);
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 || !Number.isInteger(hours * 2)) {
    event.target.value = String(state.settings.dailyTargetMinutes / 60);
    showToast('Норма должна быть от 1 до 24 часов с шагом 30 минут.', 'error');
    return;
  }
  await saveSetting('dailyTargetMinutes', roundToInterval(hours * 60, 30));
  showToast('Норма дня сохранена');
});

document.querySelector('#global-task-limit-enabled')?.addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    const result = await applyGlobalTaskLimit(enabled);
    await renderSettings();
    showToast(enabled
      ? `Общий лимит применён ко всем задачам${result.adjustedCount ? `; для ${result.adjustedCount} лимит сохранён на уровне уже распределённых часов` : ''}.`
      : 'Лимиты сняты со всех задач');
  } catch (error) {
    event.target.checked = state.settings.globalTaskLimitEnabled;
    showToast(error.message, 'error');
  }
});

document.querySelector('#global-task-limit-hours')?.addEventListener('change', async (event) => {
  try {
    const maxMinutes = parseOptionalHoursLimit(event.target.value);
    if (state.settings.globalTaskLimitEnabled) {
      const result = await applyGlobalTaskLimit(true);
      await renderSettings();
      showToast(`Общий лимит обновлён${result.adjustedCount ? `; у ${result.adjustedCount} задач сохранены уже распределённые часы` : ''}.`);
    } else {
      await saveSetting('globalTaskLimitMinutes', maxMinutes);
      showToast('Значение общего лимита сохранено');
    }
  } catch (error) {
    event.target.value = state.settings.globalTaskLimitMinutes === null ? '' : String(state.settings.globalTaskLimitMinutes / 60);
    showToast(error.message, 'error');
  }
});

document.querySelector('#theme-system')?.addEventListener('change', async (event) => {
  await saveSetting('followSystemTheme', event.target.checked);
  applyTheme();
  await renderSettings();
  showToast('Настройка темы сохранена');
});

document.querySelector('#ai-settings-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const baseUrl = String(form.get('baseUrl') ?? '').trim().replace(new RegExp('/+$'), '');
    const model = String(form.get('model') ?? '').trim();
    const transcriptionModel = String(form.get('transcriptionModel') ?? '').trim();
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Адрес API должен начинаться с http:// или https://.');
    }
    if (baseUrl && (!model || !transcriptionModel)) throw new Error('Укажите модели для текста и расшифровки.');
    state.ai.provider = String(form.get('provider') ?? 'openai-compatible');
    state.ai.baseUrl = baseUrl;
    state.ai.model = model;
    state.ai.transcriptionModel = transcriptionModel;
    state.ai.prompts = {
      entry: withRolePrefix(String(form.get('entryPrompt') ?? '').trim() || DEFAULT_PROMPTS.entry),
      day: withRolePrefix(String(form.get('dayPrompt') ?? '').trim() || DEFAULT_PROMPTS.day),
      audio: String(form.get('audioPrompt') ?? '').trim() || DEFAULT_PROMPTS.audio,
      task: withRolePrefix(String(form.get('taskPrompt') ?? '').trim() || DEFAULT_PROMPTS.task),
    };
    state.ai.apiKey = String(form.get('apiKey') ?? '').trim();
    await saveAiConfig();
    await renderAiSettings();
    showToast('Параметры ИИ сохранены');
  } catch (error) {
    showToast(error.message || 'Не удалось сохранить подключение.', 'error');
  }
});

document.querySelector('#backup-file')?.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await restoreBackupFromText(await file.text());
  } catch (error) {
    showToast(error.message || 'Не удалось импортировать резервную копию.', 'error');
  } finally {
    event.target.value = '';
  }
});

window.addEventListener('hashchange', () => showScreen(resolveRoute()));
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.settings.followSystemTheme) applyTheme();
});

try {
  const storedSettings = await settingsRepository.all();
  const storedGlobalTaskLimit = storedSettings.globalTaskLimitMinutes;
  const validGlobalTaskLimit = storedGlobalTaskLimit !== null && storedGlobalTaskLimit !== undefined && Number.isFinite(Number(storedGlobalTaskLimit)) && Number(storedGlobalTaskLimit) >= 0 && Number(storedGlobalTaskLimit) <= 6000000;
  state.settings = {
    remindersEnabled: storedSettings.remindersEnabled === true,
    reminderInterval: [2, 30, 60, 90, 120, 180].includes(Number(storedSettings.reminderInterval)) ? Number(storedSettings.reminderInterval) : 90,
    dailyTargetMinutes: Number(storedSettings.dailyTargetMinutes) >= 60 && Number(storedSettings.dailyTargetMinutes) <= 1440 ? roundToInterval(Number(storedSettings.dailyTargetMinutes), 30) : 480,
    globalTaskLimitEnabled: storedSettings.globalTaskLimitEnabled === true && validGlobalTaskLimit,
    globalTaskLimitMinutes: validGlobalTaskLimit ? roundToInterval(Number(storedGlobalTaskLimit), 30) : null,
    themeMode: ['dark', 'light'].includes(storedSettings.themeMode) ? storedSettings.themeMode : 'dark',
    followSystemTheme: storedSettings.followSystemTheme === true,
  };
  state.reminderNextAt = Number(storedSettings.reminderNextAt) || null;
  const aiConfig = storedSettings.aiConfig && typeof storedSettings.aiConfig === 'object' ? storedSettings.aiConfig : {};
  const useStoredPrompts = aiConfig.promptVersion === DEFAULT_PROMPTS_VERSION;
  const resolveTextPrompt = (kind) => {
    const storedPrompt = typeof aiConfig.prompts?.[kind] === 'string' ? aiConfig.prompts[kind].trim() : '';
    const isLegacyDefault = (LEGACY_DEFAULT_PROMPTS[kind] ?? []).some((prompt) => prompt.trim() === storedPrompt);
    return withRolePrefix(storedPrompt && (useStoredPrompts || !isLegacyDefault) ? storedPrompt : DEFAULT_PROMPTS[kind]);
  };
  state.ai = {
    provider: ['openai-compatible', 'custom'].includes(aiConfig.provider) ? aiConfig.provider : 'openai-compatible',
    baseUrl: typeof aiConfig.baseUrl === 'string' && aiConfig.baseUrl ? aiConfig.baseUrl : DEFAULT_AI_BASE_URL,
    model: typeof aiConfig.model === 'string' && aiConfig.model ? aiConfig.model : DEFAULT_AI_MODEL,
    transcriptionModel: typeof aiConfig.transcriptionModel === 'string' && aiConfig.transcriptionModel ? aiConfig.transcriptionModel : DEFAULT_TRANSCRIPTION_MODEL,
    apiKey: typeof aiConfig.apiKey === 'string' ? aiConfig.apiKey : '',
    prompts: {
      entry: resolveTextPrompt('entry'),
      day: resolveTextPrompt('day'),
      audio: typeof aiConfig.prompts?.audio === 'string' && aiConfig.prompts.audio.trim() ? aiConfig.prompts.audio : DEFAULT_PROMPTS.audio,
      task: resolveTextPrompt('task'),
    },
  };
  if (!useStoredPrompts) await saveAiConfig();
  applyTheme();
  scheduleReminder();
  startReminderCountdown();
  await workDayRepository.normalizeLegacyDrafts();
  const activeDayNormalization = await workDayRepository.normalizeMultipleActiveDays();
  if (activeDayNormalization.normalized) {
    showToast(`Оставлен один активный рабочий день за ${formatDate(activeDayNormalization.keptDate)}.`);
  }
  await workDayRepository.normalizeEmptyFinishedDays();
  await seedInitialData();
  const initialRoute = resolveRoute();
  state.currentRoute = initialRoute;
  state.routeStack = [initialRoute];
  await showScreen(initialRoute);
  await setupNativeHandlers();
  if (!state.settings.remindersEnabled) await cancelNativeReminders();
  else await reconcileNativeReminders();
} catch (error) {
  showToast(`Локальная база недоступна: ${error.message}`, 'error');
}
