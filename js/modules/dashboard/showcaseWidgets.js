// Read-only projections: no contacts, network operations, or guesses about live game windows.
import { escapeHtml as esc } from '../../core/utils.js';
import { formatCoins, needsCoinRecheck } from '../../core/coins.js';
import { formatAmount } from '../finance/model.js';
import { mskAddDays, mskStamp } from '../../core/msk.js';
import { getClassIconSrcByStem } from '../../core/constants.js';
import { plannerEventsForDate } from './planner.js';
import { widgetIcon } from './widgetCatalog.js';

const checked = value => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
const timeLabel = value => (checked(value) ? mskStamp(new Date(value)) : 'не проверено');
const countLogin = chars => chars.filter(c => c.auth === 'online').length;
const header = (id, title, label = '') =>
  `<div class="rt-heading"><span class="rt-widget-icon" aria-hidden="true">${widgetIcon(id)}</span><h3>${title}</h3>${label ? `<small>${esc(label)}</small>` : ''}</div>`;
const active = s => (s.characters || []).filter(c => c && !c.archived);
const loginLabel = c => {
  if (!['online', 'offline'].includes(c.auth)) return 'Вход на сайт: не проверен';
  return `Вход на сайт: ${c.auth === 'online' ? 'подтверждён' : 'не подтверждён'}${c.lastLoginCheck ? ` · ${timeLabel(c.lastLoginCheck)}` : ' · пример'}`;
};
const icon = c =>
  /^[a-z0-9_-]+$/i.test(c.icon || '')
    ? `<img src="${esc(getClassIconSrcByStem(c.icon))}" alt="" aria-hidden="true">`
    : '';
const coinLabel = (c, demo) => {
  if ((!checked(c.lastCoinUpdate) && !demo) || typeof c.coins !== 'number' || !Number.isFinite(c.coins) || c.coins < 0)
    return 'Монеты: не проверены';
  if (!demo && needsCoinRecheck(c)) return `Монеты: ${formatCoins(c.coins)} · требуется перепроверка`;
  return `Монеты: ${formatCoins(c.coins)} · ${demo ? 'пример' : timeLabel(c.lastCoinUpdate)}`;
};

export function renderShowcaseWidgets(s, { demo = false } = {}) {
  const chars = active(s);
  const charsHtml = chars
    .map(
      c =>
        `<li>${icon(c)}<span class="rt-people-copy"><b>${esc(c.nick || 'Без имени')}</b><small>${esc(c.className || 'Класс не указан')}</small><small>${esc(loginLabel(c))}</small><small>${esc(coinLabel(c, demo))}</small></span></li>`
    )
    .join('');
  const partiesHtml = (s.parties || [])
    .map(p => {
      const members = chars.filter(c => c.party === p.id || (Array.isArray(c.partyIds) && c.partyIds.includes(p.id)));
      return `<li><span class="rt-people-copy"><b>${esc(p.label || p.name || 'Без названия')}</b><small>Вход на сайт подтверждён: ${countLogin(members)}/${members.length} по последней проверке</small><small>${esc(members.map(c => c.nick || 'Без имени').join(', ') || 'Нет персонажей')}</small></span></li>`;
    })
    .join('');
  const knownCoins = chars.filter(
    c =>
      checked(c.lastCoinUpdate) &&
      typeof c.coins === 'number' &&
      Number.isFinite(c.coins) &&
      c.coins >= 0 &&
      !needsCoinRecheck(c)
  ).length;
  const amount = (currency, value) =>
    typeof value === 'number' && Number.isFinite(value) ? formatAmount(currency, value) : 'Нет данных';
  const fact = (label, value) => `<div><small>${label}</small><b>${esc(value)}</b></div>`;
  const planner = s.plannerState || {
    plannerEntries: (s.calendarEvents || []).map(e => ({ ...e, kind: e.kind || (e.time ? 'event' : 'task') })),
    marathons: []
  };
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const date = mskAddDays(s.day.date, i);
    for (const event of plannerEventsForDate(planner, date)) {
      if (event.kind === 'task' && event.status === 'done') continue;
      // An ongoing marathon is not a new event every day; retain its start/end.
      if (event.source === 'marathon' && event.phase === 'active') continue;
      rows.push({ ...event, date });
    }
  }
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time || '99:99').localeCompare(b.time || '99:99') ||
      String(a.title).localeCompare(String(b.title), 'ru')
  );
  const top = rows.slice(0, 8);
  const upcoming = top
    .map(e => {
      const day = new Date(`${e.date}T12:00:00Z`).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
        weekday: 'short',
        timeZone: 'Europe/Moscow'
      });
      const kind =
        e.source === 'marathon'
          ? e.phase === 'end'
            ? 'Конец марафона'
            : 'Начало марафона'
          : e.kind === 'task'
            ? 'Дело'
            : e.source === 'recurring'
              ? 'По расписанию'
              : 'Событие';
      return `<li><time datetime="${esc(e.date)}">${esc(day)}</time><span class="rt-people-copy"><b>${esc(e.title || 'Без названия')}</b><small>${esc(kind)} · ${esc(e.time || 'в течение дня')}${e.endTime ? `–${esc(e.endTime)}` : ''}${e.status === 'doing' ? ' · в работе' : ''}</small></span></li>`;
    })
    .join('');
  return `<section class="lg-panel rt-characters rt-showcase" hidden>${header('characters', 'Персонажи', `${chars.length} карточек`)}<p class="rt-showcase-note">Последние сохранённые проверки сайта, не онлайн в игре.</p><ul class="rt-people-list">${charsHtml || '<li>Персонажей пока нет.</li>'}</ul></section>
  <section class="lg-panel rt-parties rt-showcase" hidden>${header('parties', 'Пати', `${(s.parties || []).length}`)}<p class="rt-showcase-note">Состав включает основные и дополнительные пати.</p><ul class="rt-people-list">${partiesHtml || '<li>Пати пока не созданы.</li>'}</ul></section>
  <section class="lg-panel rt-finance rt-showcase" hidden>${header('finance', 'Финансы')}<p class="rt-showcase-note">Остатки по записям раздела «Банк», не проверка игрового баланса.</p><div class="rt-finance-grid">${fact('Золото', amount('gold', s.day.gold))}${fact('Голд', amount('coins', s.day.bank))}</div><p class="rt-showcase-note">${demo ? 'Древние монеты по карточкам: пример.' : `Древние монеты по карточкам: проверено ${knownCoins}/${chars.length}.`} Общие аккаунты не суммируются.</p></section>
  <section class="lg-panel rt-upcoming rt-showcase" hidden>${header('upcoming', 'Ближайшие события', '7 дней · МСК')}<ul class="rt-upcoming-list">${upcoming || '<li>На ближайшую неделю записей нет.</li>'}</ul>${rows.length > top.length ? `<small>Показано ${top.length} из ${rows.length}; остальные — в календаре.</small>` : ''}<button type="button" class="lg-button" data-today-action="calendar">Открыть календарь ↗</button></section>`;
}
