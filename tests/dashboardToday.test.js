// Экран «Сегодня» (Issue #39): что требует внимания, что делать в марафонах, какие запасы.
// Логика отбора — js/modules/dashboard/today.js.
import { describe, it, expect } from 'vitest';

import {
  todayStr, daysUntil, daysWord, phaseHintText, characterMarathonProgress,
  marathonProgress, attentionItems, supplies, partyOverview, todayData
} from '../js/modules/dashboard/today.js';

const NOW = new Date('2026-10-05T12:00:00');
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600e3).toISOString();
const day = (offset) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv');
};

/** Состояние с настройками свежести по умолчанию (24 ч) — как у настоящего приложения. */
const baseState = (over = {}) => ({
  settings: { freshness: { balanceHours: 24, loginHours: 24, marathonHours: 24 } },
  characters: [],
  parties: [],
  marathons: [],
  ...over
});

const char = (over = {}) => ({ id: 'c1', nick: 'Аа', class: 'Воин', isLoggedIn: true, ancientCoins: 0, dungeonPasses: {}, ...over });

describe('даты и склонения', () => {
  it('сегодняшняя дата в формате ГГГГ-ММ-ДД', () => {
    expect(todayStr(NOW)).toBe('2026-10-05');
  });

  it('дни до даты: вперёд, назад, без даты', () => {
    expect(daysUntil(day(0), NOW)).toBe(0);
    expect(daysUntil(day(3), NOW)).toBe(3);
    expect(daysUntil(day(-2), NOW)).toBe(-2);
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('не дата', NOW)).toBeNull();
  });

  it('склонение дней', () => {
    expect(daysWord(1)).toBe('день');
    expect(daysWord(2)).toBe('дня');
    expect(daysWord(5)).toBe('дней');
    expect(daysWord(11)).toBe('дней');
    expect(daysWord(21)).toBe('день');
  });

  it('подпись о сроке марафона', () => {
    expect(phaseHintText({ endDate: day(0) }, NOW)).toBe('последний день');
    expect(phaseHintText({ endDate: day(1) }, NOW)).toBe('осталось 1 день');
    expect(phaseHintText({ endDate: day(3) }, NOW)).toBe('осталось 3 дня');
    expect(phaseHintText({ endDate: day(-1) }, NOW)).toBe('срок прошёл');
    expect(phaseHintText({}, NOW)).toBe('без даты окончания');
  });
});

describe('что требует внимания', () => {
  it('персонаж без входа попадает в список первым', () => {
    const items = attentionItems(baseState({ characters: [char({ isLoggedIn: false, lastCoinUpdate: at(1) })] }), { now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'auth', charId: 'c1', tone: 'bad' });
    expect(items[0].text).toContain('вход');
  });

  it('вошедший персонаж с давним балансом — в списке, со свежим — нет', () => {
    const stale = attentionItems(baseState({ characters: [char({ lastCoinUpdate: at(50) })] }), { now: NOW });
    expect(stale[0]).toMatchObject({ kind: 'balance', tone: 'warn' });
    expect(stale[0].text).toContain('2 дн. назад');

    const fresh = attentionItems(baseState({ characters: [char({ lastCoinUpdate: at(1) })] }), { now: NOW });
    expect(fresh).toEqual([]);
  });

  it('баланс, который не проверяли ни разу, назван отдельно', () => {
    const items = attentionItems(baseState({ characters: [char({ lastCoinUpdate: null })] }), { now: NOW });
    expect(items[0].text).toContain('ещё не проверялся');
  });

  it('персонаж без входа не дублируется строкой про баланс', () => {
    const items = attentionItems(baseState({ characters: [char({ isLoggedIn: false, lastCoinUpdate: null })] }), { now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('auth');
  });

  it('порядок: вход, марафон, баланс', () => {
    const items = attentionItems(baseState({
      characters: [char({ id: 'auth', nick: 'Аа', isLoggedIn: false }), char({ id: 'bal', nick: 'Бб', lastCoinUpdate: null })],
      marathons: [{
        id: 'm1', kind: 'single', title: 'Лето', status: 'active',
        startDate: day(-5), endDate: day(2), participantIds: ['bal'],
        tasks: [{ id: 't1', title: 'Вход', targetChecks: 5, schedule: { mode: 'everyDay', dates: [] }, rewards: [] }],
        progress: { bal: { t1: { site: 0, siteTotal: 5, adjust: 0, marks: [], history: {}, syncedAt: null } } }
      }]
    }), { now: NOW });
    expect(items.map(i => i.kind)).toEqual(['auth', 'marathon', 'balance']);
  });

  it('пустые данные и мусор не ломают вывод', () => {
    expect(attentionItems({}, { now: NOW })).toEqual([]);
    expect(attentionItems({ characters: [null, {}] }, { now: NOW })).toEqual([]);
  });
});

describe('прогресс марафонов', () => {
  const marathon = (over = {}) => ({
    id: 'm1', kind: 'single', title: 'Лето', status: 'active',
    startDate: day(-5), endDate: day(2), participantIds: ['c1'],
    tasks: [{ id: 't1', title: 'Ежедневный вход', targetChecks: 5, schedule: { mode: 'everyDay', dates: [] }, rewards: [] }],
    progress: {},
    ...over
  });

  it('идущий марафон считается, завершённый и будущий — нет', () => {
    const active = marathon();
    const future = marathon({ id: 'm2', startDate: day(3), endDate: day(9) });
    const completed = marathon({ id: 'm3', status: 'completed' });
    const folders = { id: 's1', kind: 'series', title: 'Папка' };
    const list = marathonProgress(baseState({ characters: [char()], marathons: [active, future, completed, folders] }), { now: NOW });
    expect(list.map(x => x.id)).toEqual(['m1']);
  });

  it('персонаж с нулевым прогрессом считается отстающим', () => {
    const snap = characterMarathonProgress(marathon(), 'c1', NOW);
    expect(snap).toMatchObject({ tasks: 1, behind: true, allDone: false });
    expect(snap.expected).toBeGreaterThan(0);
    expect(snap.actual).toBe(0);
  });

  it('персонаж, выполнивший всё, отстающим не считается', () => {
    const m = marathon({
      progress: { c1: { t1: { site: 5, siteTotal: 5, adjust: 0, marks: [], history: {}, syncedAt: null } } }
    });
    const snap = characterMarathonProgress(m, 'c1', NOW);
    expect(snap.behind).toBe(false);
    expect(snap.allDone).toBe(true);
  });

  it('в марафоне считается, сколько отстаёт и сколько закончило', () => {
    const m = marathon({
      participantIds: ['c1', 'c2'],
      progress: { c1: { t1: { site: 5, siteTotal: 5, adjust: 0, marks: [], history: {}, syncedAt: null } } }
    });
    const [info] = marathonProgress(baseState({
      characters: [char(), char({ id: 'c2', nick: 'Бб' })], marathons: [m]
    }), { now: NOW });
    expect(info).toMatchObject({ participants: 2, done: 1, behind: 1, tasks: 1 });
    expect(info.hint).toContain('осталось');
  });

  it('участник, которого нет в персонажах, не считается', () => {
    const [info] = marathonProgress(baseState({ characters: [], marathons: [marathon()] }), { now: NOW });
    expect(info.participants).toBe(0);
    expect(info.behind).toBe(0);
  });
});

describe('запасы', () => {
  it('монеты складываются без потери десятых', () => {
    const s = supplies(baseState({ characters: [char({ ancientCoins: 28.5 }), char({ id: 'c2', ancientCoins: 100 })] }), { now: NOW });
    expect(s.coins).toBe(128.5);
  });

  it('проходки складываются по видам', () => {
    const s = supplies(baseState({
      characters: [
        char({ dungeonPasses: { weapon: 2, armor: 1, relic: 0 } }),
        char({ id: 'c2', dungeonPasses: { weapon: 3, armor: 0, relic: 2 } })
      ]
    }), { now: NOW });
    expect(s.passesByType).toEqual({ weapon: 5, armor: 1, relic: 2 });
    expect(s.passes).toBe(8);
  });

  it('ближайшие окончания: только в пределах недели и не завершённые', () => {
    const s = supplies(baseState({
      marathons: [
        { id: 'm1', kind: 'single', title: 'Скоро', endDate: day(2) },
        { id: 'm2', kind: 'single', title: 'Далеко', endDate: day(30) },
        { id: 'm3', kind: 'single', title: 'Прошёл', endDate: day(-1) },
        { id: 'm4', kind: 'single', title: 'Завершён', endDate: day(2), status: 'completed' },
        { id: 's1', kind: 'series', title: 'Папка', endDate: day(1) }
      ]
    }), { now: NOW });
    expect(s.endingSoon.map(x => x.title)).toEqual(['Скоро']);
    expect(s.endingSoon[0].days).toBe(2);
  });

  it('окончания отсортированы по сроку', () => {
    const s = supplies(baseState({
      marathons: [
        { id: 'm1', kind: 'single', title: 'Б', endDate: day(5) },
        { id: 'm2', kind: 'single', title: 'А', endDate: day(1) }
      ]
    }), { now: NOW });
    expect(s.endingSoon.map(x => x.days)).toEqual([1, 5]);
  });

  it('пустое состояние даёт нули', () => {
    const s = supplies({}, { now: NOW });
    expect(s).toMatchObject({ coins: 0, passes: 0, endingSoon: [] });
  });
});

describe('обзор пати', () => {
  it('участники и онлайн по каждой пати, «Без пати» — последней', () => {
    const list = partyOverview(baseState({
      parties: [{ id: 'p1', name: 'Основа' }, { id: 'p2', name: 'Фарм' }],
      characters: [
        char({ id: 'a', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: true }),
        char({ id: 'b', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: false }),
        // Персонаж без пати: он тоже вошёл, поэтому в группе «Без пати» онлайн 1
        char({ id: 'c', partyIds: [], mainPartyId: null, isLoggedIn: true })
      ]
    }));
    expect(list).toEqual([
      { id: 'p1', name: 'Основа', members: 2, online: 1 },
      { id: 'p2', name: 'Фарм', members: 0, online: 0 },
      { id: '__none__', name: 'Без пати', members: 1, online: 1 }
    ]);
  });

  it('без пати-группы её нет в списке', () => {
    const list = partyOverview(baseState({ parties: [{ id: 'p1', name: 'Основа' }], characters: [char({ partyIds: ['p1'] })] }));
    expect(list.map(p => p.id)).toEqual(['p1']);
  });
});

describe('данные экрана целиком', () => {
  it('собирает все блоки и считает онлайн', () => {
    const data = todayData(baseState({
      characters: [char({ lastCoinUpdate: at(1) }), char({ id: 'c2', nick: 'Бб', isLoggedIn: false })],
      parties: [{ id: 'p1', name: 'Основа' }]
    }), { now: NOW });
    expect(data.characters).toBe(2);
    expect(data.online).toBe(1);
    expect(data.attention).toHaveLength(1);       // второй персонаж без входа
    expect(data.parties).toHaveLength(2);          // «Основа» и «Без пати»
    expect(data.supplies.coins).toBe(0);
  });

  it('пустое состояние не падает', () => {
    const data = todayData({}, { now: NOW });
    expect(data.attention).toEqual([]);
    expect(data.marathons).toEqual([]);
    expect(data.characters).toBe(0);
  });
});
