import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { classIconHtml } from './characterPicker.js';
import { SHOP_ITEMS, limitView } from './shopCore.js';
import { charSiteMap, getAccount } from './shopStore.js';

// Reading only. Refresh uses the shop's existing grouped scanner (never purchase).
export function openShopLimits({ refresh } = {}) {
  const dlg = openOverlay({ title: 'Лимиты подарков по персонажам', wide: true });
  let busy = false;
  dlg.sub.textContent =
    'У персонажей одного аккаунта лимит общий. «Доступно: N из Х»: N — остаток, Х — указанный сайтом лимит. Если Х не указан, максимум — наибольший прочитанный остаток этого предмета среди аккаунтов. Дата — обновление лимита, не срок предмета.';
  dlg.body.innerHTML = `<div class="shop-quick"><label>Поиск<input class="input" type="search" data-limits-search placeholder="Ник, класс или аккаунт"></label><label>Предмет<select class="input" data-limits-item><option value="">Все предметы</option>${SHOP_ITEMS.map(d => `<option value="${d.key}">${esc(d.name)}</option>`).join('')}</select></label><label>Лимит<select class="input" data-limits-filter><option value="all">Все</option><option value="maximum">Максимум</option><option value="below">Меньше максимума</option><option value="exhausted">Исчерпано</option><option value="unknown">Нет данных</option><option value="reset">Есть дата обновления</option></select></label></div><p data-limits-status role="status"></p><div class="promo-scroll"><table class="promo-table shop-limits-table"><thead><tr><th>Персонаж / аккаунт</th><th>Предмет</th><th>Доступно</th><th>Когда обновится</th></tr></thead><tbody></tbody></table></div>`;
  dlg.foot.innerHTML =
    '<button type="button" class="btn ghost" data-close-limits>Закрыть</button><span class="sd-foot-spacer"></span><button type="button" class="btn primary" data-refresh-limits>Обновить информацию по лимитам</button>';
  const q = selector => dlg.body.querySelector(selector);
  const render = () => {
    const sites = charSiteMap(),
      filter = q('[data-limits-filter]').value,
      key = q('[data-limits-item]').value;
    const query = q('[data-limits-search]').value.trim().toLocaleLowerCase('ru');
    const rows = [];
    for (const c of [...state.characters].sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'ru'))) {
      const account = getAccount(sites[c.id]);
      if (query && ![c.nick, c.class, account?.account].join(' ').toLocaleLowerCase('ru').includes(query)) continue;
      const defs = SHOP_ITEMS.filter(d => !key || d.key === key);
      const cells = defs
        .filter(d => {
          const limit = limitView(account?.items[d.key], account?.tracks[d.key]);
          return (
            filter === 'all' ||
            (filter === 'unknown' && !limit) ||
            (filter === 'reset' && Number.isFinite(Date.parse(account?.tracks[d.key]?.resetAt))) ||
            (limit &&
              ((filter === 'maximum' && limit.max != null && limit.available === limit.max) ||
                (filter === 'below' && limit.max != null && limit.available < limit.max) ||
                (filter === 'exhausted' && limit.available === 0)))
          );
        })
        .map(def => {
          const limit = limitView(account?.items[def.key], account?.tracks[def.key]);
          const available = limit
            ? `Доступно: ${limit.available}${limit.max != null ? ` из ${limit.max}${limit.maxSource === 'observed' ? ' (максимум наблюдений)' : ''}` : ''}`
            : 'Нет данных';
          const reset = limit?.resetAt
            ? new Date(limit.resetAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' мск'
            : account?.tracks[def.key]?.resetAt && Date.parse(account.tracks[def.key].resetAt) <= Date.now()
              ? 'Срок обновления прошёл — перечитайте сайт'
              : 'Дата не указана';
          return `<td>${esc(def.name)}</td><td>${esc(available)}</td><td>${esc(reset)}</td>`;
        });
      cells.forEach((cell, index) =>
        rows.push(
          `<tr>${index === 0 ? `<td rowspan="${cells.length}">${classIconHtml(c)} <b>${esc(c.nick)}</b><small>${esc(account?.account || 'Аккаунт не проверен')}</small><small>${account?.at ? 'Проверено: ' + esc(new Date(account.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })) + ' мск' : 'Нет данных сайта'}</small></td>` : ''}${cell}</tr>`
        )
      );
    }
    q('tbody').innerHTML = rows.join('');
    if (!busy)
      q('[data-limits-status]').textContent = rows.length
        ? `Строк: ${rows.length}. Поиск и фильтры не меняют выбор в магазине.`
        : 'По выбранным фильтрам ничего не найдено.';
  };
  dlg.body.addEventListener('input', e => {
    if (e.target.matches('[data-limits-search]')) render();
  });
  dlg.body.addEventListener('change', render);
  dlg.foot.querySelector('[data-close-limits]').onclick = () => dlg.close();
  const button = dlg.foot.querySelector('[data-refresh-limits]');
  button.disabled = typeof refresh !== 'function';
  button.onclick = async () => {
    if (busy || typeof refresh !== 'function') return;
    busy = true;
    button.disabled = true;
    q('[data-limits-status]').textContent = 'Читаем лимиты аккаунтов с сайта…';
    try {
      await refresh();
      if (dlg.el.isConnected) {
        busy = false;
        render();
        q('[data-limits-status]').textContent +=
          ' Проверка завершена; для недоступных аккаунтов сохранены прежние данные и их дата.';
      }
    } catch {
      if (dlg.el.isConnected)
        q('[data-limits-status]').textContent =
          'Не удалось обновить сейчас: возможно, другая проверка ещё идёт. Прежние данные и фильтры сохранены.';
    } finally {
      busy = false;
      button.disabled = false;
    }
  };
  render();
  return dlg;
}
