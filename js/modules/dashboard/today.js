// js/modules/dashboard/today.js
// Данные экрана «Сегодня» (Issue #39): что требует внимания, что делать в марафонах и какие запасы.
//
// Зачем: приложение открывается на списке карточек, а главный вопрос пользователя — «что мне делать
// сегодня?» — нигде не задан. Здесь из уже имеющихся данных собираются три списка.
//
// Модуль без DOM: на вход состояние и время, на выход строки. Поэтому он покрыт тестами.

import { freshnessOf } from '../../core/freshness.js';
import { marathonPhase, computeCell } from '../marathons/model.js';
import { isTaskActiveOnDate, getAllDatesInRange } from '../marathons/dates.js';
import { charactersInParty, NO_PARTY_LABEL, hasNoParty } from '../parties/membership.js';

/** Сегодняшняя дата в виде «ГГГГ-ММ-ДД» (местное время, как в остальном приложении). */
export function todayStr(now = new Date()) {
  return now.toLocaleDateString('sv');
}

/** Сколько дней до даты (отрицательное — дата прошла). */
export function daysUntil(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const end = new Date(`${dateStr}T00:00:00`).getTime();
  const today = new Date(`${todayStr(now)}T00:00:00`).getTime();
  if (Number.isNaN(end)) return null;
  return Math.round((end - today) / 86400000);
}

/** Склонение: 1 день, 2 дня, 5 дней. */
export function daysWord(n) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = Math.abs(n) % 10;
  if (mod100 > 10 && mod100 < 20) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

/** Короткая подпись о сроке марафона: «осталось 3 дня», «последний день». */
export function phaseHintText(m, now = new Date()) {
  const days = daysUntil(m?.endDate, now);
  if (days === null) return 'без даты окончания';
  if (days < 0) return 'срок прошёл';
  if (days === 0) return 'последний день';
  return `осталось ${days} ${daysWord(days)}`;
}

/**
 * Назначено ли задание персонажу.
 *
 * Отличается от `model.isAssigned` намеренно: пустой или отсутствующий список назначений означает
 * «все задания» — так же его понимает миграция марафонов (`migrateMarathon`). Без этого марафон
 * с незаполненными назначениями выглядел бы так, будто персонажу ничего не задано, и экран «Сегодня»
 * не показал бы отставание.
 */
export function taskAssigned(m, charId, taskId) {
  if (!(m?.participantIds || []).includes(charId)) return false;
  const list = m?.assignments?.[charId];
  if (!Array.isArray(list) || !list.length) return (m.tasks || []).some(t => t.id === taskId);
  return list.includes(taskId);
}

/**
 * Итог персонажа в марафоне на сегодня: отстаёт ли он и всё ли выполнил.
 * Считаются только задания, активные по расписанию в этот день.
 */
export function characterMarathonProgress(m, charId, now = new Date()) {
  const date = todayStr(now);
  // `isTaskActiveOnDate` сверяет дату со всем диапазоном марафона, поэтому его нужно передать
  const allDates = m?.startDate && m?.endDate ? getAllDatesInRange(m.startDate, m.endDate) : [];
  const tasks = (m?.tasks || []).filter(t => isTaskActiveOnDate(t, date, allDates) && taskAssigned(m, charId, t.id));
  let expected = 0;
  let actual = 0;
  for (const task of tasks) {
    const cell = computeCell(m, charId, task.id, date);
    const target = Number(task.targetChecks) || 0;
    expected += target;
    actual += Math.min(Number(cell?.count) || 0, target);
  }
  return {
    tasks: tasks.length,
    expected,
    actual,
    // Отстаёт, если выполнено меньше, чем нужно к сегодняшнему дню. Запас считается по дням:
    // если у персонажа ещё есть время, «отстаёт» не показываем.
    behind: expected > 0 && actual < expected,
    allDone: tasks.length > 0 && expected > 0 && actual >= expected
  };
}

/**
 * Прогресс по идущим марафонам: сколько персонажей отстаёт и сколько всё выполнили.
 * @returns {Array<{ id: string, title: string, participants: number, done: number, behind: number, hint: string, tasks: number, endDate: string|null }>}
 */
export function marathonProgress(state, { now = new Date() } = {}) {
  const date = todayStr(now);
  const out = [];
  for (const m of state?.marathons || []) {
    if (m.kind === 'series') continue;
    // Считаем только идущие: завершённые и будущие действий не требуют
    if (marathonPhase(m, date) !== 'active') continue;
    const participants = (m.participantIds || []).filter(id => (state.characters || []).some(c => c.id === id));
    let behind = 0;
    let done = 0;
    for (const charId of participants) {
      const snapshot = characterMarathonProgress(m, charId, now);
      if (snapshot.behind) behind++;
      if (snapshot.allDone) done++;
    }
    out.push({
      id: m.id,
      title: m.title || 'Марафон',
      participants: participants.length,
      done,
      behind,
      hint: phaseHintText(m, now),
      tasks: (m.tasks || []).length,
      endDate: m.endDate || null
    });
  }
  return out.sort((a, b) => a.hint.localeCompare(b.hint, 'ru') || a.title.localeCompare(b.title, 'ru'));
}

/**
 * Что требует внимания: истёкшие сессии, отставания в марафонах, давно не проверенный баланс.
 *
 * Строка появляется, только если есть что делать. Порядок — от самого срочного: сначала вход
 * (без него не работает ничего), затем марафоны с дедлайном, затем баланс.
 *
 * @returns {Array<{ id: string, kind: string, title: string, text: string, tone: string, charId?: string, action: string, actionLabel: string, marathonId?: string }>}
 */
export function attentionItems(state, { now = new Date() } = {}) {
  const settings = state?.settings || {};
  const out = [];

  for (const c of state?.characters || []) {
    // Запись без id — это не персонаж (мусор после ручной правки файла): пропускаем,
    // а не показываем строку «undefined» и не падаем всем экраном
    if (!c || typeof c !== 'object' || !c.id) continue;
    if (c.isLoggedIn !== true) {
      out.push({
        id: `auth-${c.id}`,
        kind: 'auth',
        title: c.nick || c.id,
        text: 'Нужен вход на сайт: сессия истекла или вход не проверялся',
        tone: 'bad',
        charId: c.id,
        action: 'check-auth-one',
        actionLabel: 'Проверить вход'
      });
      continue;
    }
    const coin = freshnessOf('balance', c.lastCoinUpdate, settings, now.getTime());
    if (coin.stale) {
      out.push({
        id: `balance-${c.id}`,
        kind: 'balance',
        title: c.nick || c.id,
        text: coin.never ? 'Баланс монет ещё не проверялся' : `Баланс монет не проверялся ${coin.text}`,
        tone: 'warn',
        charId: c.id,
        action: 'balance-one',
        actionLabel: 'Обновить баланс'
      });
    }
  }

  for (const item of marathonProgress(state, { now })) {
    if (item.behind > 0) {
      out.push({
        id: `marathon-${item.id}`,
        kind: 'marathon',
        title: item.title,
        text: `Отстают: ${item.behind} из ${item.participants} · ${item.hint}`,
        tone: 'warn',
        action: 'open-marathon',
        actionLabel: 'Открыть',
        marathonId: item.id
      });
    }
  }

  const rank = { auth: 0, marathon: 1, balance: 2 };
  return out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.title.localeCompare(b.title, 'ru'));
}

/**
 * Общая сводка: монеты, проходки и ближайшие даты окончания событий.
 * @returns {{ coins: number, passes: number, passesByType: Record<string, number>, endingSoon: Array<{ id: string, title: string, days: number }> }}
 */
export function supplies(state, { now = new Date(), soonDays = 7 } = {}) {
  const characters = state?.characters || [];
  const coins = Math.round(characters.reduce((sum, c) => sum + (Number(c.ancientCoins) || 0), 0) * 10) / 10;
  const passesByType = { weapon: 0, armor: 0, relic: 0 };
  for (const c of characters) {
    const p = c.dungeonPasses || {};
    passesByType.weapon += Number(p.weapon) || 0;
    passesByType.armor += Number(p.armor) || 0;
    passesByType.relic += Number(p.relic) || 0;
  }
  const passes = passesByType.weapon + passesByType.armor + passesByType.relic;

  const endingSoon = [];
  for (const m of state?.marathons || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.kind === 'series' || !m.endDate || m.status === 'completed') continue;
    const days = daysUntil(m.endDate, now);
    if (days !== null && days >= 0 && days <= soonDays) {
      endingSoon.push({ id: m.id, title: m.title || 'Марафон', days });
    }
  }
  endingSoon.sort((a, b) => a.days - b.days || a.title.localeCompare(b.title, 'ru'));

  return { coins, passes, passesByType, endingSoon };
}

/**
 * Пати для экрана: участники и онлайн.
 * @returns {Array<{ id: string, name: string, members: number, online: number }>}
 */
export function partyOverview(state) {
  const characters = state?.characters || [];
  const out = (state?.parties || []).map(p => {
    const members = charactersInParty(characters, p.id);
    return { id: p.id, name: p.name, members: members.length, online: members.filter(c => c.isLoggedIn === true).length };
  });
  const none = characters.filter(c => hasNoParty(c, state?.parties || []));
  if (none.length) {
    out.push({
      id: '__none__',
      name: NO_PARTY_LABEL,
      members: none.length,
      online: none.filter(c => c.isLoggedIn === true).length
    });
  }
  return out;
}

/** Всё, что нужно экрану «Сегодня», одним вызовом. */
export function todayData(state, { now = new Date() } = {}) {
  const characters = state?.characters || [];
  return {
    attention: attentionItems(state, { now }),
    marathons: marathonProgress(state, { now }),
    supplies: supplies(state, { now }),
    parties: partyOverview(state),
    characters: characters.length,
    online: characters.filter(c => c.isLoggedIn === true).length
  };
}
