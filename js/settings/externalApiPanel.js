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
  currentToken,
  rotateToken,
  resetToken,
  syncExternalApi
} from '../modules/externalApi/index.js';
import { auditLine, errorCatalogRows } from '../modules/externalApi/errors.js';

const PORT_DEFAULT = 47831;
/**
 * Порт по умолчанию в тестовой сборке. Rust подставляет его сам
 * (`port_for_profile`), когда JS прислал умолчание стабильной сборки: две
 * сборки могут работать одновременно, и адрес у них разный.
 */
const PORT_DEFAULT_ACCEPTANCE = 47832;

/**
 * Адрес страницы API — **по фактическому порту работающего сервера**.
 *
 * Раньше кнопка «Открыть страницу API» брала порт из настроек. В тестовой сборке
 * Rust подставляет `47832`, а в настройках остаётся `47831` — открывалась пустая
 * страница (или чужая, если рядом работает рабочая копия). Теперь порядок такой:
 *   1. `status.port` — сервер запущен и сам сообщил порт;
 *   2. сохранённый порт из настроек;
 *   3. умолчание профиля.
 *
 * Правило то же, что в Rust (`port_for_profile`): в тестовой сборке умолчание
 * стабильной сборки (`47831`) заменяется портом профиля, а явно выбранный
 * пользователем порт остаётся как есть. Держать эти правила одинаковыми важно:
 * иначе адрес на экране и адрес сервера разъезжаются.
 */
export function apiPort({ status = null, settings = null, profile = '' } = {}) {
  const running = Number(status?.port);
  if (Number.isFinite(running) && running > 0) return running;
  const saved = Number(settings?.port);
  const port = Number.isFinite(saved) && saved > 0 ? saved : PORT_DEFAULT;
  if (String(profile).startsWith('acceptance') && port === PORT_DEFAULT) return PORT_DEFAULT_ACCEPTANCE;
  return port;
}

/** Адрес страницы API для открытия в браузере. */
export function apiPageUrl(options = {}) {
  return `http://127.0.0.1:${apiPort(options)}/`;
}

/**
 * Подпись профиля сборки для строки статуса.
 *
 * В тестовой сборке API работает намеренно, но пользователь должен видеть, что
 * это тестовый сервер: у него другой порт и другой токен. Без пометки легко
 * решить, что тестовая сборка «сломала» рабочую настройку.
 */
export function profileNote(status) {
  const profile = String(status?.profile || '');
  if (profile === 'acceptance-shared') return ' ⚠️ ТЕСТОВАЯ СБОРКА с общими данными: это не рабочий сервер.';
  if (profile === 'acceptance') return ' ⚠️ Тестовая сборка: это не рабочий сервер.';
  return '';
}

/** Строка статуса сервера. */
export function statusText(status, { tauri = true } = {}) {
  if (!tauri) return 'Внешний API работает только в приложении, а не в браузере.';
  if (!status?.running) {
    return status?.error ? `Сервер остановлен: ${status.error}` : 'Сервер остановлен: включите переключатель выше.';
  }
  const port = apiPort({ status, profile: status?.profile });
  const scopes = status.scopes || {};
  const names = [
    scopes.read ? 'чтение' : null,
    scopes.modify ? 'изменение' : null,
    scopes.launchClose ? 'запуск и закрытие' : null
  ].filter(Boolean);
  const ready = status.clientReady === false ? ' Окно ещё подключается: запросы временно получают 503.' : '';
  return `✅ Сервер работает на http://127.0.0.1:${port} · права: ${names.length ? names.join(', ') : 'нет'}.${profileNote(status)}${ready}`;
}

/**
 * Строка про токен: создан ли и когда. Само значение здесь не появляется —
 * панель настроек не выводит секрет в обычную строку статуса, показ отдельно
 * включается кнопкой и сам гаснет (см. `revealToken`).
 *
 * `status` влияет только на подсказку: если сервер остановлен, копировать токен
 * всё равно можно (он лежит в хранилище), но клиенту это ничего не даст.
 */
export function tokenText(settings, status) {
  const created = settings?.tokenCreatedAt;
  if (!created) {
    return 'Токен ещё не создан: он появится при включении сервера — или нажмите «Скопировать токен».';
  }
  const at = new Date(created);
  const when = Number.isNaN(at.getTime()) ? '' : ` (создан ${at.toLocaleString('ru-RU')})`;
  const stopped =
    status && status.running === false ? ' Сервер остановлен: значение токен не меняет, но запросы не примутся.' : '';
  return `Токен в хранилище учётных данных ОС${when}. Его можно скопировать или показать снова; перевыпуск нужен, только если он утёк.${stopped}`;
}

/**
 * Строки журнала: время, метод, путь, код, длительность. Без тел запросов.
 *
 * Ошибки подписаны по-русски из общего каталога (`errors.js`): «Значение не
 * принято (422)» читается лучше, чем голое `422`. Успешные вызовы остаются
 * короткими — подпись только у ошибок.
 */
export function auditLines(entries) {
  if (!Array.isArray(entries) || !entries.length) return ['Журнал пуст.'];
  return entries
    .slice()
    .reverse()
    .map(entry => {
      const status = Number(entry.status) || 0;
      // Подпись только у ошибок: успешные вызовы читаются короче без неё.
      const code = status >= 400 ? entry.code || statusTitle(status) : '';
      return auditLine({ ...entry, code });
    });
}

/** Подпись по HTTP-статусу, когда кода в записи нет (старые записи Rust). */
function statusTitle(status) {
  const row = errorCatalogRows().find(entry => entry.status === status);
  return row ? row.code : '';
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

/** Сколько секунд показанное значение остаётся на экране. */
const REVEAL_MS = 60_000;
/** Видно ли сейчас значение токена (кнопка-переключатель и автоскрытие). */
let revealed = false;
/** @type {any} */
let revealTimer = null;

/**
 * Показать токен в блоке `#external-api-token-reveal`.
 * @param {string} token
 * @param {'fresh' | 'current'} kind «fresh» — после перевыпуска, «current» — просто прочитали.
 */
function showToken(token, kind) {
  const reveal = document.getElementById('external-api-token-reveal');
  const value = document.getElementById('external-api-token-value');
  const note = document.getElementById('external-api-token-reveal-note');
  if (value) value.textContent = token;
  if (note) {
    note.textContent =
      kind === 'fresh'
        ? 'Новый токен — сохраните его сейчас: второй раз старый не восстановить.'
        : 'Текущий токен — он не изменился. Через минуту строка снова скроется.';
  }
  if (reveal) reveal.hidden = false;
  revealed = true;
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(() => hideToken(), REVEAL_MS);
}

/** Убрать значение из разметки и вернуть подпись кнопки. */
function hideToken() {
  const reveal = document.getElementById('external-api-token-reveal');
  const value = document.getElementById('external-api-token-value');
  const showButton = document.getElementById('external-api-token-show');
  if (value) value.textContent = '';
  if (reveal) reveal.hidden = true;
  if (showButton) showButton.textContent = 'Показать токен';
  revealed = false;
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
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
    // Порт берём у работающего сервера: в тестовой сборке он отличается от
    // сохранённого, и «Открыть страницу API» должна вести на настоящий адрес.
    const status = await apiStatus().catch(() => null);
    const url = apiPageUrl({
      status,
      settings: state.settings?.externalApi,
      profile: status?.profile
    });
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
    const status = await apiStatus().catch(() => null);
    const port = apiPort({ status, settings: state.settings?.externalApi, profile: status?.profile });
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
      showToken(result.token, 'fresh');
      toast('Токен перевыпущен: старые программы получат 401', 'success');
      renderPanel();
    } finally {
      if (button) button.disabled = false;
    }
  });

  // Копирование читает токен из хранилища и НЕ показывает его: частый сценарий —
  // «вставить в скрипт», и держать 64 символа на экране ради этого незачем.
  // До этой правки единственный способ получить значение был «перевыпустить»,
  // токен менялся, и все настроенные клиенты отваливались на 401.
  document.getElementById('external-api-token-copy')?.addEventListener('click', async () => {
    const result = await currentToken();
    if (!result.ok || !result.token) {
      toast(result.error || 'Не удалось прочитать токен', 'error');
      return;
    }
    const ok = await copyText(result.token);
    const note = result.created ? ' Токен создан сейчас: раньше его не было.' : '';
    toast(
      ok ? `Токен скопирован, он не менялся.${note}` : 'Браузер не разрешил копирование.',
      ok ? 'success' : 'error'
    );
  });

  // Показ — по явной кнопке и на время: значение видно, пока его вставляют, потом
  // гаснет само. Так секрет не остаётся в разметке окна, которое могут снять на скриншот.
  const showButton = document.getElementById('external-api-token-show');
  document.getElementById('external-api-token-show')?.addEventListener('click', async () => {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    if (revealed) {
      hideToken();
      return;
    }
    const result = await currentToken();
    if (!result.ok || !result.token) {
      toast(result.error || 'Не удалось прочитать токен', 'error');
      return;
    }
    showToken(result.token, result.created ? 'fresh' : 'current');
    if (showButton) showButton.textContent = 'Скрыть токен';
  });

  document.getElementById('external-api-forget')?.addEventListener('click', async () => {
    const result = await resetToken();
    if (!result.ok) {
      toast(result.error || 'Не удалось удалить токен', 'error');
      return;
    }
    hideToken();
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
