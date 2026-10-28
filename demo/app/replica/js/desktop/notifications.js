// js/desktop/notifications.js
// Системные уведомления (tauri-plugin-notification) и звук к ним:
// - персонаж «не успевает» выполнить задание марафона (запас дней < 0) или запас ≤ 1 дня;
// - марафон заканчивается через ≤ 2 дня, а задания не выполнены;
// - ежедневное напоминание о заданиях в выбранный час;
// - постоянные игровые ивенты за выбранное время до начала (Битва Династий, Ритм Гильдии и др.).
//
// Два независимых таймера, потому что требования к точности разные:
// - марафоны и дневная сводка проверяются раз в 30 минут (за день ничего не меняется);
// - ивенты — раз в 30 секунд: напоминание «за 5 минут» при проверке раз в полчаса не сработало бы.
//
// Журнал отправленного лежит в localStorage: по ключу «вид уведомления» на день, поэтому одно
// и то же напоминание не приходит дважды и не дублируется после перезапуска приложения.
//
// Чтобы напоминания не превращались в шум, у каждого вида две отдельные галочки: показывать ли
// всплывающее окно Windows и играть ли звук. Список видов один (`NOTIFY_KINDS`) — и настройки,
// и отправка смотрят на него, поэтому новый вид не остаётся без галочки.
//
// Всё время — московское (js/core/msk.js): у пользователя в другом часовом поясе напоминание
// должно срабатывать по игровым часам, а не по часам компьютера.

import { state } from '../core/state.js';
import { mskDate, mskMinutes, mskParts } from '../core/msk.js';
import { computeCell, marathonPhase } from '../modules/marathons/model.js';
import {
  RECURRING_EVENTS,
  recurringEventsForDate,
  recurringEventScheduleText
} from '../modules/dashboard/recurringEvents.js';
import { entryStatusForDate } from '../modules/dashboard/planner.js';
import { playNotificationSound, soundSettings, soundDiagnostics } from './sound.js';
import { showInApp } from '../core/notifyCenter.js';

const SENT_KEY = 'tf_notifications_sent_v1';
/** Журнал уведомлений об ивентах: ключ «ивент + дата» → дата (чистим по прошествии суток). */
const EVENT_SENT_KEY = 'tf_event_notifications_sent_v1';
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const EVENT_CHECK_INTERVAL_MS = 30 * 1000;

/** Варианты «за сколько предупредить» — подписи и минуты. */
export const LEAD_OPTIONS = [
  { minutes: 5, label: 'за 5 минут' },
  { minutes: 10, label: 'за 10 минут' },
  { minutes: 15, label: 'за 15 минут' },
  { minutes: 30, label: 'за 30 минут' },
  { minutes: 60, label: 'за 1 час' }
];

const DEFAULT_LEAD_MINUTES = 10;

let timer = null;
let eventTimer = null;

const todayStr = () => mskDate();
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);

/**
 * Настройки напоминаний об одном ивенте: включён ли он и за сколько минут предупреждать.
 * Значения приводятся к допустимым, чтобы битый state.json не ломал таймер.
 */
export function eventNotificationSettings(settings, eventId) {
  const raw = settings?.events?.[eventId] || {};
  const minutes = Number(raw.leadMinutes);
  return {
    enabled: raw.enabled !== false,
    leadMinutes: LEAD_OPTIONS.some(o => o.minutes === minutes) ? minutes : DEFAULT_LEAD_MINUTES
  };
}

/**
 * Виды уведомлений: что показывать всплывающим окном Windows и чем озвучивать.
 *
 * Один список на весь проект — настройки (`NOTIFY_KINDS`) и отправка (`notify`) смотрят
 * на него, поэтому новый вид не может остаться без галочки в настройках.
 */
export const NOTIFY_KINDS = [
  { kind: 'behind', title: 'Персонаж не успевает задание марафона', hint: 'Запас дней ушёл в минус' },
  { kind: 'tight', title: 'Запас задания уходит (≤ 1 дня)', hint: 'Ещё можно успеть отметиться' },
  { kind: 'ending', title: 'Марафон заканчивается', hint: 'Осталось ≤ 2 дней, задания не выполнены' },
  { kind: 'daily', title: 'Ежедневная сводка заданий', hint: 'Задания марафонов и дела календаря на сегодня' },
  { kind: 'event', title: 'Игровые ивенты', hint: 'Битва Династий, Ритм Гильдии и другие' },
  { kind: 'task', title: 'Напоминание о начале записи', hint: 'За сколько минут до времени из календаря' },
  { kind: 'launch', title: 'Запуск окон игры завершён', hint: 'Одна строка «Запущено N окон за M»' },
  { kind: 'launchError', title: 'Ошибка запуска окон игры', hint: 'Показывается и когда итог запуска выключен' },
  { kind: 'close', title: 'Окна игры закрыты', hint: 'Одна строка о закрытии окон' }
];

/**
 * Настройки одного вида уведомления: показывать ли всплывающее окно и играть ли звук.
 * Нет записи в настройках — оба включателя работают (вид доступен сразу после обновления).
 * @param {string} kind вид (`NOTIFY_KINDS`)
 * @param {any} [settings] `state.settings`
 */
export function notificationKind(kind, settings) {
  const raw = settings?.kinds?.[kind] || {};
  return {
    popup: raw.popup !== false,
    // Карточка внутри приложения, которая стоит, пока её не закроют
    inapp: raw.inapp !== false,
    sound: raw.sound !== false
  };
}

/**
 * Чистая функция: какие уведомления о марафонах и дневной сводке нужны сейчас.
 *
 * По одному уведомлению на вид, а не на каждый марафон: при трёх марафонах отдельные
 * сообщения сходятся в шум, и пользователь перестаёт их замечать. Список дел — в теле.
 * @returns {Array<{ key: string, title: string, body: string, kind: string }>}
 */
export function collectAlerts(
  st,
  { today = todayStr(), hour = mskParts().hour, settings = st.settings?.notifications || {} } = {}
) {
  const alerts = [];
  const nick = id => st.characters.find(c => c.id === id)?.nick || '?';
  const active = (st.marathons || []).filter(m => m.kind !== 'series' && marathonPhase(m, today) === 'active');
  const behind = [];
  const tight = [];
  const ending = [];
  let openCells = 0;

  active.forEach(m => {
    let unfinished = 0;
    m.participantIds.forEach(cid =>
      m.tasks.forEach(t => {
        const c = computeCell(m, cid, t.id, today);
        if (!c.assigned || c.state === 'done') return;
        unfinished++;
        const task = `${m.title} — ${nick(cid)} — «${t.title}»`;
        if (c.state === 'fail') behind.push(`${task} (не хватает ${-c.reserve} дн.)`);
        else if (c.state === 'warn') tight.push(task);
      })
    );
    openCells += unfinished;
    const left = daysBetween(today, m.endDate);
    if (left >= 0 && left <= 2 && unfinished > 0) {
      ending.push(`${m.title}: ${left === 0 ? 'последний день' : `осталось ${left} дн.`}, невыполненных ${unfinished}`);
    }
  });

  // Дела на день из календаря: дневная сводка — это не только марафоны, иначе про
  // собственные дела человек узнавал, только открыв приложение
  const dayTasks = (st.plannerEntries || []).filter(entry => entry.date === today && entry.status !== 'done');

  const rows = list => list.slice(0, 4).join('\n') + (list.length > 4 ? `\n…и ещё ${list.length - 4}` : '');
  const kind = kind => notificationKind(kind, settings);
  if (kind('behind').popup && behind.length) {
    alerts.push({
      kind: 'behind',
      key: 'behind',
      title: `⚠️ Не успевают задания: ${behind.length}`,
      body: rows(behind)
    });
  }
  if (kind('tight').popup && tight.length) {
    alerts.push({
      kind: 'tight',
      key: 'tight',
      title: `⏳ Запас ≤ 1 дня: ${tight.length}`,
      body: rows(tight)
    });
  }
  if (kind('ending').popup && ending.length) {
    alerts.push({
      kind: 'ending',
      key: 'ending',
      title: `🏁 Марафоны заканчиваются: ${ending.length}`,
      body: rows(ending)
    });
  }
  if (kind('daily').popup && hour >= Number(settings.dailyHour ?? 20) && (openCells > 0 || dayTasks.length > 0)) {
    const parts = [`Идёт марафонов: ${active.length}, невыполненных заданий: ${openCells}.`];
    if (dayTasks.length) parts.push(`Дел на сегодня: ${dayTasks.length}.`);
    alerts.push({
      kind: 'daily',
      key: 'daily',
      title: '📅 Ежедневные задания',
      body: `${parts.join(' ')} Не забудьте отметиться!`
    });
  }
  return alerts;
}

/** «ЧЧ:ММ» → минуты от полуночи. */
function timeMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** «За 5 минут», «За 1 час» — подпись для уведомления. */
export function leadText(minutes) {
  const found = LEAD_OPTIONS.find(o => o.minutes === Number(minutes));
  return found ? found.label : `за ${minutes} мин.`;
}

/**
 * Чистая функция: напоминания о постоянных ивентах, до начала которых осталось не больше
 * выбранного времени. Событие вне окна или уже начавшееся не напоминает.
 *
 * @param {{ today?: string, nowMinutes?: number, settings?: any }} [opts]
 * @returns {Array<{ key: string, title: string, body: string, kind: string, eventId: string }>}
 */
export function collectEventAlerts({ today = todayStr(), nowMinutes = mskMinutes(), settings = {} } = {}) {
  const out = [];
  for (const event of recurringEventsForDate(today)) {
    const conf = eventNotificationSettings(settings, event.recurringId);
    if (!conf.enabled) continue;
    const start = timeMinutes(event.time);
    if (start === null) continue;
    // Окно напоминания: [начало − запас, начало). Ровно в момент начала уже не напоминаем —
    // иначе при перезапуске приложения пришло бы «через минуту после начала».
    if (nowMinutes < start - conf.leadMinutes || nowMinutes >= start) continue;
    const def = RECURRING_EVENTS.find(e => e.id === event.recurringId);
    out.push({
      kind: 'event',
      eventId: event.recurringId,
      key: `event:${event.recurringId}:${today}`,
      title: `🎯 ${event.title}`,
      body: `Начало в ${event.time} (МСК), осталось ${Math.max(0, start - nowMinutes)} мин. ${def ? recurringEventScheduleText(def) : ''}`.trim()
    });
  }
  return out;
}

/**
 * Чистая функция: напоминания о начале записей календаря.
 *
 * Записи, у которых в форме выбрано «Напомнить», присылают сообщение за указанное число
 * минут. Раньше поле `reminderMinutes` собиралось, сохранялось — и ни разу не читалось:
 * человек выбирал «За 15 минут» для кланового ивента, и не приходило ничего.
 *
 * Окно напоминания — [начало − запас, начало). Ровно в момент начала не напоминаем: иначе
 * при перезапуске приложения пришло бы «через минуту после начала».
 *
 * @param {{ today?: string, nowMinutes?: number, entries?: Array<any>, isDone?: (e: any, date: string) => boolean }} [opts]
 * @returns {Array<{ key: string, title: string, body: string, kind: string, entryId: string }>}
 */
export function collectTaskAlerts({ today = todayStr(), nowMinutes = mskMinutes(), entries = [], isDone = null } = {}) {
  const out = [];
  for (const entry of entries || []) {
    const lead = Math.round(Number(entry?.reminderMinutes) || 0);
    if (lead <= 0 || entry?.date !== today) continue;
    const start = timeMinutes(entry.time);
    if (start === null) continue;
    if (isDone?.(entry, today)) continue;
    if (nowMinutes < start - lead || nowMinutes >= start) continue;
    const left = Math.max(0, start - nowMinutes);
    out.push({
      kind: 'task',
      entryId: String(entry.id),
      key: `task:${entry.id}:${today}`,
      title: `⏰ ${entry.title || 'Запись'} — через ${left} мин.`,
      body: `Начало в ${entry.time} (МСК)${left > 1 ? ` · осталось ${left} мин.` : ' · начинается сейчас'}`
    });
  }
  return out;
}

function loadSent(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch (_) {
    return {};
  }
}
function saveSent(key, sent, today) {
  // Храним только сегодняшние записи, чтобы журнал не рос бесконечно
  Object.keys(sent).forEach(k => {
    if (sent[k] !== today) delete sent[k];
  });
  try {
    localStorage.setItem(key, JSON.stringify(sent));
  } catch (_) {
    /* переполнение хранилища не критично */
  }
}

/** Уже отправляли это уведомление сегодня? */
export function alreadySent(key, today = todayStr()) {
  return loadSent(EVENT_SENT_KEY)[key] === today;
}

function api() {
  if (!window.__TAURI_INTERNALS__) return null;
  return import('@tauri-apps/plugin-notification').catch(() => null);
}

/**
 * Доставка уведомления в Windows.
 *
 * Основной путь — своя команда `tf_notify`: она перед показом регистрирует идентификатор
 * приложения в HKCU\Software\Classes\AppUserModelId. Без этой записи Windows не считает
 * приложение источником уведомлений: в установленной версии это делал ярлык установщика,
 * а в сборке для разработки (`cargo run` / `npm run tauri dev`) такой записи нет, и всплывающее
 * сообщение молча пропадало. Если своя команда недоступна, остаётся плагинная доставка.
 *
 * Третий аргумент — вид уведомления (`NOTIFY_KINDS`): он решает, показывать ли всплывающее
 * окно и играть ли звук. Без вида уведомление показывает всё, что может: вид `null` —
 * это вызов из кода, который сам решает, нужно ли сообщение (итог запуска окон, ошибки).
 *
 * @param {string} title
 * @param {string} body
 * @param {string | null} [kind] вид из `NOTIFY_KINDS`
 * @returns {Promise<boolean>} показали ли хоть что-то; `false` — Windows отказала, покажите подпись
 */
export async function notify(title, body, kind = null) {
  const settings = state.settings?.notifications || {};
  const conf = kind
    ? notificationKind(kind, settings)
    : { popup: true, inapp: true, sound: soundSettings(settings).enabled };
  const master = settings.enabled !== false;
  const wantInApp = master && conf.inapp;
  const wantPopup = master && conf.popup;
  const wantSound = master && conf.sound;
  if (!wantInApp && !wantPopup && !wantSound) return true; // вид выключен целиком

  // Карточка в приложении — основной канал: она стоит, пока её не закроют.
  // Окно Windows остаётся как дополнение для случая, когда приложение свёрнуто.
  if (wantInApp) showInApp({ title, body, kind: kind || 'info', once: true });

  let delivered = wantInApp;
  if (wantPopup) {
    delivered = (await send(title, body)) || delivered;
  }
  if (wantSound) {
    // Звук не влияет на итог: уведомление уже показано, а отсутствие звука — это настройка
    // или запрет движка (js/desktop/sound.js), в обоих случаях показывать всё равно надо.
    await playNotificationSound(kind || 'calm', settings);
  }
  return delivered;
}

async function send(title, body) {
  if (!window.__TAURI_INTERNALS__) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('tf_notify', { title, body });
    return true;
  } catch (e) {
    console.warn('[NOTIFY] tf_notify недоступна, пробуем плагин:', e);
  }
  const n = await api();
  if (!n) return false;
  if (!(await ensurePermission())) return false;
  n.sendNotification({ title, body });
  return true;
}

export async function ensurePermission() {
  const n = await api();
  if (!n) return false;
  if (await n.isPermissionGranted()) return true;
  return (await n.requestPermission()) === 'granted';
}

/** Проверить и отправить новые уведомления о марафонах (каждое — не чаще раза в день). */
export async function runReminderCheck({ force = false } = {}) {
  if (state.settings?.notifications?.enabled === false && !force) return [];
  const sent = loadSent(SENT_KEY);
  const today = todayStr();
  const fresh = collectAlerts(state).filter(a => force || sent[a.key] !== today);
  for (const a of fresh) {
    // `delivered` нужен кнопке «Проверить сейчас»: иначе она рапортует об отправке,
    // когда Windows уведомление отбросила, и причина остаётся невидимой
    a.delivered = await notify(a.title, a.body, a.kind);
    if (a.delivered) sent[a.key] = today;
  }
  saveSent(SENT_KEY, sent, today);
  return fresh;
}

/**
 * Проверка напоминаний об ивентах. Вызывается раз в 30 секунд, поэтому отдельный журнал
 * по ключу «ивент + дата»: без него одно напоминание приходило бы на каждой проверке.
 */
export async function runEventCheck({ force = false, now = new Date() } = {}) {
  if (state.settings?.notifications?.enabled === false && !force) return [];
  const today = mskDate(now);
  const sent = loadSent(EVENT_SENT_KEY);
  const settings = state.settings?.notifications;
  const alerts = [
    ...collectEventAlerts({ today, nowMinutes: mskMinutes(now), settings }),
    // Напоминания о начале записей календаря идут тем же таймером и тем же журналом:
    // отдельный таймер означал бы ещё один 30-секундный опрос без причины
    ...collectTaskAlerts({
      today,
      nowMinutes: mskMinutes(now),
      entries: state.plannerEntries || [],
      isDone: (entry, date) => entryStatusForDate(entry, date) === 'done'
    })
  ];
  const fresh = alerts.filter(a => force || sent[a.key] !== today);
  for (const a of fresh) {
    a.delivered = await notify(a.title, a.body, a.kind);
    if (a.delivered) sent[a.key] = today;
  }
  saveSent(EVENT_SENT_KEY, sent, today);
  return fresh;
}

/**
 * Диагностика для кнопки «Проверить сейчас»: почему уведомления могут не приходить.
 * Возвращает человекочитаемые причины, а не молчаливый отказ.
 */
export async function notificationDiagnostics() {
  const out = {
    tauri: !!window.__TAURI_INTERNALS__,
    permission: 'unknown',
    sound: soundDiagnostics(),
    reasons: /** @type {string[]} */ ([])
  };
  if (!out.tauri) {
    out.reasons.push(
      'Приложение открыто в браузере (Vite): системные уведомления Windows в этом режиме не работают — нужна установленная версия или `npm run tauri dev`.'
    );
    return out;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // Команда возвращает причину отказа или `null`, если показывать можно
    const reason = await invoke('tf_notify_check');
    out.permission = reason ? 'denied' : 'granted';
    if (reason) out.reasons.push(String(reason));
  } catch (e) {
    out.permission = 'unknown';
    out.reasons.push(`Проверка уведомлений недоступна: ${e}`);
  }
  if (state.settings?.notifications?.enabled === false) {
    out.reasons.push('Системные уведомления выключены в настройках (раздел «Уведомления»).');
  }
  // Про звук говорим отдельно: всплывающие при этом работают, и путать причины нельзя
  if (soundSettings(state.settings?.notifications).enabled && out.sound.reason) {
    out.reasons.push(out.sound.reason);
  }
  return out;
}

/**
 * Полная проверка «здесь и сейчас»: марафоны, ивенты и состояние системы уведомлений.
 * Возвращает итог для подписи в интерфейсе: сколько напоминаний актуально и сколько дошло.
 */
export async function runNotificationTest() {
  const diag = await notificationDiagnostics();
  const marathon = await runReminderCheck({ force: true });
  const events = await runEventCheck({ force: true });
  const all = [...marathon, ...events];
  // Отчёт считает именно показ в приложении: карточка остаётся на экране, и человек видит
  // результат проверки, а не ищет его в области уведомлений Windows, куда он уже ушёл
  const shown = all.filter(a => a.delivered).length;
  return {
    sent: all.length,
    delivered: shown,
    // Показаны только звуком: всплывающее окно для этого вида выключено
    soundOnly: all.filter(a => a.delivered && !notificationKind(a.kind, state.settings?.notifications).popup).length,
    marathon: marathon.length,
    events: events.length,
    diagnostics: diag
  };
}

export function initNotifications() {
  if (timer) clearInterval(timer);
  if (eventTimer) clearInterval(eventTimer);
  setTimeout(() => runReminderCheck().catch(e => console.warn('[NOTIFY]', e)), 15000);
  timer = setInterval(() => runReminderCheck().catch(e => console.warn('[NOTIFY]', e)), CHECK_INTERVAL_MS);
  // Ивенты: первый проход сразу после запуска — приложение могли открыть прямо перед началом ивента
  setTimeout(() => runEventCheck().catch(e => console.warn('[NOTIFY]', e)), 5000);
  eventTimer = setInterval(() => runEventCheck().catch(e => console.warn('[NOTIFY]', e)), EVENT_CHECK_INTERVAL_MS);
}
