import { formatCoins } from '../../core/coins.js';
import { marathonPhase, computeCell } from '../marathons/model.js';
import { mskDate, mskStamp } from '../../core/msk.js';
const stamp = value => (Number.isFinite(Date.parse(value)) ? mskStamp(new Date(value)) : 'не проверялось');
const freshness = values => {
  const dates = values.map(Date.parse).filter(Number.isFinite);
  if (!dates.length) return 'Нет сохранённых проверок';
  return `⚠ последнее обновление: ${stamp(new Date(Math.min(...dates)).toISOString())}${dates.length < values.length ? '; часть данных не проверена' : ''}`;
};
/** Saved facts only. No network, launch, activation, or optimistic success inference. */
export function actionWidgetData(
  action,
  { characters = [], marathons = [], rosters = {}, shop = {}, reports = [], checking = {}, promos = null } = {}
) {
  const rows = [],
    result = { rows, note: 'Сохранённые данные, не проверка сайта в реальном времени.' };
  if (action === 'check-auth') {
    const known = characters.filter(c => c.lastLoginCheck),
      online = known.filter(c => c.isLoggedIn === true);
    result.summary = `Вход подтверждён: ${online.length}/${characters.length}; не проверено: ${characters.length - known.length}`;
    result.note = freshness(characters.map(c => c.lastLoginCheck));
    rows.push(
      ...characters.map(c => ({
        name: c.nick,
        detail:
          checking[c.id] === 'checking'
            ? 'Проверка…'
            : !c.lastLoginCheck
              ? 'Не проверено'
              : `${c.isLoggedIn ? 'Вход подтверждён' : 'Вход не подтверждён'} · ${stamp(c.lastLoginCheck)}`
      }))
    );
  } else if (action === 'update-balance') {
    const checked = characters.filter(c => c.lastCoinUpdate),
      total = checked.reduce((n, c) => n + (Number(c.ancientCoins) || 0), 0);
    result.summary = `${formatCoins(total)} монет по карточкам · проверено ${checked.length}/${characters.length}`;
    result.note = freshness(characters.map(c => c.lastCoinUpdate));
    rows.push(
      ...characters.map(c => ({
        name: c.nick,
        detail: c.lastCoinUpdate
          ? `${formatCoins(c.ancientCoins || 0)} · ${stamp(c.lastCoinUpdate)}`
          : 'Баланс не проверен'
      }))
    );
  } else if (action === 'update-marathons') {
    const ids = new Set(characters.map(c => c.id));
    const list = marathons.filter(
      m =>
        m.kind !== 'series' &&
        m.participantIds?.some(id => ids.has(id)) &&
        ['active', 'ended'].includes(marathonPhase(m, mskDate()))
    );
    result.summary = `Марафонов: ${list.length}`;
    for (const m of list) {
      let done = 0,
        total = 0;
      for (const cid of m.participantIds.filter(id => ids.has(id)))
        for (const task of m.tasks || []) {
          const cell = computeCell(m, cid, task.id);
          if (!cell.assigned) continue;
          total++;
          if (cell.state === 'done') done++;
        }
      rows.push({
        name: m.title,
        detail: `${marathonPhase(m) === 'ended' ? 'Ожидает завершения' : `До ${m.endDate || '—'}`} · участников в выборе: ${m.participantIds.filter(id => ids.has(id)).length} · заданий достигли цели: ${done}/${total}`,
        marathonId: m.id
      });
    }
    result.note = 'Отметки из приложения. Сверка с сайтом запускается отдельно.';
  } else if (action === 'transfer' || action === 'caravan') {
    const known = characters.filter(c => rosters[c.id]);
    result.summary = `Инвентари прочитаны: ${known.length}/${characters.length}`;
    result.note = freshness(characters.map(c => rosters[c.id]?.at));
    for (const c of characters) {
      const r = rosters[c.id];
      rows.push({
        name: c.nick,
        detail: !r
          ? 'Нет сохранённого инвентаря'
          : action === 'caravan'
            ? `Сундуков по последнему чтению: ${Number(r.pending?.chests) || 0} · ${stamp(r.at)}`
            : `Позиций к передаче: ${r.pending?.items?.length || 0} · ${stamp(r.at)}`
      });
    }
  } else if (action === 'shop') {
    const ids = new Set(characters.map(c => shop.charSite?.[c.id]).filter(Boolean));
    result.summary = `Известных аккаунтов магазина: ${ids.size}`;
    result.note = freshness([...ids].map(id => shop.accounts?.[id]?.at));
    for (const id of ids) {
      const account = shop.accounts?.[id];
      const names = characters
        .filter(c => shop.charSite?.[c.id] === id)
        .map(c => c.nick)
        .join(', ');
      rows.push({
        name: names,
        detail: account
          ? `${formatCoins(account.balance || 0)} монет · ${stamp(account.at)}`
          : 'Нет сохранённого чтения магазина'
      });
    }
  } else if (action === 'promo') {
    if (Array.isArray(promos)) {
      result.summary = `Сохранённых промокодов: ${promos.length}`;
      result.note = 'Данные из локального кеша. Сроки и награды проверьте в диалоге перед активацией.';
      rows.push(
        ...promos.map(p => ({
          name: p.code,
          detail: `Введён: ${p.entered}/${characters.length} · осталось: ${p.remaining}`
        }))
      );
    } else {
      result.summary = 'Содержимое промокодов скрыто до нажатия';
      result.note = 'Откройте промокоды для выбора кодов, наград и персонажей.';
    }
  }
  const kind = { promo: 'promo', transfer: 'transfer', shop: 'shop', caravan: 'caravan' }[action];
  const report = reports.find(r => r.kind === kind);
  if (report) {
    result.report = { ...report, rows: (report.rows || []).filter(r => characters.some(c => c.id === r.charId)) };
  }
  return result;
}
