// @ts-check
// js/settings/externalApiPanel.js
// Вкладка «Настройки → 🔌 Внешний API»: статус сервера, токен, права, журнал.
//
// Значения галочек и порта сохраняет общий код настроек (`data-setting` в
// settings.js): здесь только то, что не выражается одной галочкой — статус,
// кнопки токена, ссылка на страницу и журнал. Поэтому вкладка не дублирует
// сохранение настроек и не может «забыть» вызвать persist().

import { state } from '../core/state.js';
import { isTauri } from '../core/storage.js';
import { toast } from '../core/ui.js';
import {
  apiStatus,
  apiAudit,
  clearAudit,
  rotateToken,
  resetToken,
  syncExternalApi
} from '../modules/externalApi/index.js';

const PORT_DEFAULT = 47831;

/** Строка статуса сервера. */
export function statusText(status, { tauri = true } = {}) {
  if (!tauri) return 'Внешний API работает только в приложении, а не в браузере.';
  if (!status?.running) {
    return status?.error ? `Сервер остановлен: ${status.error}` : 'Сервер остановлен: включите переключатель выше.';
  }
  const port = Number(status.port) || PORT_DEFAULT;
  const scopes = status.scopes || {};
  const names = [
    scopes.read ? 'чтение' : null,
    scopes.modify ? 'изменение' : null,
    scopes.launchClose ? 'запуск и закрытие' : null
  ].filter(Boolean);
  const ready = status.clientReady === false ? ' Окно ещё подключается: запросы временно получают 503.' : '';
  return `✅ Сервер работает на http://127.0.0.1:${port} · права: ${names.length ? names.join(', ') : 'нет'}.${ready}`;
}

/** Строка про токен: создан ли и когда. Сам токен здесь не появляется никогда. */
export function tokenText(settings, status) {
  const created = settings?.tokenCreatedAt;
  if (!created) return 'Токен ещё не создан: он появится при включении сервера.';
  const at = new Date(created);
  const when = Number.isNaN(at.getTime()) ? '' : ` (создан ${at.toLocaleString('ru-RU')})`;
  return `Токен хранится в хранилище учётных данных ОС${when}. Повторно показать его нельзя — только перевыпустить.`;
}

/** Строки журнала: время, метод, путь, код, длительность. Без тел запросов. */
export function auditLines(entries) {
  if (!Array.isArray(entries) || !entries.length) return ['Журнал пуст.'];
  return entries
    .slice()
    .reverse()
    .map(entry => {
      const at = new Date(Number(entry.atMs) || 0);
      const time = Number.isNaN(at.getTime()) ? '—' : at.toLocaleTimeString('ru-RU', { hour12: false });
      return `${time}  ${entry.method}  ${entry.path}  → ${entry.status}  (${Number(entry.ms) || 0} мс)`;
    });
}

/** Страница API: адрес для браузера и пример `curl` с токеном в переменной окружения. */
export function curlExample(port = PORT_DEFAULT) {
  const base = `http://127.0.0.1:${Number(port) || PORT_DEFAULT}/api/v1`;
  return `curl -s -H "Authorization: Bearer $TF_API_TOKEN" ${base}/health`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function renderPanel() {
  const statusEl = document.getElementById('external-api-status');
  const tokenEl = document.getElementById('external-api-token-status');
  const settings = state.settings?.externalApi || {};
  // Статус приходит асинхронно: сначала «проверяю», затем реальный.
  if (statusEl) statusEl.textContent = isTauri() ? 'Проверяю сервер…' : statusText(null, { tauri: false });
  if (tokenEl) tokenEl.textContent = tokenText(settings, null);
  apiStatus().then(status => {
    if (statusEl) statusEl.textContent = statusText(status, { tauri: isTauri() });
    if (tokenEl) tokenEl.textContent = tokenText(settings, status);
  });
  refreshAudit();
}

async function refreshAudit() {
  const box = document.getElementById('external-api-audit');
  if (!box) return;
  const entries = await apiAudit();
  box.textContent = auditLines(entries).join('\n');
}

/**
 * Привязать вкладку. Вызывается один раз при первой привязке настроек;
 * повторные вызовы ничего не делают.
 */
export function bindExternalApiPanel() {
  const panel = document.getElementById('settings-external-api');
  if (!panel || panel.dataset.bound) return;
  panel.dataset.bound = 'true';
  renderPanel();

  // Переключатель «разрешить» и смена порта сразу поднимают или гасят сервер:
  // ждать сохранения всей формы незачем, ошибка запуска должна быть видна сразу.
  panel.addEventListener('change', event => {
    const target = /** @type {HTMLInputElement} */ (event.target);
    const path = target?.dataset?.setting;
    if (!path || !path.startsWith('externalApi.')) return;
    // Общий обработчик настроек сохраняет значение сам; здесь — реакция сервера.
    setTimeout(() => {
      syncExternalApi()
        .then(result => {
          if (!result.ok && result.error) toast(result.error, 'error');
          renderPanel();
        })
        .catch(error => console.warn('[EXTERNAL API]', error));
    }, 0);
  });

  document.getElementById('external-api-open')?.addEventListener('click', async () => {
    const port = Number(state.settings?.externalApi?.port) || PORT_DEFAULT;
    const url = `http://127.0.0.1:${port}/`;
    try {
      if (/** @type {any} */ (window).__TAURI_INTERNALS__) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      toast(`Не удалось открыть страницу: ${String(error?.message || error)}`, 'error');
    }
  });

  document.getElementById('external-api-copy-curl')?.addEventListener('click', async () => {
    const port = Number(state.settings?.externalApi?.port) || PORT_DEFAULT;
    const ok = await copyText(curlExample(port));
    toast(ok ? 'Пример curl скопирован.' : 'Браузер не разрешил копирование.', ok ? 'success' : 'error');
  });

  document.getElementById('external-api-rotate')?.addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('external-api-rotate'));
    if (button) button.disabled = true;
    try {
      const result = await rotateToken();
      if (!result.ok || !result.token) {
        toast(result.error || 'Не удалось перевыпустить токен', 'error');
        return;
      }
      const reveal = document.getElementById('external-api-token-reveal');
      const value = document.getElementById('external-api-token-value');
      if (value) value.textContent = result.token;
      if (reveal) reveal.hidden = false;
      toast('Токен перевыпущен: старые программы получат 401', 'success');
      renderPanel();
    } finally {
      if (button) button.disabled = false;
    }
  });

  document.getElementById('external-api-token-copy')?.addEventListener('click', async () => {
    const value = document.getElementById('external-api-token-value')?.textContent || '';
    const ok = await copyText(value);
    toast(ok ? 'Токен скопирован.' : 'Браузер не разрешил копирование.', ok ? 'success' : 'error');
  });

  document.getElementById('external-api-forget')?.addEventListener('click', async () => {
    const result = await resetToken();
    if (!result.ok) {
      toast(result.error || 'Не удалось удалить токен', 'error');
      return;
    }
    const reveal = document.getElementById('external-api-token-reveal');
    if (reveal) reveal.hidden = true;
    toast('Токен удалён: при следующем включении будет создан новый', 'info');
    renderPanel();
  });

  document.getElementById('external-api-audit-refresh')?.addEventListener('click', refreshAudit);
  document.getElementById('external-api-audit-clear')?.addEventListener('click', async () => {
    await clearAudit();
    await refreshAudit();
  });

  // Сервер перезапускается и при смене прав: перерисовываем статус после сохранения.
  window.addEventListener('tf-persisted', () => {
    const statusEl = document.getElementById('external-api-status');
    if (statusEl) statusEl.textContent = 'Проверяю сервер…';
    apiStatus().then(status => {
      if (statusEl) statusEl.textContent = statusText(status, { tauri: isTauri() });
    });
  });
}
