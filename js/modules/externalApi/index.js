// @ts-check
// js/modules/externalApi/index.js
// Включение и выключение сервера внешнего API по настройкам.
//
// Правило: сервер запускается только в приложении (в браузере слушать порт нечем)
// и только по настройке `externalApi.enabled`. Тестовые сборки тоже запускают API —
// иначе контракт нельзя проверить на живой сборке; от случайного конфликта с
// рабочей копией защищает порт профиля (`DEFAULT_ACCEPTANCE_PORT`, подставляет Rust).
//
// Токен берётся из хранилища ОС (`token.js`): если его нет, создаётся новый и
// сохраняется там же. В `state.json` остаётся только отметка `tokenCreatedAt`.
// Сервер перезапускается при смене порта, токена или прав — Rust сравнивает
// параметры сам, поэтому достаточно звать `external_api_start` на каждое изменение.

import { state } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { ensureToken, forgetToken } from './token.js';

/**
 * Порт по умолчанию. В тестовых профилях Rust подставляет свой (`47832`), если
 * пришло ровно это значение: так две сборки не делят адрес, а явно выбранный
 * пользователем порт остаётся как есть.
 */
const DEFAULT_PORT = 47831;

/** Слушает ли мост события — повторные вызовы не должны подписываться дважды. */
let bridge = null;
let startedKey = null;

async function invoke(cmd, args) {
  const api = await import('@tauri-apps/api/core');
  return api.invoke(cmd, args);
}

/** Параметры, при изменении которых сервер нужно перезапустить. */
function settingsKey(settings, token) {
  return JSON.stringify({
    enabled: !!settings.enabled,
    port: Number(settings.port) || 0,
    token,
    scopes: {
      read: settings.allowRead !== false,
      modify: !!settings.allowModify,
      launchClose: !!settings.allowLaunchClose
    }
  });
}

/**
 * Перерисовка разделов после изменения через API.
 *
 * Без неё данные сохранялись бы, а список на экране показывал бы старое: человек
 * отметил задачу во внешней программе и не увидел отметки в приложении. Модули
 * подключаются динамически — иначе мост тянул бы за собой весь интерфейс.
 */
function renderers() {
  // Ошибку перерисовки глотаем: список на экране не обновится, но данные уже записаны,
  // а падать из-за этого нельзя — ответ API должен уйти клиенту.
  const safe = fn => () => {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* перерисовка не удалась — данные уже сохранены */
    }
  };
  return {
    renderCharacters: safe(() => import('../characters/list.js').then(m => m.renderCharacters())),
    renderParties: safe(() => import('../parties/index.js').then(m => m.renderParties())),
    renderMarathons: safe(() => import('../marathons/page.js').then(m => m.renderMarathons())),
    renderFinance: safe(() => import('../finance/page.js').then(m => m.renderFinance())),
    // Планировщик живёт на странице «Сегодня»: её рисует renderToday, а кнопки
    // действий получают тот же runTodayAction, что и в самом приложении.
    renderPlanner: safe(async () => {
      const [{ renderToday }, { runTodayAction }] = await Promise.all([
        import('../dashboard/todayView.js'),
        import('../characters/list.js')
      ]);
      renderToday(document.getElementById('today-root'), { run: runTodayAction });
    })
  };
}

/** Подключить мост один раз: событие `external-api-request` → ответ JS. */
async function ensureBridge() {
  if (bridge) return bridge;
  const { bindExternalApiBridge } = await import('./bridge.js');
  bridge = await bindExternalApiBridge(renderers());
  return bridge;
}

/**
 * Привести сервер в соответствие с настройками. Вызывается при старте приложения
 * и после каждого сохранения настроек.
 * @returns {Promise<{ ok: boolean, error?: string, status?: any }>}
 */
export async function syncExternalApi() {
  const settings = state.settings?.externalApi || {};
  if (!isTauri()) return { ok: false, error: 'Внешний API работает только в приложении' };
  if (!settings.enabled) {
    try {
      await invoke('external_api_stop');
    } catch (error) {
      console.warn('[EXTERNAL API] Не удалось остановить сервер', error);
    }
    startedKey = null;
    return { ok: true, status: { running: false } };
  }
  try {
    await ensureBridge();
    const { token } = await ensureToken();
    // Первый запуск мог создать токен — отметка времени нужна вкладке настроек.
    if (!state.settings.externalApi.tokenCreatedAt) {
      state.settings.externalApi.tokenCreatedAt = new Date().toISOString();
      await persist().catch(() => {});
    }
    const key = settingsKey(settings, token);
    if (key === startedKey) {
      // Параметры не менялись: сервер уже с ними — только сообщаем, что JS готов.
      await invoke('external_api_client_ready').catch(() => {});
      return { ok: true, status: await invoke('external_api_status').catch(() => null) };
    }
    const status = await invoke('external_api_start', {
      options: {
        // Умолчание стабильной сборки в тестовых профилях заменяется на порт
        // профиля в Rust (`port_for_profile`): две сборки могут работать
        // одновременно, и «порт занят» у второй — плохой ответ.
        port: Number(settings.port) || DEFAULT_PORT,
        token,
        scopes: {
          read: settings.allowRead !== false,
          modify: !!settings.allowModify,
          launchClose: !!settings.allowLaunchClose
        }
      }
    });
    startedKey = key;
    // Мост уже подписан; повторное «готово» нужно после перезапуска сервера.
    await invoke('external_api_client_ready').catch(() => {});
    return { ok: true, status };
  } catch (error) {
    startedKey = null;
    return { ok: false, error: String(error?.message || error || 'Не удалось запустить сервер') };
  }
}

/**
 * Перевыпустить токен: новый сохраняется в хранилище ОС, старый забывается.
 * Сервер перезапускается — старые клиенты получают `401`, это и есть смысл.
 * @returns {Promise<{ ok: boolean, token?: string, error?: string }>}
 */
export async function rotateToken() {
  const { newToken, writeToken } = await import('./token.js');
  const token = newToken();
  try {
    await writeToken(token);
    state.settings.externalApi.tokenCreatedAt = new Date().toISOString();
    await persist().catch(() => {});
    startedKey = null;
    // Сам по себе перевыпуск токена сервер не запускает: если API выключен,
    // новый токен просто сохраняется до включения.
    const result = state.settings?.externalApi?.enabled ? await syncExternalApi() : { ok: true };
    return { ok: result.ok, token, error: result.error };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Не удалось сохранить токен') };
  }
}

/**
 * Текущий токен — чтобы скопировать его в скрипт, не перевыпуская.
 *
 * Значение читается из хранилища ОС. Если сервер включён, а токена там нет
 * (например, запись удалили вручную), токен создаётся — ровно как при запуске
 * сервера, и об этом говорится в ответе (`created: true`): так кнопка не оставляет
 * пользователя с «пусто» без объяснения.
 * @returns {Promise<{ ok: boolean, token?: string, created?: boolean, error?: string }>}
 */
export async function currentToken() {
  const { peekToken } = await import('./token.js');
  const found = await peekToken();
  if (found.ok) return { ok: true, token: found.token, created: false };
  if (!found.absent || !state.settings?.externalApi?.enabled) return { ok: false, error: found.error };
  try {
    const issued = await ensureToken();
    state.settings.externalApi.tokenCreatedAt = new Date().toISOString();
    await persist().catch(() => {});
    return { ok: true, token: issued.token, created: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Не удалось прочитать токен') };
  }
}

/** Удалить токен и остановить сервер: следующий запуск создаст новый. */
export async function resetToken() {
  try {
    await forgetToken();
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Не удалось удалить токен') };
  }
  state.settings.externalApi.tokenCreatedAt = null;
  await persist().catch(() => {});
  startedKey = null;
  return syncExternalApi();
}

/** Текущий статус сервера для вкладки настроек. */
export async function apiStatus() {
  if (!isTauri()) return { running: false, error: 'Не в приложении' };
  try {
    return await invoke('external_api_status');
  } catch (error) {
    return { running: false, error: String(error?.message || error) };
  }
}

/** Журнал вызовов (последние 100 без тел и токенов). */
export async function apiAudit() {
  if (!isTauri()) return [];
  try {
    return await invoke('external_api_audit');
  } catch {
    return [];
  }
}

/** Очистить журнал вызовов. */
export async function clearAudit() {
  if (!isTauri()) return;
  await invoke('external_api_clear_audit').catch(() => {});
}

/** Подписка на изменения настроек: сервер должен следовать за галочками сразу. */
export function attachExternalApi() {
  if (!isTauri()) return;
  // Приложение стартует асинхронно: первый вызов — после загрузки состояния.
  syncExternalApi().catch(error => console.warn('[EXTERNAL API]', error));
  let pending = null;
  window.addEventListener('tf-persisted', () => {
    // Настройки могут сохраняться пачкой: не перезапускаем сервер на каждую запись.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      syncExternalApi().catch(error => console.warn('[EXTERNAL API]', error));
    }, 300);
  });
}

/** Для тестов: сбросить запомненные параметры запуска. */
export function __resetExternalApi() {
  bridge = null;
  startedKey = null;
}
