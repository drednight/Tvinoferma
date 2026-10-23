// @ts-check
// js/core/notifyCenter.js
// Свои уведомления внутри приложения.
//
// Зачем: всплывающее окно Windows живёт несколько секунд и исчезает само, даже когда
// человек в этот момент в игре и до уведомления не добрался. Напоминание, которое
// пришлось запомнить по обрывку, хуже, чем его отсутствие. Здесь уведомление живёт,
// пока человек сам его не закроет или не нажмёт на него.
//
// Обычные тосты для этого не годятся: они исчезают по таймеру и рассчитаны на «сейчас
// гляну». Поэтому своя стопка: карточки с заголовком и текстом, крестик, переход по клику.
//
// Данные нигде не сохраняются: уведомление нужно увидеть сейчас, а не после перезапуска.

const MAX_VISIBLE = 4;

const root = () => document.getElementById('notify-center');

/** @type {Array<{ id: string, title: string, body: string, kind: string, at: number, onClick?: () => void }>} */
let items = [];

/** Подписчики: интерфейсу нужно знать, что стопка изменилась (счётчик в шапке). */
const listeners = new Set();

const LEVEL_BY_KIND = {
  launchError: 'error',
  close: 'info',
  launch: 'info',
  behind: 'warning',
  tight: 'warning',
  ending: 'warning',
  daily: 'info',
  event: 'accent',
  task: 'accent'
};

export function onNotifyCenter(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyChanged() {
  listeners.forEach(fn => {
    try {
      fn(items);
    } catch (e) {
      console.error('[NOTIFY-CENTER] подписчик упал:', e);
    }
  });
}

const escapeHtml = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Показать уведомление в приложении.
 *
 * @param {{ title: string, body?: string, kind?: string, onClick?: () => void, once?: boolean }} opts
 *   `once` — не добавлять повтор: тот же вид с тем же текстом в списке уже есть.
 *   Это важно для таймеров: без проверки одно и то же напоминание лилось бы в стопку
 *   на каждой проверке, пока человек не закроет предыдущее.
 * @returns {boolean} показали ли
 */
export function showInApp({ title, body = '', kind = 'info', onClick = null, once = false }) {
  const box = root();
  if (!box) return false;
  const text = String(body || '').trim();
  if (once && items.some(it => it.kind === kind && it.title === title && it.body === text)) return true;

  const item = {
    id: `nc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(title || ''),
    body: text,
    kind,
    at: Date.now(),
    onClick
  };
  items = [item, ...items];
  // Больше MAX_VISIBLE карточек держать незачем: мигает над играющей поверх, и нужное
  // всё равно уходит наверх. Счётчик «ещё N» показывает, что список не пустой.
  if (items.length > MAX_VISIBLE + 6) items = items.slice(0, MAX_VISIBLE + 6);
  render();
  notifyChanged();
  return true;
}

export function dismissInApp(id) {
  const before = items.length;
  items = items.filter(it => it.id !== id);
  if (items.length !== before) {
    render();
    notifyChanged();
  }
}

export function clearInApp() {
  if (!items.length) return;
  items = [];
  render();
  notifyChanged();
}

export function inAppItems() {
  return items;
}

const whenText = at => {
  const d = new Date(at);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

function render() {
  const box = root();
  if (!box) return;
  const shown = items.slice(0, MAX_VISIBLE);
  const hidden = items.length - shown.length;
  box.innerHTML = `
    ${hidden > 0 ? `<button type="button" class="nc-more" data-nc-action="clear">и ещё ${hidden} — свернуть все</button>` : ''}
    ${shown
      .map(
        it => `
      <div class="nc-card is-${LEVEL_BY_KIND[it.kind] || 'info'}" data-nc-id="${escapeHtml(it.id)}">
        <div class="nc-body">
          <b class="nc-title">${escapeHtml(it.title)}</b>
          ${it.body ? `<p class="nc-text">${escapeHtml(it.body)}</p>` : ''}
          <small class="nc-time">${whenText(it.at)}</small>
        </div>
        <button type="button" class="nc-close" data-nc-action="dismiss" data-nc-id="${escapeHtml(it.id)}"
                aria-label="Закрыть уведомление">✕</button>
      </div>`
      )
      .join('')}`;
}

/** Подписка на клики: один обработчик на весь контейнер, карточки перерисовываются целиком. */
export function bindNotifyCenter() {
  const box = root();
  if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';
  box.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const action = target.closest?.('[data-nc-action]')?.getAttribute('data-nc-action');
    if (action === 'clear') {
      clearInApp();
      return;
    }
    if (action === 'dismiss') {
      dismissInApp(target.closest('[data-nc-id]')?.getAttribute('data-nc-id') || '');
      return;
    }
    const id = target.closest('[data-nc-id]')?.getAttribute('data-nc-id');
    const item = items.find(it => it.id === id);
    if (!item) return;
    // Клик по уведомлению — это согласие («показать, что делать»), поэтому закрываем
    item.onClick?.();
    dismissInApp(id);
  });
}
