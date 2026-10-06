// js/desktop/notifications.js
// Системные уведомления (tauri-plugin-notification):
// - персонаж «не успевает» выполнить задание марафона (запас дней < 0) или запас ≤ 1 дня;
// - марафон заканчивается через ≤ 2 дня, а задания не выполнены;
// - ежедневное напоминание о заданиях в выбранный час;
// - постоянные игровые ивенты за выбранное время до начала (Битва Династий, Ритм Гильдии и др.).
//
// Два независимых таймера, потому что требования к точности разные:
// - марафоны и дневная сводка проверяются раз в 30 минут (за день ничего не меняется);
// - ивенты — раз в 30 секунд: напоминание «за 5 минут» при проверке раз в полчаса не сработало бы.
//
// Журнал отправленного лежит в localStorage: марафоны — по ключу на день, ивенты — по ключу
// «ивент + дата», поэтому одно и то же напоминание не приходит дважды и не дублируется после
// перезапуска приложения.
//
// Всё время — московское (js/core/msk.js): у пользователя в другом часовом поясе напоминание
// должно срабатывать по игровым часам, а не по часам компьютера.

import { state } from '../core/state.js';
import { mskDate, mskMinutes, mskParts } from '../core/msk.js';
import { computeCell, marathonPhase } from '../modules/marathons/model.js';
import { RECURRING_EVENTS, recurringEventsForDate, recurringEventScheduleText } from '../modules/dashboard/recurringEvents.js';

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
 * Чистая функция: какие уведомления о марафонах и дневной сводке нужны сейчас.
 * @returns {Array<{ key: string, title: string, body: string, kind: string }>}
 */
export function collectAlerts(st, { today = todayStr(), hour = mskParts().hour, settings = st.settings?.notifications || {} } = {}) {
  const alerts = [];
  const nick = (id) => st.characters.find(c => c.id === id)?.nick || '?';
  const active = (st.marathons || []).filter(m => m.kind !== 'series' && marathonPhase(m, today) === 'active');
  let openCells = 0;

  active.forEach(m => {
    const behind = [];
    const tight = [];
    let unfinished = 0;
    m.participantIds.forEach(cid => m.tasks.forEach(t => {
      const c = computeCell(m, cid, t.id, today);
      if (!c.assigned || c.state === 'done') return;
      unfinished++;
      if (c.state === 'fail') behind.push(`${nick(cid)} — «${t.title}» (не хватает ${-c.reserve} дн.)`);
      else if (c.state === 'warn') tight.push(`${nick(cid)} — «${t.title}»`);
    }));
    openCells += unfinished;

    if (settings.marathonBehind !== false && behind.length) {
      alerts.push({
        kind: 'behind', key: `behind:${m.id}`,
        title: `⚠️ ${m.title}: не успевают ${behind.length}`,
        body: behind.slice(0, 4).join('\n') + (behind.length > 4 ? `\n…и ещё ${behind.length - 4}` : '')
      });
    }
    if (settings.marathonBehind !== false && tight.length) {
      alerts.push({
        kind: 'tight', key: `tight:${m.id}`,
        title: `⏳ ${m.title}: запас ≤ 1 дня у ${tight.length}`,
        body: tight.slice(0, 4).join('\n') + (tight.length > 4 ? `\n…и ещё ${tight.length - 4}` : '')
      });
    }
    const left = daysBetween(today, m.endDate);
    if (settings.marathonEnding !== false && left >= 0 && left <= 2 && unfinished > 0) {
      alerts.push({
        kind: 'ending', key: `ending:${m.id}`,
        title: `🏁 ${m.title}: ${left === 0 ? 'последний день' : `осталось ${left} дн.`}`,
        body: `Не выполнено заданий: ${unfinished}`
      });
    }
  });

  if (settings.dailyReminder !== false && hour >= Number(settings.dailyHour ?? 20) && openCells > 0) {
    alerts.push({
      kind: 'daily', key: 'daily',
      title: '📅 Ежедневные задания',
      body: `Идёт марафонов: ${active.length}, невыполненных заданий: ${openCells}. Не забудьте отметиться!`
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

function loadSent(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) { return {}; }
}
function saveSent(key, sent, today) {
  // Храним только сегодняшние записи, чтобы журнал не рос бесконечно
  Object.keys(sent).forEach(k => { if (sent[k] !== today) delete sent[k]; });
  try { localStorage.setItem(key, JSON.stringify(sent)); } catch (_) { /* переполнение хранилища не критично */ }
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
 */
export async function notify(title, body) {
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
    a.delivered = await notify(a.title, a.body);
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
  const fresh = collectEventAlerts({ today, nowMinutes: mskMinutes(now), settings: state.settings?.notifications })
    .filter(a => force || sent[a.key] !== today);
  for (const a of fresh) {
    a.delivered = await notify(a.title, a.body);
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
  const out = { tauri: !!window.__TAURI_INTERNALS__, permission: 'unknown', reasons: /** @type {string[]} */ ([]) };
  if (!out.tauri) {
    out.reasons.push('Приложение открыто в браузере (Vite): системные уведомления Windows в этом режиме не работают — нужна установленная версия или `npm run tauri dev`.');
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
  return {
    sent: all.length,
    delivered: all.filter(a => a.delivered).length,
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
