import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { classIconHtml } from './characterPicker.js';
import { SHOP_ITEMS, limitView } from './shopCore.js';
import { charSiteMap, getAccount } from './shopStore.js';

export function openShopLimits() {
  const dlg = openOverlay({ title: 'Лимиты подарков по персонажам', wide: true });
  const sites = charSiteMap();
  dlg.sub.textContent =
    'Последние прочитанные данные сайта. У персонажей одного аккаунта лимит общий, не суммируется. Дата ниже — обновление лимита, а не срок самого предмета.';
  dlg.body.innerHTML = `<div class="promo-scroll"><table class="promo-table shop-limits-table"><thead><tr><th>Персонаж / аккаунт</th><th>Предмет</th><th>Доступно</th><th>Когда обновится</th></tr></thead><tbody>${[
    ...state.characters
  ]
    .sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'ru'))
    .map(c => {
      const account = getAccount(sites[c.id]);
      const limited = SHOP_ITEMS.filter(def => {
        const item = account?.items[def.key];
        return item?.found && limitView(item, account?.tracks[def.key]);
      });
      return limited
        .map((def, index) => {
          const item = account?.items[def.key];
          const track = account?.tracks[def.key];
          const limit = limitView(item, track);
          const availability = `${limit.available}${limit.max ? ` из ${limit.max}` : ''}`;
          const reset = !limit
            ? '—'
            : limit.resetAt
              ? new Date(limit.resetAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' мск'
              : track?.resetAt && Date.parse(track.resetAt) <= Date.now()
                ? 'Срок обновления прошёл — перечитайте сайт'
                : 'Дата неизвестна — сайт её не сообщил';
          return `<tr>${index === 0 ? `<td rowspan="${limited.length}">${classIconHtml(c)} <b>${escapeHtml(c.nick)}</b><small>${escapeHtml(account?.account || 'Аккаунт не проверен')}</small><small>${account?.at ? `Проверено: ${escapeHtml(new Date(account.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} мск` : 'Нет данных сайта'}</small></td>` : ''}<td>${escapeHtml(def.name)}</td><td>${escapeHtml(availability)}</td><td>${escapeHtml(reset)}</td></tr>`;
        })
        .join('');
    })
    .join(
      ''
    )}</tbody></table></div><p class="shop-muted">Показаны только найденные на сайте предметы с явно указанным лимитом. Если таблица пуста — таких данных пока нет; обновите магазин.</p>`;
  dlg.foot.innerHTML = '<button type="button" class="btn primary" data-close-limits>Закрыть</button>';
  dlg.foot.querySelector('[data-close-limits]').onclick = () => dlg.close();
  return dlg;
}
