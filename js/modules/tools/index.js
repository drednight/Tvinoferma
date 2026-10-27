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
// «Состояние парсеров» живёт в «Настройки → Синхронизация», а «Закрыть все окна игры» —
// в блоке «Окна игры» ниже: в «Операциях» остались только действия над данными.
//
// Чего здесь нет и не должно быть: интервалов, порогов и прочего, что настраивают
// каждый раз. Это Настройки.

import { escapeHtml } from '../../core/utils.js';
import { toast } from '../../core/ui.js';
import { runningWindows, onRunningWindows, refreshRunningWindows } from '../launcher/runningWindows.js';
import { rowLabel, formatUptime } from '../launcher/windowList.js';

/**
 * Скрипты раздела. `id` совпадает со значением `data-script-action`, которое уже
 * обрабатывалось в FAB, — сам запуск переехал из uiActions.js и не изменился.
 * `type` разделяет скрипты на две зоны:
 *  - check — только читают данные с сайта, не нажимают кнопок, могут работать в фоне;
 *  - action — требуют нажатия и подтверждения пользователя, не запускаются по расписанию.
 * Порядок — от проверки данных к действиям с предметами.
 */
const SCRIPTS = [
  {
    id: 'check-auth',
    type: 'check',
    ico: '🔐',
    label: 'Проверка входа',
    hint: 'Проверить вход у всех персонажей на сайте игры'
  },
  {
    id: 'update-balance',
    type: 'check',
    ico: '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg>',
    label: 'Балансы',
    hint: 'Обновить баланс Древних монет'
  },
  { id: 'update-marathons', type: 'check', ico: '🏃', label: 'Марафоны', hint: 'Сверить задания и прогресс на сайте' },
  { id: 'promo', type: 'action', ico: '🎁', label: 'Промокод', hint: 'Активировать промокод на аккаунтах' },
  { id: 'transfer', type: 'action', ico: '📦', label: 'Передача', hint: 'Передать все предметы с сайта' },
  {
    id: 'shop',
    type: 'action',
    ico: '<svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg>',
    label: 'Подарки',
    hint: 'Купить подарки за Древние монеты'
  },
  { id: 'caravan', type: 'action', ico: '🧰', label: 'Сундук караванщика', hint: 'Открыть сундуки в инвентаре' }
  // «Закрыть все окна игры» здесь не карточка скрипта: действие живёт в блоке «Окна игры»
  // ниже, рядом со списком окон, к которому относится.
];

const CHECKS = SCRIPTS.filter(s => s.type === 'check');
const ACTIONS = SCRIPTS.filter(s => s.type === 'action');

const root = () => document.getElementById('tools-root');

function uptimeText(ms) {
  return ms == null ? 'время работы неизвестно' : `работает ${formatUptime(ms)}`;
}

function renderScriptCards(list) {
  return list
    .map(
      s => `
    <button type="button" class="tools-card tools-card--${s.type}" data-script-action="${s.id}" title="${escapeHtml(s.hint)}">
      <span class="tools-card-ico" aria-hidden="true">${s.ico}</span>
      <span class="tools-card-body"><b>${escapeHtml(s.label)}</b><small>${escapeHtml(s.hint)}</small></span>
    </button>`
    )
    .join('');
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

      <div class="tools-group">
        <header class="tools-group-head">
          <h4>Проверки</h4>
          <p class="muted">Только читают данные с сайта — не нажимают кнопок и не меняют ничего. Могут работать в фоне.</p>
        </header>
        <div class="tools-grid tools-grid--check">
          ${renderScriptCards(CHECKS)}
        </div>
      </div>

      <div class="tools-group">
        <header class="tools-group-head">
          <h4>Операции</h4>
          <p class="muted">Требуют вашего нажатия и подтверждения. Не запускаются по расписанию — только по кнопке.</p>
        </header>
        <div class="tools-grid tools-grid--action">
          ${renderScriptCards(ACTIONS)}
        </div>
      </div>
    </section>

    <section class="tools-block" aria-labelledby="tools-windows-title">
      <header class="tools-block-head tools-block-head-row">
        <div>
          <h3 id="tools-windows-title">Окна игры</h3>
          <p class="muted">Клиенты, запущенные на этом компьютере.</p>
        </div>
        <!-- Обновление стоит в шапке: список окон меняется сам, а кнопка его обновления —
             не действие над окнами, а обновление самого списка. В общей кучке с «закрыть
             всё» она выглядела так же важно, как действия, которые окна ломают. -->
        <button type="button" class="btn ghost small" data-tools-act="refresh-windows"
                title="Спросить у игры, какие окна запущены прямо сейчас">🔄 Обновить</button>
      </header>
      <div class="tools-row" data-tools-windows>
        <p class="muted">Проверяем запущенные окна…</p>
      </div>
      <div class="tools-actions">
        <button type="button" class="btn ghost" data-tools-act="gc-binding" title="Список GameCenter, привязка аккаунтов и запомненные входы">🎮 GameCenter и персонажи</button>
        <button type="button" class="btn ghost" data-tools-act="pick-windows" title="Показать все окна игры и закрыть выбранные">🖥️ Показать все окна</button>
        <button type="button" class="btn ghost" data-tools-act="close-all-windows" title="Закрыть все запущенные окна игры">🛑 Закрыть все окна игры</button>
      </div>
    </section>`;
  fillWindows();
}

/** Список окон игры: сначала кэш, потом живое обновление из Rust. */
function fillWindows() {
  const box = root()?.querySelector('[data-tools-windows]');
  if (!box) return;
  const draw = rows => {
    if (!rows.length) {
      box.innerHTML = '<p class="muted">Запущенных окон игры нет.</p>';
      return;
    }
    box.innerHTML = `<ul class="today-list rwn-list">${rows
      .map(
        r => `
      <li class="today-row rwn-row">
        <span class="rwn-dot ${r.known ? 'is-known' : ''}" aria-hidden="true"></span>
        <span class="today-row-text">
          <b title="${escapeHtml(rowLabel(r))}">${escapeHtml(rowLabel(r))}</b>
          <small class="muted">${escapeHtml(uptimeText(r.uptimeMs))}${r.elevated ? ' · админ' : ''}</small>
        </span>
        <button type="button" class="btn ghost small" data-tools-act="close-one-window" data-pid="${r.pid}"
                title="Закрыть это окно игры">🛑 Закрыть</button>
      </li>`
      )
      .join('')}</ul>`;
  };
  draw(runningWindows());
  const off = onRunningWindows(draw);
  // Подписка живёт, пока открыт раздел: уходим с вкладки — снимаем
  box.closest('.page')?.addEventListener('tf-leave', off, { once: true });
}

/**
 * Кнопка «Обновить» в блоке «Окна игры»: спрашивает у Rust, что запущено прямо сейчас.
 *
 * Пока запрос идёт, кнопка выключена и говорит об этом — иначе повторные клики только
 * ждали бы один и тот же опрос. Список перерисовывает подписчик, отдельного вызова не
 * нужно. Неудача показывается отдельно: молчаливый старый список читался бы как «окна
 * закрылись», а это противоположный вывод.
 *
 * @param {HTMLElement} btn
 */
async function refreshWindowsButton(btn) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Проверяем…';
  try {
    if (!(await refreshRunningWindows())) toast('Не удалось получить список окон игры', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export function bindTools() {
  const el = root();
  if (!el || el.dataset.toolsBound) return;
  el.dataset.toolsBound = 'true';
  el.addEventListener('click', async event => {
    const script = /** @type {HTMLElement} */ (event.target).closest?.('[data-script-action]');
    if (script) {
      const { runScriptAction } = await import('../../core/uiActions.js');
      await runScriptAction(script.dataset.scriptAction);
      return;
    }
    const act = /** @type {HTMLElement} */ (event.target).closest?.('[data-tools-act]');
    if (!act) return;
    if (act.dataset.toolsAct === 'refresh-windows') {
      // Список окон меняется не только здесь: игру можно закрыть снаружи, а окно может
      // упасть само. Без кнопки сверить список можно было только закрытием окна — то есть
      // цена проверки «какие окна открыты» была в потерянном окне.
      await refreshWindowsButton(act);
    } else if (act.dataset.toolsAct === 'gc-binding') {
      // То же окно, что и «Настройки → Запуск игры» и карточка персонажа: одна реализация,
      // чтобы правила привязки и входов не расходились между разделами
      const { openGameCentersModal } = await import('../launcher/gcSettingsModal.js');
      openGameCentersModal();
    } else if (act.dataset.toolsAct === 'pick-windows') {
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
        title: `Закрыть окно игры: ${row ? row.nick || row.title : `PID ${pid}`}?`,
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
