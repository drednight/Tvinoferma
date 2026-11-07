import { backgroundTask } from '../../core/backgroundTask.js';
import { refreshSiteFeed } from '../dashboard/siteFeed.js';
// js/modules/servers/serverStatus.js
// «Статус серверов» pwonline.ru (Issue #26): общий источник для плашки в шапке и окна передачи предметов.
// Страница /server_status.php открыта всем, поэтому аккаунты не нужны: читает служебное окно приложения (команда `read_server_status`).
// Последнее чтение хранится локально (transferStore), обновляется при запуске приложения и по расписанию из
// «Настройки → Свежесть данных → Статус серверов». Только чтение: ничего на сайте не нажимается.

import { loadStatus, saveStatus } from '../automation/transferStore.js';
import { readServerStatus } from '../automation/transferRunner.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';

let current = loadStatus();
let inflight = null;
let lastError = null; // { status, error } последней неудачи; сбрасывается успешным чтением
let lastAttemptAt = 0;
const listeners = new Set();

const notify = () =>
  listeners.forEach(fn => {
    try {
      fn(getServerStatus());
    } catch (e) {
      console.warn('[SERVERS]', e);
    }
  });

/** Текущее состояние: последние данные (или null), идёт ли чтение, последняя ошибка. */
export function getServerStatus() {
  return { status: current, busy: !!inflight, error: lastError };
}

/** Подписка на любые изменения (данные, начало/конец чтения). Возвращает функцию отписки. */
export function onServerStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Перечитать из хранилища (после изменений в других местах и в тестах). */
export function reloadServerStatus() {
  current = loadStatus();
  notify();
}

/** Через сколько минут перечитывать список серверов: 0 — только при запуске. Мусор в настройках → значение по умолчанию. */
export function serverStatusMinutes(settings) {
  const v = Number(settings?.freshness?.serverStatusMinutes);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : DEFAULT_SETTINGS.freshness.serverStatusMinutes;
}

/** Пора ли перечитывать: данных нет или прошло больше `minutes` (последняя попытка тоже считается, чтобы не долбить сайт при сбоях). */
export function isStatusDue(status, minutes, now = Date.now(), attemptAt = 0) {
  if (!(minutes > 0)) return false;
  const limit = minutes * 60000;
  const at = status?.at ? new Date(status.at).getTime() : NaN;
  if (Number.isFinite(at) && now - at < limit) return false;
  return !(attemptAt && now - attemptAt < limit);
}

/**
 * Прочитать «Статус серверов». Одновременно идёт одно чтение: повторный вызов получает тот же ответ.
 * @param {{ invokeFn: Function, signal?: { cancelled: boolean }, retries?: number, retryDelayMs?: number }} opts
 * @returns {Promise<{ status: string, error?: string|null, servers?: object[] }>}
 */
export function refreshServerStatus(opts) {
  if (inflight) return inflight;
  const journal = backgroundTask('Проверка серверов');
  lastAttemptAt = Date.now();
  // Do not block the public server read on the clan site or its response queue.
  if (globalThis.window?.__TAURI_INTERNALS__)
    void import('../guild/page.js').then(({ autoSync }) => autoSync()).catch(error => console.warn('[GUILD]', error));
  inflight = (async () => {
    try {
      const res = await readServerStatus(opts);
      if (res.status === 'ok') {
        current = saveStatus(res);
        lastError = null;
      } else if (res.status !== 'cancelled') lastError = { status: res.status, error: res.error || null };
      journal.finish(
        res.status === 'ok' ? 'Статус серверов обновлён.' : 'Проверка серверов не завершена.',
        res.status === 'ok' ? 'done' : 'warn'
      );
      return res;
    } catch (error) {
      journal.finish('Не удалось проверить серверы.', 'error');
      throw error;
    } finally {
      inflight = null;
      notify();
    }
  })();
  notify();
  return inflight;
}

/** Ручная запись уже прочитанного (если список пришёл не отсюда). */
export function setServerStatus(data) {
  current = saveStatus(data);
  lastError = null;
  notify();
  return current;
}

async function backgroundPromos(getSettings) {
  if (!window.__TAURI_INTERNALS__) return;
  const promoMinutes = Number(getSettings()?.freshness?.promoMinutes ?? 60);
  if (promoMinutes > 0) {
    const { promoDiscovery } = await import('../automation/promoDiscovery.js');
    await promoDiscovery().check({ maxAgeMs: Math.max(10, promoMinutes) * 60000 });
  }
}
async function backgroundRead(getSettings) {
  if (!window.__TAURI_INTERNALS__) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const s = getSettings()?.scripts || {};
  // Independent reads start together; failed news never blocks server/auth startup.
  void refreshSiteFeed({ invokeFn: invoke });
  void backgroundPromos(getSettings).catch(() => {});
  return refreshServerStatus({
    invokeFn: invoke,
    retries: Math.min(2, Math.max(0, Number(s.retries) || 0)),
    retryDelayMs: 2000
  });
}

/**
 * При запуске: читает список серверов и ждёт не дольше `maxWaitMs`, чтобы дальше (проверка входа персонажей)
 * не зависеть от сайта. Чтение при этом не прерывается.
 */
export async function loadServerStatusOnStartup(getSettings, maxWaitMs = 25000) {
  let timer;
  const limit = new Promise(resolve => {
    timer = setTimeout(resolve, maxWaitMs);
  });
  try {
    await Promise.race([backgroundRead(getSettings).catch(e => console.warn('[SERVERS] startup', e)), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Фоновое расписание: каждые полминуты проверяет, не пора ли перечитать (интервал берётся из настроек «на лету»). */
export function startServerStatusScheduler(getSettings, tickMs = 30000) {
  const tick = () => {
    void backgroundPromos(getSettings).catch(() => {});
    if (inflight) return;
    if (isStatusDue(current, serverStatusMinutes(getSettings()), Date.now(), lastAttemptAt)) {
      backgroundRead(getSettings).catch(e => console.warn('[SERVERS] schedule', e));
    }
  };
  const id = setInterval(tick, tickMs);
  return () => clearInterval(id);
}
