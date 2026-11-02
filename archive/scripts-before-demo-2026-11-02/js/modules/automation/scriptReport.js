// Общий, сериализуемый отчёт скрипта. Здесь только сведения из ответов сайта:
// выбранное, подтверждённое и неясное не смешиваются друг с другом.
import { errorText } from '../../core/errorCodes.js';
import { formatCoins } from '../../core/coins.js';
import { rowLabel as promoLabel, statusInfo as promoStatus, rewardLine } from './promoCore.js';
import { rowLabel as transferLabel, statusInfo as transferStatus, totalsText } from './transferCore.js';
import { rowLabel as caravanLabel, statusInfo as caravanStatus, chestStateLabel } from './caravanCore.js';
import { resultLabel as shopLabel, resultInfo as shopStatus } from './shopCore.js';

export const SCRIPT_REPORT_TITLES = {
  promo: 'Промокоды',
  transfer: 'Передача предметов',
  shop: 'Активация подарков',
  caravan: 'Сундуки караванщика'
};

// Не переносим в журнал случайно попавшие в ответы адреса, параметры ссылок или секреты.
const safeText = value => {
  const text = String(value ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[адрес скрыт]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[параметры скрыты]')
    .replace(/(?:\b(?:password|passwd|token|cookie|authorization)|пароль|токен)\s*[:=]\s*[^\s,;]+/gi, '[секрет скрыт]');
  return text.length > 2000 ? `${text.slice(0, 2000)}… (список сокращён)` : text;
};
const detailsOf = (...values) => values.flat().filter(Boolean).map(safeText);
const base = row => ({
  charId: String(row.charId || ''),
  nick: String(row.nick || 'Без имени'),
  context: '',
  action: '',
  status: '',
  tone: 'info',
  details: []
});
const itemText = items => totalsText(Array.isArray(items) ? items : []);

function promoRow(row) {
  const result = base(row);
  result.action = `Промокод ${row.code || '—'}`;
  result.status = promoLabel(row);
  result.tone = promoStatus(row.status).level;
  result.details = detailsOf(
    row.skipped && row.status === 'unknown' ? 'Предыдущий ответ неясен; повторно не вводился.' : '',
    row.skipped && ['success', 'already_used'].includes(row.status) ? 'Код уже был введён; повторно не вводился.' : '',
    row.status === 'success' && !row.skipped && row.rewards?.length
      ? `Награда по ответу сайта: ${row.rewards.map(rewardLine).join('; ')}`
      : '',
    row.status === 'success' && !row.skipped && !row.rewards?.length ? 'Состав награды в ответе сайта не указан.' : '',
    row.status === 'already_used' ? 'Состав ранее полученной награды для этого персонажа неизвестен.' : '',
    row.status === 'unknown' || row.uncertain ? 'Итог не подтверждён: проверьте на сайте перед повтором.' : '',
    row.detail,
    row.error ? errorText(row.error) : ''
  );
  return result;
}

function transferRow(row) {
  const result = base(row);
  result.context = [row.server, row.recipient].filter(Boolean).join(' → ');
  result.action = 'Передача подарков в игру';
  result.status = transferLabel(row);
  result.tone = transferStatus(row.status).level;
  const confirmed = ['success', 'partial'].includes(row.status) ? itemText(row.done) : '';
  const missing = row.status === 'partial' ? itemText(row.missing) : '';
  const unconfirmed = row.status === 'unknown' || row.uncertain || (row.clicked && row.status === 'error');
  const planned = (row.dryRun || unconfirmed) && row.items?.length ? itemText(row.items) : '';
  result.details = detailsOf(
    confirmed ? `Записано в истории передачи: ${confirmed}` : '',
    confirmed ? 'Запись на сайте не подтверждает получение предметов в игре.' : '',
    missing ? `Не найдено в истории передачи: ${missing}` : '',
    row.dryRun && planned ? `Выбрано для пробной проверки, не передано: ${planned}` : '',
    !row.dryRun && unconfirmed && planned ? `Выбрано, но результат не подтверждён: ${planned}` : '',
    unconfirmed ? 'Сверьте историю на сайте: действие могло выполниться, повтор заблокирован.' : '',
    row.limited?.length ? `Не отмечалось из-за ограничений: ${itemText(row.limited)}` : '',
    row.status === 'error' && row.error ? errorText(row.error) : ''
  );
  return result;
}

function shopRow(row) {
  const result = base(row);
  result.context = detailsOf(
    'Общий аккаунт сайта',
    row.members?.length ? `Персонажи: ${row.members.join(', ')}` : ''
  ).join(' · ');
  result.action = `Покупка: ${row.item || row.itemKey || 'предмет'}`;
  result.status = shopLabel(row);
  result.tone = shopStatus(row.status).level;
  result.details = detailsOf(
    row.bought > 0 ? `Подтверждено покупок: ${row.bought}; потрачено ${formatCoins(row.spent || 0)} мон.` : '',
    row.dryRun ? 'Пробный запуск: ничего не куплено.' : '',
    row.status === 'unknown' || row.retryBlocked
      ? 'Один из результатов не подтверждён; проверьте «Историю монет» до повторения.'
      : '',
    row.viaHistory ? `Подтверждено по истории монет: ${row.viaHistory}` : '',
    row.detail,
    row.code ? errorText(row.code) : '',
    'Покупка относится к общему аккаунту сайта; зачисление каждому персонажу отдельно не подтверждается.'
  );
  return result;
}

function caravanRow(row) {
  const result = base(row);
  result.action = 'Сундуки караванщика';
  result.status = caravanLabel(row);
  result.tone = caravanStatus(row.status).level;
  const chests = (row.chests || []).map(chest => {
    const items = chest.items?.length ? chest.items.join('; ') : 'состав не указан';
    const state = chestStateLabel(chest.state);
    return `Сундук №${chest.cartId || '?'}: ${state}; предметы: ${items}`;
  });
  result.details = detailsOf(
    row.dryRun ? 'Пробный запуск: ничего не открыто и не передано.' : '',
    row.status === 'unknown' ? 'Итог нажатия не подтверждён; проверьте инвентарь на сайте.' : '',
    chests,
    row.error ? errorText(row.error) : '',
    row.detail
  );
  return result;
}

/** Снимок выбранных полей; данные аккаунтов не включаются, текст сайта дополнительно очищается. */
export function makeScriptReport(kind, rows = [], { dryRun = false } = {}) {
  const convert = { promo: promoRow, transfer: transferRow, shop: shopRow, caravan: caravanRow }[kind];
  if (!convert) return null;
  return {
    version: 1,
    kind,
    title: SCRIPT_REPORT_TITLES[kind],
    dryRun: !!dryRun,
    rows: (Array.isArray(rows) ? rows : []).filter(Boolean).flatMap(row => {
      const result = convert(row);
      result.nick = safeText(result.nick);
      result.context = safeText(result.context);
      result.action = safeText(result.action);
      result.status = safeText(result.status);
      if (kind !== 'shop' || !row.memberChars?.length) return [result];
      // На всех персонажах общего аккаунта показываем одну и ту же ссылку на покупку,
      // а не утверждение, что отдельная покупка была у каждого.
      const members = row.memberChars.filter(member => member?.nick);
      if (!members.some(member => member.id === row.charId)) members.unshift({ id: row.charId, nick: row.nick });
      const seen = new Set();
      return members
        .filter(member => {
          const key = member.id || member.nick;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(member => ({
          ...result,
          charId: String(member.id || ''),
          nick: safeText(member.nick),
          details: [...result.details, 'Это общий результат аккаунта, а не отдельная покупка этого персонажа.']
        }));
    })
  };
}
