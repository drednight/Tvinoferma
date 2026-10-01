// js/notifications.js
// Системные уведомления (tauri-plugin-notification):
// - персонаж «не успевает» выполнить задание марафона (запас дней < 0) или запас ≤ 1 дня;
// - марафон заканчивается через ≤ 2 дня, а задания не выполнены;
// - ежедневное напоминание о заданиях в выбранный час.
// Каждое уведомление отправляется не чаще раза в день (журнал в localStorage).

import { state } from './state.js';
import { computeCell, marathonPhase } from './marathons/model.js';

const SENT_KEY = 'tf_notifications_sent_v1';
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
let timer = null;

const todayStr = () => new Date().toLocaleDateString('sv');
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

/**
 * Чистая функция: какие уведомления нужны сейчас.
 * @returns {Array<{ key: string, title: string, body: string, kind: string }>}
 */
export function collectAlerts(st, { today = todayStr(), hour = new Date().getHours(), settings = st.settings?.notifications || {} } = {}) {
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

function loadSent() {
  try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch (_) { return {}; }
}
function saveSent(sent) {
  const today = todayStr();
  Object.keys(sent).forEach(k => { if (sent[k] !== today) delete sent[k]; }); // храним только сегодняшние
  localStorage.setItem(SENT_KEY, JSON.stringify(sent));
}

async function api() {
  if (!window.__TAURI_INTERNALS__) return null;
  return await import('@tauri-apps/plugin-notification');
}

export async function ensurePermission() {
  const n = await api();
  if (!n) return false;
  if (await n.isPermissionGranted()) return true;
  return (await n.requestPermission()) === 'granted';
}

export async function notify(title, body) {
  const n = await api();
  if (!n || !(await ensurePermission())) return false;
  n.sendNotification({ title, body });
  return true;
}

/** Проверить и отправить новые уведомления (каждое — не чаще раза в день). */
export async function runReminderCheck({ force = false } = {}) {
  if (state.settings?.notifications?.enabled === false && !force) return [];
  const sent = loadSent();
  const today = todayStr();
  const fresh = collectAlerts(state).filter(a => force || sent[a.key] !== today);
  for (const a of fresh) {
    if (await notify(a.title, a.body)) sent[a.key] = today;
  }
  saveSent(sent);
  return fresh;
}

export function initNotifications() {
  if (timer) clearInterval(timer);
  setTimeout(() => runReminderCheck().catch(e => console.warn('[NOTIFY]', e)), 15000);
  timer = setInterval(() => runReminderCheck().catch(e => console.warn('[NOTIFY]', e)), CHECK_INTERVAL_MS);
}
