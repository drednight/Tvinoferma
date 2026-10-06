// js/modules/automation/shopLogView.js
// Логи покупок за Древние монеты как вид логов единого модуля (core/logHub.js, «Настройки → Журналы»).
// Журнал один на всех персонажей (последние 300 записей); отобрать один аккаунт можно поиском по нику.
// Запись: время, аккаунт и ник, предмет, сколько куплено из запрошенного и чем закончилось; нажатие открывает подробности.

import { escapeHtml } from '../../core/utils.js';
import { formatCoins } from '../../core/coins.js';
import { registerLogSource, openLogHub } from '../../core/logHub.js';
import { errorText } from '../../core/errorCodes.js';
import { openOverlay } from '../marathons/overlay.js';
import { resultInfo, resultLabel } from './shopCore.js';
import { loadShopLog, clearShopLog } from './shopStore.js';

const when = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const fmt = (n) => formatCoins(n);
const entryKey = (e) => `${e.at}|${e.charId}|${e.itemKey}`;
const others = (e) => (e.members || []).filter(n => n !== e.nick);

const detailText = (e) => [e.detail, e.status === 'error' || e.status === 'unknown' ? errorText(e.code) : ''].filter(Boolean).join(' — ');

export function detailsHtml(e) {
  const info = resultInfo(e.status);
  const bal = e.balanceBefore != null && e.balanceAfter != null ? `${fmt(e.balanceBefore)} → ${fmt(e.balanceAfter)} мон.` : '';
  return `
    <div class="tl-summary"><span>🪙 <b>${escapeHtml(e.nick)}</b>${others(e).length ? ` <span class="muted">(также: ${escapeHtml(others(e).join(', '))})</span>` : ''}</span><span class="muted">${escapeHtml(when(e.at))}</span></div>
    <div class="promo-log-h">${info.icon} ${escapeHtml(resultLabel(e))}</div>
    <ul class="promo-log-list">
      <li>Предмет: ${escapeHtml(e.item)}</li>
      <li>Запрошено: ${e.requested}, куплено: ${e.bought}${e.price != null ? `, цена ${fmt(e.price)} мон.` : ''}</li>
      <li>Потрачено: ${fmt(e.spent)} мон.${bal ? ` (баланс по ходу покупки: ${escapeHtml(bal)})` : ''}</li>
      ${e.account ? `<li>Аккаунт сайта: ${escapeHtml(e.account)}</li>` : ''}
      ${e.viaHistory ? `<li>Подтверждено по «Истории монет»: ${e.viaHistory}</li>` : ''}
    </ul>
    ${detailText(e) ? `<div class="muted">${escapeHtml(detailText(e))}</div>` : ''}
    ${['unknown', 'no_effect', 'error'].includes(e.status) ? '<p class="promo-warn">Сверьте с «Историей монет» на сайте (chests2.php?do=history): приложение само ничего не повторяет, чтобы не купить предмет дважды.</p>' : ''}`;
}

const entryText = (e) => [
  `${when(e.at)} · ${e.nick}${others(e).length ? ` (также: ${others(e).join(', ')})` : ''} · ${e.item}`,
  resultLabel(e),
  `Потрачено: ${fmt(e.spent)} мон.`,
  ...(detailText(e) ? [detailText(e)] : [])
].join('\n');

/** Окно с подробностями одной записи. */
export function openShopEntry(index) {
  const e = loadShopLog()[index];
  if (!e) return null;
  const ov = openOverlay({ title: '🪙 Покупка за Древние монеты', wide: true });
  ov.body.innerHTML = detailsHtml(e);
  ov.foot.innerHTML = '<span></span><div class="row gap"><button type="button" class="btn" data-copy>📋 Скопировать</button><button type="button" class="btn primary" data-close>Закрыть</button></div>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  ov.foot.querySelector('[data-copy]').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(entryText(e)); ev.target.textContent = '✔ Скопировано'; }
    catch { ev.target.textContent = 'Не удалось скопировать'; }
  };
  return ov;
}

/** Вид логов «Покупки» в едином модуле логов (logHub.js). */
export const shopLogSource = {
  id: 'shop',
  title: 'Покупки',
  icon: '🪙',
  list: () => loadShopLog().map(e => ({
    key: entryKey(e), at: e.at, title: `${e.item} · ${e.bought} из ${e.requested}`,
    status: e.status === 'done' ? 'ok' : resultInfo(e.status).level === 'error' ? 'error' : 'warn',
    who: e.nick,
    summary: `${fmt(e.spent)} мон.${e.status === 'done' ? '' : ` · ${resultInfo(e.status).label}`}${others(e).length ? ` · также: ${others(e).join(', ')}` : ''}${e.account ? ` · ${e.account}` : ''}`
  })),
  open: (item) => {
    const i = loadShopLog().findIndex(e => entryKey(e) === item.key);
    if (i >= 0) openShopEntry(i);
  },
  clear: () => clearShopLog(),
  clearConfirm: 'Очистить журнал покупок? Приложение забудет, что и когда покупалось. На сайте «История монет» останется.',
  subscribe: (fn) => { window.addEventListener('tf-shop-log', fn); return () => window.removeEventListener('tf-shop-log', fn); }
};
registerLogSource(shopLogSource);

/** Окно со всеми покупками (кнопка «Журнал» в диалоге): единый журнал, вид «Покупки». */
export function openShopLog() {
  return openLogHub({ source: 'shop', title: '📜 Журнал покупок' });
}
