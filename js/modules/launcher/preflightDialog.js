// js/modules/launcher/preflightDialog.js
// Экран «Проверка перед запуском»: кого запустим, кого пропустим и что стоит исправить.
// Логика проверок — preflight.js; сам запуск и исправление — partyLaunch.js. Окно только показывает итог и возвращает выбор:
//   'launch' — запустить как есть (проблемные пропускаются), 'fix' — исправить то, что можно, и запустить, null — отмена.

import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { availableFixes } from './preflight.js';

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
  if (pre.toLaunch.length) rows.push({ icon: '✅', level: 'ok', title: `Будут запущены: ${pre.toLaunch.length}`, text: names(pre.toLaunch) });
  if (pre.alreadyRunning.length) {
    rows.push({
      icon: '⏭', level: 'info', title: `Уже запущены, пропущу: ${pre.alreadyRunning.length}`,
      text: `${names(pre.alreadyRunning)}. Очередь сразу перейдёт к следующим; окно узнаётся по названию «Ник — Класс».`
    });
  }
  if (pre.noGc.length) {
    rows.push({
      icon: '❌', level: 'error', title: `Не указан GameCenter: ${pre.noGc.length}`,
      text: `${names(pre.noGc)}. Без него игру не запустить: эти персонажи будут пропущены.`
    });
  }
  if (pre.noSavedLogin.length && pre.toLaunch.length > 1) {
    rows.push({
      icon: '⚠️', level: 'warn', title: `Вход в GameCenter не запомнен: ${pre.noSavedLogin.length}`,
      text: `${names(pre.noSavedLogin)}. Их окна откроются под тем аккаунтом, который сейчас выбран в GameCenter, — у нескольких персонажей это будет один и тот же аккаунт. `
        + 'Запомнить вход: карточка персонажа → «🎮 Запуск игры» → «🔑 Запомнить текущий вход GameCenter».'
    });
  }
  if (pre.adminMismatch) {
    rows.push({
      icon: '🔐', level: 'warn', title: `Окна игры от администратора: ${pre.elevatedClients}`,
      text: 'Windows не даст подписать такие окна (название и значок) и закрыть их из обычной Твинофермы. '
        + 'Нажмите «🛠 Исправить и запустить» — Windows один раз спросит разрешение, и помощник сделает это от администратора. '
        + 'Приложение при этом не перезапускается и остаётся обычным. '
        + 'Постоянный запуск от администратора: ПКМ по ярлыку → «Запуск от имени администратора».'
    });
  }
  if (pre.siteNoLogin.length) {
    rows.push({
      icon: 'ℹ️', level: 'info', title: `Нет входа на сайт: ${pre.siteNoLogin.length}`,
      text: `${names(pre.siteNoLogin)}. На запуск игры это не влияет, но скрипты сайта (промокоды, подарки, сундуки) у них не сработают.`
    });
  }
  if (!pre.runningKnown) {
    rows.push({ icon: 'ℹ️', level: 'info', title: 'Не удалось узнать, какие окна уже запущены', text: 'Запущенные окна не пропускаются: возможны дубли.' });
  } else {
    if (!pre.decorate) rows.push({ icon: 'ℹ️', level: 'info', title: 'Запущенные окна не распознаются', text: 'Включите «Подписывать окна игры» в настройках: по названию «Ник — Класс» Твиноферма узнаёт, кто уже в игре.' });
    else if (pre.unknownClients) rows.push({ icon: 'ℹ️', level: 'info', title: `Окон игры не из Твинофермы: ${pre.unknownClients}`, text: 'Их нельзя сопоставить с персонажами, поэтому они не учитываются.' });
  }
  return rows;
}

/**
 * Показывает экран и ждёт выбора.
 * @param {import('./preflight.js').Preflight} pre
 * @param {{ title?: string, gameCenters?: Array<{ id: string, name: string }> }} [opts]
 * @returns {Promise<'launch' | 'fix' | null>}
 */
export function openPreflight(pre, { title = '', gameCenters = [] } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const dlg = openOverlay({ title: '🧭 Проверка перед запуском', wide: true, onClose: () => resolve(answer) });
    const fixes = availableFixes(pre, { gameCenters });
    dlg.sub.textContent = title || '';
    dlg.body.innerHTML = `<div class="prl-list">${preflightRows(pre).map(r => `
      <div class="prl-row prl-${r.level}"><span class="prl-ico">${r.icon}</span>
        <div><b>${escapeHtml(r.title)}</b>${r.text ? `<div class="muted">${escapeHtml(r.text)}</div>` : ''}</div></div>`).join('')}</div>
      ${fixes.length ? `<div class="prl-fix">🛠 «Исправить и запустить»: ${fixes.map(f => escapeHtml(f.text)).join('; ')}.</div>` : ''}`;
    const n = pre.toLaunch.length;
    const canFixThenLaunch = fixes.length > 0;
    dlg.foot.innerHTML = `
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="cancel">Отмена</button>
      ${canFixThenLaunch ? '<button class="btn secondary" data-act="fix">🛠 Исправить и запустить</button>' : ''}
      <button class="btn primary" data-act="launch" ${n ? '' : 'disabled'} title="${n ? '' : 'Запускать некого'}">▶ Запустить${n ? ` (${n})` : ''}</button>`;
    dlg.foot.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'cancel') { dlg.close(); return; }
      answer = act === 'fix' ? 'fix' : 'launch';
      dlg.close();
    });
  });
}
