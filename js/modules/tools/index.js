// js/modules/tools/index.js
// Раздел «Инструменты»: действия над уже заведёнными данными.
//
// Почему отдельный раздел: первые пять (Сегодня, Персонажи, Пати, Марафоны, Руны) —
// это данные и объекты, то есть «что у меня есть». Инструменты — действия над ними,
// и раньше они были спрятаны в круглой кнопке «+» в углу, где их приходилось искать
// и где требовалось второе нажатие. Теперь они видны сразу, списком.
//
// Сюда переехали из FAB: все скрипты (вход, балансы, промокод, передача, подарки,
// сундук караванщика, марафоны) и управление окнами игры.
// Из Настроек переехало «Состояние парсеров» — это тоже диагностика, а не настройка.
//
// Чего здесь нет и не должно быть: интервалов, порогов и прочего, что настраивают
// каждый раз. Это Настройки.

import { escapeHtml } from '../../core/utils.js';
import { runningWindows, onRunningWindows, refreshRunningWindows } from '../launcher/runningWindows.js';
import { refreshParserHealthPanel } from '../../settings/parserHealthUi.js';

/**
 * Скрипты раздела. `id` совпадает со значением `data-script-action`, которое уже
 * обрабатывалось в FAB, — сам запуск переехал из uiActions.js и не изменился.
 * Порядок — от проверки данных к действиям с предметами.
 */
const SCRIPTS = [
  { id: 'check-auth', ico: '🔐', label: 'Проверка входа',   hint: 'Проверить вход у всех персонажей на сайте игры' },
  { id: 'update-balance', ico: '💰', label: 'Балансы',       hint: 'Обновить баланс Древних монет' },
  { id: 'update-marathons', ico: '🏃', label: 'Марафоны',     hint: 'Сверить задания и прогресс на сайте' },
  { id: 'promo', ico: '🎁', label: 'Промокод',          hint: 'Активировать промокод на аккаунтах' },
  { id: 'transfer', ico: '📦', label: 'Передача',    hint: 'Передать предметы с сайта в игру' },
  { id: 'shop', ico: '🪙', label: 'Подарки',           hint: 'Купить подарки за Древние монеты' },
  { id: 'caravan', ico: '🧰', label: 'Сундук караванщика', hint: 'Открыть сундуки в инвентаре' },
  { id: 'close-game', ico: '🛑', label: 'Закрыть все окна игры', hint: 'Закрыть все запущенные окна игры' }
];

const root = () => document.getElementById('tools-root');

function uptimeText(ms) {
  if (ms == null) return 'время работы неизвестно';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `работает ${min} мин`;
  return `работает ${Math.floor(min / 60)} ч ${min % 60} мин`;
}

export function renderTools() {
  const el = root();
  if (!el) return;
  el.innerHTML = `
    <section class="tools-block" aria-labelledby="tools-scripts-title">
      <header class="tools-block-head">
        <h3 id="tools-scripts-title">Скрипты</h3>
        <p class="muted">Скрипты выполняются по одному: новый встаёт в очередь и ждёт, пока закончит предыдущий. Ход работы — в плашке журнала в шапке.</p>
      </header>
      <div class="tools-grid">
        ${SCRIPTS.map(s => `
          <button type="button" class="tools-card" data-script-action="${s.id}" title="${escapeHtml(s.hint)}">
            <span class="tools-card-ico" aria-hidden="true">${s.ico}</span>
            <span class="tools-card-body"><b>${escapeHtml(s.label)}</b><small>${escapeHtml(s.hint)}</small></span>
          </button>`).join('')}
      </div>
    </section>

    <section class="tools-block" aria-labelledby="tools-windows-title">
      <header class="tools-block-head">
        <h3 id="tools-windows-title">Окна игры</h3>
        <p class="muted">Клиенты, запущенные на этом компьютере.</p>
      </header>
      <div class="tools-row" data-tools-windows>
        <p class="muted">Проверяем запущенные окна…</p>
      </div>
      <div class="tools-actions">
        <button type="button" class="btn ghost" data-tools-act="pick-windows" title="Показать все окна игры и закрыть выбранные">🎮 Показать все окна</button>
        <button type="button" class="btn ghost" data-tools-act="close-all-windows" title="Закрыть все запущенные окна игры">🛑 Закрыть все окна игры</button>
      </div>
    </section>`;
  fillWindows();
  // Таблица парсеров подписана на изменения, но раздел мог ещё не открываться
  refreshParserHealthPanel();
}

/** Список окон игры: сначала кэш, потом живое обновление из Rust. */
function fillWindows() {
  const box = root()?.querySelector('[data-tools-windows]');
  if (!box) return;
  const draw = (rows) => {
    if (!rows.length) {
      box.innerHTML = '<p class="muted">Запущенных окон игры нет.</p>';
      return;
    }
    box.innerHTML = `<ul class="today-list rwn-list">${rows.map(r => `
      <li class="today-row rwn-row">
        <span class="rwn-dot ${r.known ? 'is-known' : ''}" aria-hidden="true"></span>
        <span class="today-row-text">
          <b title="${escapeHtml(r.nick || r.title || '')}">${escapeHtml(r.title || r.nick || `Окно ${r.pid}`)}</b>
          <small class="muted">${escapeHtml(uptimeText(r.uptimeMs))}${r.elevated ? ' · админ' : ''}</small>
        </span>
        <button type="button" class="btn ghost small" data-tools-act="close-one-window" data-pid="${r.pid}"
                title="Закрыть это окно игры">🛑 Закрыть</button>
      </li>`).join('')}</ul>`;
  };
  draw(runningWindows());
  const off = onRunningWindows(draw);
  // Подписка живёт, пока открыт раздел: уходим с вкладки — снимаем
  box.closest('.page')?.addEventListener('tf-leave', off, { once: true });
}

export function bindTools() {
  const el = root();
  if (!el || el.dataset.toolsBound) return;
  el.dataset.toolsBound = 'true';
  el.addEventListener('click', async (event) => {
    const script = /** @type {HTMLElement} */ (event.target).closest?.('[data-script-action]');
    if (script) {
      const { runScriptAction } = await import('../../core/uiActions.js');
      await runScriptAction(script.dataset.scriptAction);
      return;
    }
    const act = /** @type {HTMLElement} */ (event.target).closest?.('[data-tools-act]');
    if (!act) return;
    if (act.dataset.toolsAct === 'pick-windows') {
      const { openWindowPicker } = await import('../launcher/windowPicker.js');
      await openWindowPicker();
    } else if (act.dataset.toolsAct === 'close-all-windows') {
      const { closeAllGameWindows } = await import('../launcher/partyLaunch.js');
      await closeAllGameWindows({ confirm: true });
    } else if (act.dataset.toolsAct === 'close-one-window') {
      const pid = Number(act.dataset.pid);
      if (!pid) return;
      const { closeClientsByPid } = await import('../launcher/launch.js');
      const { showCloseReport } = await import('../launcher/partyLaunch.js');
      const { confirmModal } = await import('../../core/ui.js');
      const row = runningWindows().find(r => r.pid === pid);
      const ok = await confirmModal({
        title: `Закрыть окно игры: ${row ? (row.nick || row.title) : `PID ${pid}`}?`,
        text: 'Всё, что не сохранено в игре, будет потеряно.',
        okText: 'Закрыть окно',
        danger: true
      });
      if (!ok) return;
      showCloseReport(await closeClientsByPid([pid]));
      await refreshRunningWindows();
    }
  });
}

/** Заголовки разделов меню и горячие клавиши живут в index.html и desktop.js. */
export const TOOLS_SECTION = 'tools';