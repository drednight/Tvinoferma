// js/modules/launcher/preflightDialog.js
// Экран «Проверка перед запуском»: кого запустим, кого пропустим и что стоит исправить.
// Логика проверок — preflight.js; сам запуск и исправление — partyLaunch.js. Окно только показывает итог и возвращает выбор:
//   { action: 'launch', droppedIds } — запустить готовых, кроме снятых вручную,
//   { action: 'fix', droppedIds } — исправить то, что можно, и запустить, null — отмена.
//
// Список состава здесь, а не только в модальном окне выбора: человек читает проверки
// и ровно в этот момент видит, что у Жреца вход не запомнен, а Лучника запускать
// сегодня не надо. Открывать ради этого второе окно и искать пати заново — лишний
// путь; «скипнуть» и «запустить только этого» делаются в один клик там, где контекст.
//
// Возврат остаётся совместимым со строкой: кто-то может вернуть 'launch' / 'fix'
// напрямую (например, тестовая подмена), вызывающий принимает обе формы.

import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { availableFixes, preflightMemberRows } from './preflight.js';

const names = (list, max = 12) => {
  const all = list.map(c => String(c.char?.nick ?? c.nick ?? c.id));
  return all.length > max ? `${all.slice(0, max).join(', ')} и ещё ${all.length - max}` : all.join(', ');
};

/**
 * Строки экрана: { icon, level, title, text? }. Отдельно от DOM, чтобы их можно было проверить тестом.
 * @param {import('./preflight.js').Preflight} pre
 */
export function preflightRows(pre) {
  /** @type {Array<{ icon: string, level: 'ok'|'info'|'warn'|'error', title: string, text?: string }>} */
  const rows = [];
  if (pre.toLaunch.length)
    rows.push({ icon: '✅', level: 'ok', title: `Будут запущены: ${pre.toLaunch.length}`, text: names(pre.toLaunch) });
  if (pre.alreadyRunning.length) {
    rows.push({
      icon: '⏭',
      level: 'info',
      title: `Уже запущены, пропущу: ${pre.alreadyRunning.length}`,
      text: `${names(pre.alreadyRunning)}. Очередь сразу перейдёт к следующим; окно узнаётся по названию «Ник — Класс».`
    });
  }
  if (pre.noGc.length) {
    rows.push({
      icon: '❌',
      level: 'error',
      title: `Не указан GameCenter: ${pre.noGc.length}`,
      text: `${names(pre.noGc)}. Без него игру не запустить: эти персонажи будут пропущены.`
    });
  }
  if (pre.noSavedLogin.length) {
    rows.push({
      icon: '🔑',
      level: 'error',
      title: `Вход в GameCenter не запомнен: ${pre.noSavedLogin.length} — запустить нельзя`,
      text:
        `${names(pre.noSavedLogin)}. Без запомненного входа GameCenter открывает окно под тем аккаунтом, ` +
        'который выбран в нём сейчас, — для пати это почти всегда не тот аккаунт. Эти персонажи не запустятся. ' +
        'Войдите в нужный аккаунт в самом GameCenter и запомните вход: «Инструменты» → «Окна игры» → ' +
        '«🎮 GameCenter и персонажи» → «🔑 Запомнить вход».'
    });
  }
  if (pre.adminMismatch) {
    rows.push({
      icon: '🔐',
      level: 'warn',
      title: `Окна игры от администратора: ${pre.elevatedClients}`,
      text:
        'Windows не даст подписать такие окна (название и значок) и закрыть их из обычной Твинофермы. ' +
        'Нажмите «🛠 Исправить и запустить» — Windows один раз спросит разрешение, и помощник сделает это от администратора. ' +
        'Приложение при этом не перезапускается и остаётся обычным. ' +
        'Постоянные права: «Настройки» → «Запуск игры» → «От имени администратора» при автозапуске, ' +
        'а текущую копию там же можно перезапустить с правами одной кнопкой.'
    });
  }
  if (pre.siteNoLogin.length) {
    rows.push({
      icon: 'ℹ️',
      level: 'info',
      title: `Нет входа на сайт: ${pre.siteNoLogin.length}`,
      text: `${names(pre.siteNoLogin)}. На запуск игры это не влияет, но скрипты сайта (промокоды, подарки, сундуки) у них не сработают.`
    });
  }
  if (!pre.runningKnown) {
    rows.push({
      icon: 'ℹ️',
      level: 'info',
      title: 'Не удалось узнать, какие окна уже запущены',
      text: 'Запущенные окна не пропускаются: возможны дубли.'
    });
  } else {
    if (!pre.decorate)
      rows.push({
        icon: 'ℹ️',
        level: 'info',
        title: 'Запущенные окна не распознаются',
        text: 'Включите «Подписывать окна игры» в настройках: по названию «Ник — Класс» Твиноферма узнаёт, кто уже в игре.'
      });
    else if (pre.unknownClients)
      rows.push({
        icon: 'ℹ️',
        level: 'info',
        title: `Окон игры не из Твинофермы: ${pre.unknownClients}`,
        text: 'Их нельзя сопоставить с персонажами, поэтому они не учитываются.'
      });
  }
  return rows;
}

/**
 * Строки списка состава: вид отдельной функцией, чтобы его можно было проверить
 * тестом без DOM (тот же приём, что у `preflightRows`).
 * @param {Array<{ id: string, nick: string, className: string, kind: string, note: string, checked: boolean }>} rows
 */
function memberRowsHtml(rows) {
  if (!rows.length) return '';
  const ready = rows.filter(r => r.kind === 'ready');
  if (ready.length < 2) return ''; // выбирать не из чего: один персонаж и так запустится
  return `
      <div class="prl-members">
        <div class="prl-members-head">
          <b>Кого запускаем</b>
          <span class="muted">снимите отметку, чтобы пропустить; «только этот» запустит одного</span>
          <button class="btn ghost small" type="button" data-act="all">отметить всех</button>
        </div>
        ${rows
          .map(row => {
            const control =
              row.kind === 'ready'
                ? `<input type="checkbox" class="prl-mcheck" value="${escapeHtml(row.id)}"${row.checked ? ' checked' : ''} aria-label="${escapeHtml(row.nick)}" />`
                : `<span class="prl-mdot" aria-hidden="true">${row.kind === 'running' ? '⏭' : '·'}</span>`;
            const solo =
              row.kind === 'ready'
                ? `<button class="btn ghost small" type="button" data-solo-id="${escapeHtml(row.id)}" title="Запустить только ${escapeHtml(row.nick)}">только этот</button>`
                : '';
            return `
        <div class="prl-mrow prl-mrow-${row.kind}" data-member-id="${escapeHtml(row.id)}">
          <label class="prl-mmain">${control}<span class="prl-mnick">${escapeHtml(row.nick)}</span>${
            row.className ? `<small class="muted">${escapeHtml(row.className)}</small>` : ''
          }</label>
          ${row.note ? `<small class="prl-mnote muted">${escapeHtml(row.note)}</small>` : ''}
          ${solo}
        </div>`;
          })
          .join('')}
      </div>`;
}

/**
 * Показывает экран и ждёт выбора.
 * @param {import('./preflight.js').Preflight} pre
 * @param {{ title?: string, gameCenters?: Array<{ id: string, name: string }>, droppedIds?: string[] | null }} [opts]
 *   `droppedIds` — кого уже сняли вручную: второй круг окна (после «Исправить»)
 *   должен показать те же снятые отметки, а не все подряд
 * @returns {Promise<{ action: 'launch' | 'fix', droppedIds: string[] } | null>}
 */
export function openPreflight(pre, { title = '', gameCenters = [], droppedIds = null } = {}) {
  return new Promise(resolve => {
    let answer = null;
    let settled = false;
    let observer = null;
    // Экран обязан отдать результат при любом закрытии: иначе задача останется
    // running и заблокирует очередь до перезапуска приложения.
    const settle = result => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      observer = null;
      resolve(result ?? null);
    };
    const dlg = openOverlay({ title: '🧭 Проверка перед запуском', wide: true, onClose: () => settle(answer) });
    // Обычные пути (крестик, Escape, массовое закрытие) идут через close() и onClose.
    // Остаётся случай, когда оверлей убрали из DOM мимо close(): ловим пропажу узла
    // и закрываем сами. documentElement, а не #modal-root, — чтобы поймать и замену body.
    observer = new MutationObserver(() => {
      if (dlg.el.isConnected) return;
      dlg.close();
      settle(answer);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const fixes = availableFixes(pre, { gameCenters });
    dlg.sub.textContent = title || '';
    dlg.body.innerHTML = `<div class="prl-list">${preflightRows(pre)
      .map(
        r => `
      <div class="prl-row prl-${r.level}"><span class="prl-ico">${r.icon}</span>
        <div><b>${escapeHtml(r.title)}</b>${r.text ? `<div class="muted">${escapeHtml(r.text)}</div>` : ''}</div></div>`
      )
      .join('')}</div>
      ${fixes.length ? `<div class="prl-fix">🛠 «Исправить и запустить»: ${fixes.map(f => escapeHtml(f.text)).join('; ')}.</div>` : ''}`;
    dlg.body.innerHTML += memberRowsHtml(preflightMemberRows(pre, { droppedIds }));

    const canFixThenLaunch = fixes.length > 0;
    const launchButton = () => /** @type {HTMLButtonElement | null} */ (dlg.foot.querySelector('[data-act="launch"]'));
    const checkedIds = () =>
      [...dlg.body.querySelectorAll('.prl-mcheck')].filter(box => box.checked).map(box => String(box.value));
    const readyIds = (pre.toLaunch || []).map(c => String(c.id));
    // Список состава показывается, только когда выбирать из чего (двое и больше).
    // Без него отвечать нечем: пустой ответ был бы понят как «снять некого», и
    // снимать тут нечего — отметки есть, но их не видеть.
    const hasPicker = () => !!dlg.body.querySelector('.prl-mcheck');
    // Отвечаем списком СНЯТЫХ (см. `applyPreflightDrops`): отмеченные из первого
    // круга потеряли бы того, кого починили между кругами.
    const droppedNow = () => {
      if (!hasPicker()) return [];
      const kept = new Set(checkedIds());
      return readyIds.filter(id => !kept.has(id));
    };
    // Сколько останется: свой счётчик, а не `pre.toLaunch.length`, — иначе кнопка
    // обещает запустить тех, кого человек только что снял.
    const markedCount = () => readyIds.length - droppedNow().length;
    // Когда часть пати выпала, главная кнопка обещает ровно то, что будет сделано:
    // запустить остальных, а не всех подряд. После каждой отметки подпись
    // пересчитывается — «Запустить (0)» с активной кнопкой была бы ловушкой.
    const launchLabel = () => {
      const n = markedCount();
      const dropped = pre.noGc.length + pre.noSavedLogin.length;
      const base = dropped || n !== (pre.toLaunch || []).length ? '▶ Запустить остальных' : '▶ Запустить';
      return `${base}${n ? ` (${n})` : ''}`;
    };
    const syncLaunchButton = () => {
      const button = launchButton();
      if (!button) return;
      const n = markedCount();
      button.textContent = launchLabel();
      button.disabled = !n;
      button.title = n ? '' : 'Никого не оставили — отметьте хотя бы одного';
    };
    dlg.foot.innerHTML = `
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="cancel">Отмена</button>
      ${canFixThenLaunch ? '<button class="btn secondary" data-act="fix">🛠 Исправить и запустить</button>' : ''}
      <button class="btn primary" data-act="launch">▶ Запустить</button>`;
    syncLaunchButton();
    dlg.body.addEventListener('change', syncLaunchButton);
    dlg.body.addEventListener('click', e => {
      const all = e.target.closest('[data-act="all"]');
      if (all) {
        for (const box of dlg.body.querySelectorAll('.prl-mcheck')) box.checked = true;
        syncLaunchButton();
        return;
      }
      const solo = /** @type {HTMLElement | null} */ (e.target.closest('[data-solo-id]'));
      if (solo) {
        // «Только этот» — это и запуск: второй клик по «Запустить» не нужен.
        const id = String(solo.dataset.soloId || '');
        if (readyIds.includes(id)) {
          answer = { action: 'launch', droppedIds: readyIds.filter(ready => ready !== id) };
          dlg.close();
          return;
        }
        // Отмеченного уже нет в списке готовых (pati изменилась) — не запускаем ничего
        // и оставляем окно открытым: пусть человек выберет заново.
        toastRow('Этот персонаж больше не в списке запуска — выберите другого');
      }
    });
    dlg.foot.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') {
        dlg.close();
        return;
      }
      if (act === 'launch' && !markedCount()) return; // защита от Enter по выключенной кнопке
      answer = { action: act === 'fix' ? 'fix' : 'launch', droppedIds: droppedNow() };
      dlg.close();
    });
  });
}

/** Подсказка внутри окна: красная строка над кнопками, без модального поверх модального. */
function toastRow(text) {
  const dlg = document.querySelector('.prl-dialog-note');
  if (dlg) {
    dlg.textContent = text;
    return;
  }
  const note = document.createElement('p');
  note.className = 'prl-dialog-note muted';
  note.textContent = text;
  const members = document.querySelector('.prl-members');
  if (members) members.appendChild(note);
}
