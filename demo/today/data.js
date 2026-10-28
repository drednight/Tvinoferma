// Только вымышленные данные для сравнения вариантов страницы «Сегодня».
// Ничего отсюда не записывается в состояние приложения и не отправляется на сайт.
import { mskDate, mskAddDays } from '../../js/core/msk.js';
import { dungeonInfoForDate } from '../../js/modules/dungeons/schedule.js';
import { CLASS_ICON_MAP } from '../../js/core/constants.js';
import { normalizeGuildPoll } from '../../js/modules/guild/poll.js';

export const VARIANTS = [
  { id: 'overview', label: 'Обзор', description: 'Всё важное на одной странице' },
  { id: 'day', label: 'План дня', description: 'События и дела в центре' },
  { id: 'workspace', label: 'Пульт', description: 'Быстрые действия и разделы' },
  { id: 'original', label: 'Исходная', description: 'Копия страницы приложения' }
];

export const CHARACTERS = [
  { id: 'c1', nick: 'Звеномир', className: 'Воин', icon: 'var', party: 'p1', auth: 'online', coins: 1260 },
  { id: 'c2', nick: 'Тихомир', className: 'Маг', icon: 'mag', party: 'p1', auth: 'online', coins: 980 },
  { id: 'c3', nick: 'Радовика', className: 'Лучник', icon: 'luk', party: 'p1', auth: 'offline', coins: 830 },
  { id: 'c4', nick: 'Светолика', className: 'Жрец', icon: 'prist', party: 'p2', auth: 'online', coins: 720 },
  { id: 'c5', nick: 'Братислав', className: 'Воин', icon: 'var', party: 'p2', auth: 'checking', coins: 1120 },
  { id: 'c6', nick: 'Милослава', className: 'Маг', icon: 'mag', party: 'p2', auth: 'online', coins: 650 },
  { id: 'c7', nick: 'Горыня', className: 'Оборотень', icon: 'tank', party: 'p3', auth: 'offline', coins: 980 },
  { id: 'c8', nick: 'Ярополк', className: 'Паладин', icon: 'pal', party: 'p3', auth: 'online', coins: 620 }
];

export const PARTIES = [
  { id: 'p1', name: 'Север', label: 'Пати «Север»' },
  { id: 'p2', name: 'Комета', label: 'Пати «Комета»' },
  { id: 'p3', name: 'Рассвет', label: 'Пати «Рассвет»' }
];

// Это не игровое расписание: примеры специально подписаны на странице как демо.
export const EVENTS = [
  { id: 'event-1', time: '19:30', title: 'Встреча гильдии', detail: 'Сбор участников · пример', color: 'violet' },
  { id: 'event-2', time: '21:00', title: 'Вечерний поход', detail: 'Личное событие · пример', color: 'blue' }
];

export const TASKS = [
  { id: 'daily', title: 'Выполнить ежедневное задание', detail: 'Данж дня', icon: 'swords' },
  { id: 'marathon', title: 'Проверить задания марафона', detail: 'Марафон', icon: 'flag' },
  { id: 'party', title: 'Подготовить пати к сбору', detail: 'Пати', icon: 'users' }
];

export function createDemoState(now = new Date()) {
  return {
    variant: 'overview',
    clanEnabled: true,
    pollEnabled: true,
    marathonActive: true,
    favoriteParty: 'p1',
    characters: CHARACTERS.map(character => ({ ...character })),
    parties: PARTIES.map(party => ({ ...party })),
    events: EVENTS.map(event => ({ ...event })),
    marathon: { title: 'Путь героя', days: 7, percent: 33 },
    bank: 4780,
    chosenDay: 0,
    tasks: { daily: true, marathon: false, party: false },
    clanResponses: { 'clan-1': '', 'clan-2': '' },
    poll: {
      id: '901',
      title: [
        { text: 'Когда удобнее собраться? ' },
        { text: 'Подробнее о встрече', href: 'https://example.com/clan-event' }
      ],
      type: 'multiple',
      options: [
        { id: '501', text: [{ text: 'В будни после 20:00' }], selected: false },
        {
          id: '502',
          text: [{ text: 'В выходные · ' }, { text: 'пример расписания', href: 'https://example.com/schedule' }],
          selected: false
        }
      ]
    },
    lastLaunch: '',
    date: mskDate(now)
  };
}

export function partyInfo(id, state) {
  const parties = state?.parties ?? PARTIES;
  const characters = state?.characters ?? CHARACTERS;
  const party = parties.find(item => item.id === id) || parties[0] || { id: '', name: '', label: 'Нет пати' };
  const members = party.id ? characters.filter(c => c.party === party.id) : [];
  return { ...party, members, online: members.filter(c => c.auth === 'online').length };
}

export function summary(state) {
  const characters = state?.characters ?? CHARACTERS;
  return {
    characters: characters.length,
    online: characters.filter(c => c.auth === 'online').length,
    offline: characters.filter(c => c.auth === 'offline').length,
    checking: characters.filter(c => c.auth === 'checking').length,
    parties: (state?.parties ?? PARTIES).length,
    coins: characters.reduce((sum, c) => sum + c.coins, 0),
    runes: 5,
    bank: state?.bank ?? 4780
  };
}

// Только обезличенная сводка из изолированного снимка; сами записи приложения сюда не передаются.
export function applyAppSnapshot(state, snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.characters) ||
    !Array.isArray(snapshot.parties) ||
    snapshot.characters.some(item => !item || typeof item !== 'object') ||
    snapshot.parties.some(item => !item || typeof item !== 'object')
  )
    return false;
  state.characters = snapshot.characters.map(character => ({
    id: String(character.id || ''),
    nick: String(character.nick || ''),
    className: String(character.className || ''),
    icon: (Object.hasOwn(CLASS_ICON_MAP, character.className) ? CLASS_ICON_MAP[character.className] : '').replace(
      /\.webp$/,
      ''
    ),
    party: String(character.party || ''),
    auth: character.checking ? 'checking' : character.isLoggedIn ? 'online' : 'offline',
    coins: Number(character.coins) || 0
  }));
  state.parties = snapshot.parties.map(party => ({
    id: String(party.id || ''),
    name: String(party.name || ''),
    label: `Пати «${String(party.name || '')}»`
  }));
  if (!state.parties.some(party => party.id === state.favoriteParty)) state.favoriteParty = state.parties[0]?.id || '';
  if (Array.isArray(snapshot.events))
    state.events = snapshot.events
      .filter(event => event && typeof event === 'object')
      .map(event => ({
        id: String(event.id || ''),
        title: String(event.title || ''),
        time: String(event.time || ''),
        detail: 'Запись календаря · пример',
        color: event.color === 'purple' ? 'violet' : 'blue'
      }));
  const marathon = snapshot.marathon;
  state.marathon =
    marathon && typeof marathon === 'object'
      ? {
          title: String(marathon.title || ''),
          days: Number.isFinite(Number(marathon.days)) ? Math.max(0, Math.floor(Number(marathon.days))) : 0,
          percent: Number.isFinite(Number(marathon.percent)) ? Math.max(0, Math.min(100, Number(marathon.percent))) : 0
        }
      : null;
  state.marathonActive = !!state.marathon;
  state.bank = Number.isFinite(Number(snapshot.bank)) ? Number(snapshot.bank) : 0;
  if (typeof snapshot.clanEnabled === 'boolean') state.clanEnabled = snapshot.clanEnabled;
  if (typeof snapshot.pollEnabled === 'boolean') state.pollEnabled = snapshot.pollEnabled;
  if (snapshot.clanResponses && typeof snapshot.clanResponses === 'object') {
    for (const key of Object.keys(state.clanResponses)) {
      if (['', 'yes', 'no'].includes(snapshot.clanResponses[key]))
        state.clanResponses[key] = snapshot.clanResponses[key];
    }
  }
  const poll = normalizeGuildPoll(snapshot.poll);
  if (poll) state.poll = poll;
  return true;
}

export function demoDays(date) {
  return Array.from({ length: 5 }, (_, i) => {
    const day = mskAddDays(date, i);
    return { ...dungeonInfoForDate(day), offset: i };
  });
}
