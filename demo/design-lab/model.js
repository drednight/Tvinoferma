import { CHARACTERS, PARTIES, createDemoState, demoDays, marathonRisk } from '../today/data.js';
import { DEMO_RUNES } from '../app/fixtures.js';
import { PAGES } from './catalog.js';
import { mskAddDays } from '../../js/core/msk.js';
export { demoDays, marathonRisk };
export function createLabState() {
  const day = createDemoState();
  return {
    day,
    calendarEvents: [
      { date: day.date, time: '19:30', title: 'Встреча гильдии' },
      { date: day.date, time: '21:00', title: 'Вечерний поход' }
    ],
    query: '',
    filter: 'all',
    sort: 'name',
    selected: new Set(),
    detail: '',
    palette: 'concept',
    compact: false,
    characters: CHARACTERS.map((c, i) => ({
      ...c,
      server: i % 3 === 0 ? 'Мицар' : 'Фенрир',
      level: 105 + (i % 3),
      tags: i % 2 ? 'Основной' : 'Поддержка',
      site: `pw-demo-${i + 1}`,
      game: `game-demo-${i + 1}`
    })),
    parties: PARTIES.map(p => ({ ...p })),
    runes: structuredClone(DEMO_RUNES.runes),
    extraMarathons: [],
    calendarOffset: 0,
    ledger: [
      {
        id: 'op1',
        title: 'Награда события',
        category: 'Марафон',
        amount: 320,
        currency: 'Древние монеты',
        time: 'Сегодня, 09:40'
      },
      {
        id: 'op2',
        title: 'Камень светлого духа',
        category: 'Подарки',
        amount: -120,
        currency: 'Древние монеты',
        time: 'Сегодня, 09:10'
      },
      {
        id: 'op3',
        title: 'Продажа материалов',
        category: 'Торговля',
        amount: 240000,
        currency: 'Золото',
        time: 'Вчера, 21:20'
      },
      {
        id: 'op4',
        title: 'Расход на развитие',
        category: 'Снаряжение',
        amount: -85000,
        currency: 'Золото',
        time: 'Вчера, 20:10'
      },
      { id: 'op5', title: 'Пополнение', category: 'Личное', amount: 500, currency: 'Голд', time: 'Вчера, 18:30' },
      {
        id: 'op6',
        title: 'Игровая покупка',
        category: 'Развитие',
        amount: -140,
        currency: 'Голд',
        time: 'Вчера, 18:20'
      }
    ],
    activeWindows: [
      { id: 'window-c1', charId: 'c1', title: 'Звеномир · Север' },
      { id: 'window-c2', charId: 'c2', title: 'Тихомир · Север' }
    ],
    jobs: [
      {
        id: 'job1',
        title: 'Баланс аккаунтов',
        state: 'Готово',
        progress: 100,
        time: '09:40',
        detail: 'Проверено 8 из 8 · имитация'
      },
      {
        id: 'job2',
        title: 'Проверка входа',
        state: 'Внимание',
        progress: 75,
        time: '09:32',
        detail: 'Два аккаунта требуют входа · пример'
      },
      {
        id: 'job3',
        title: 'Проверка марафона',
        state: 'Готово',
        progress: 100,
        time: 'Вчера',
        detail: 'Участники события · имитация'
      }
    ],
    preferences: { notifications: true, tray: true, checks: false, encrypted: true },
    scenarios: { clan: true, marathon: true, promo: true, attention: true },
    vote: '',
    checkDates: {},
    running: null,
    runGeneration: 0,
    transferSets: 2,
    taskSelection: [],
    toast: '',
    created: 0
  };
}
export const TOOL_DEFS = [
  ['auth', 'Проверка входа', 'Чтение', 'Статус входа на сайт; не статус игрового окна.'],
  ['balance', 'Обновить балансы', 'Чтение', 'Древние монеты по аккаунтам и время проверки.'],
  ['marathon', 'Проверить марафоны', 'Чтение', 'Только участники выбранного события.'],
  ['promo', 'Активировать промокод', 'Действие', 'Предпросмотр получателей, затем отдельное подтверждение.'],
  ['transfer', 'Передать наборы', 'Действие', 'Неделимые наборы, точный получатель, ранние сроки первыми.'],
  ['shop', 'Активировать подарки', 'Действие', 'Цена, общий баланс аккаунта, лимиты и сроки обновления.'],
  ['caravan', 'Сундук караванщика', 'Действие', 'Общий инвентарь сайта, поиск сундуков, найденное содержимое.'],
  ['inventory', 'Инвентарь сайта', 'Чтение', 'Все доступные предметы, количество и подтверждённые сроки.']
];
const settingsGroups = [
  ['application', 'Приложение', 'Каждый день', 'Лаунчер, браузеры, раскладка окон, трей и уведомления.'],
  ['automation', 'Фоновые проверки', 'Каждый день', 'Периодичность, свежесть данных, очередь и немедленный стоп.'],
  ['cloud', 'Синхронизация', 'Доступ', 'Независимые Google и Яндекс; версии, проверка различий до применения.'],
  [
    'security',
    'Данные и безопасность',
    'Доступ',
    'Резервные копии, зашифрованное хранилище, отдельное согласие на контакты и пароли.'
  ],
  ['diagnostics', 'Диагностика', 'Поддержка', 'Журналы, состояние парсеров, системная информация.'],
  ['help', 'Обновления и помощь', 'Поддержка', 'Версия, справка, горячие клавиши и обратная связь.']
];
export function entriesFor(page, s) {
  switch (page) {
    case 'today':
      return [
        ['daily', 'Данж и задачи дня', 'План', 'Вчера, сегодня и пять следующих дней; отметки раздельно по датам.'],
        ...(s.scenarios.attention &&
        (s.characters.some(c => c.auth !== 'online') ||
          (s.scenarios.marathon && s.day.marathonProgress.some(r => marathonRisk(r).tone !== 'green')))
          ? [
              [
                'attention',
                'Требует внимания',
                'Важное',
                'Вход на сайт, незавершённые проверки и риск активного марафона.'
              ]
            ]
          : []),
        ...(s.scenarios.promo
          ? [['promo', 'Активный промокод', 'Важное', 'PWDEMO2026 · ещё не введён у 6 персонажей.']]
          : []),
        ['party', 'Быстрый запуск', 'Действия', 'Состав, выбор участников и запускаемые окна.'],
        ...(s.scenarios.marathon
          ? [['marathon', 'Путь героя', 'Прогресс', 'Победить монстров · пройти данж · выполнить поручение.']]
          : []),
        ...(s.scenarios.clan ? [['clan', 'Клан Eternals', 'Вместе', 'Отпись, совместные пати и голосование.']] : []),
        ['calendar', 'Календарь', 'План', '19:30 — встреча гильдии; 21:00 — вечерний поход.'],
        [
          'windows',
          'Игровые окна',
          'Действия',
          `${s.activeWindows.length} окна в демонстрации; отдельно от входа на сайт.`
        ]
      ].map(([id, title, group, description], i) => ({
        id,
        title,
        group,
        description,
        status: group === 'Важное' ? 'Внимание' : 'План',
        time: i < 3 ? 'Сейчас' : 'Сегодня',
        metric: group,
        facets: { Приоритет: i < 3 ? 'Высокий' : 'Обычный', Контекст: group }
      }));
    case 'characters':
      return s.characters.map(c => ({
        id: c.id,
        title: c.nick,
        subtitle: `${c.className} · ур. ${c.level}`,
        description: `${c.server} · ${c.tags} · сайт ${c.site}`,
        group: c.server,
        status: c.auth === 'online' ? 'Готово' : c.auth === 'checking' ? 'Проверка' : 'Нужен вход',
        metric: `${c.coins} монет`,
        progress: c.auth === 'online' ? 100 : 0,
        icon: c.icon,
        facets: {
          Класс: c.className,
          Сервер: c.server,
          Сайт: c.auth === 'online' ? 'Вход выполнен' : 'Нужен вход',
          Пати: s.parties.find(p => p.id === c.party)?.name || 'Без пати'
        },
        entity: c
      }));
    case 'parties':
      return s.parties.map(p => {
        const members = s.characters.filter(c => c.party === p.id);
        return {
          id: p.id,
          title: p.label || p.name,
          subtitle: `${members.length} участника`,
          description: members.map(c => c.nick).join(' · '),
          group: members.every(c => c.auth === 'online') ? 'Готовые составы' : 'Нужна проверка',
          status: 'Состав',
          metric: `${members.filter(c => c.auth === 'online').length}/${members.length} на сайте`,
          progress: Math.round((members.filter(c => c.auth === 'online').length / Math.max(1, members.length)) * 100),
          facets: {
            Участники: members.length,
            Лаунчер: 'Демо',
            Раскладка: '2 × 2',
            Окна: s.activeWindows.filter(w => members.some(c => c.id === w.charId)).length
          },
          entity: p
        };
      });
    case 'marathons':
      return [
        {
          id: 'hero',
          title: 'Путь героя',
          subtitle: '4 участника · 3 задания',
          description: 'Победить монстров · пройти данж · выполнить поручение',
          group: 'Активные',
          status: 'Внимание',
          metric: '1 отстаёт',
          progress: 46,
          facets: { Участники: 4, Задания: 3, Срок: 'Ещё 4 дня', Риск: '1 отстаёт' }
        },
        {
          id: 'autumn',
          title: 'Осенний сбор',
          subtitle: '3 участника · 2 задания',
          description: 'Ежедневная отметка и поручение на сайте события',
          group: 'Активные',
          status: 'Готово',
          metric: 'Запас 5 дней',
          progress: 65,
          facets: { Участники: 3, Задания: 2, Срок: 'Ещё 9 дней', Риск: 'В пределах плана' }
        },
        ...s.extraMarathons,
        {
          id: 'finished',
          title: 'Летняя экспедиция',
          subtitle: '8 участников · завершено',
          description: 'Архив результатов и полученных наград',
          group: 'Архив',
          status: 'Завершён',
          metric: '100%',
          progress: 100,
          facets: { Участники: 8, Задания: 4, Срок: 'Завершён', Риск: 'Нет' }
        }
      ];
    case 'runes':
      return s.runes.map(r => ({
        id: r.id,
        title: r.class,
        subtitle: `Автор: ${r.author}`,
        description: r.note || 'Комбинация без заметок',
        group: r.class === 'Воин' || r.class === 'Паладин' ? 'Ближний бой' : 'Дальний бой',
        status: 'Схема',
        metric: `PvE ${r.pve.replace('Пример PvE: ', '')}`,
        facets: { PvE: r.pve, PvP: r.pvp, Дополнительно: r.additional || 'Не задано', Автор: r.author },
        entity: r
      }));
    case 'bank':
      return s.ledger.map(o => ({
        ...o,
        description: `${o.category} · ручная учебная запись`,
        subtitle: o.time,
        group: o.currency,
        status: o.amount > 0 ? 'Доход' : 'Расход',
        metric: `${o.amount > 0 ? '+' : ''}${o.amount.toLocaleString('ru-RU')} ${o.currency}`,
        facets: {
          Тип: o.amount > 0 ? 'Доход' : 'Расход',
          Валюта: o.currency,
          Категория: o.category,
          Сумма: o.amount.toLocaleString('ru-RU')
        },
        entity: o
      }));
    case 'tools':
      return TOOL_DEFS.map(([id, title, group, description], i) => ({
        id,
        title,
        group,
        description,
        status: group === 'Чтение' ? 'Без изменений' : 'Подтверждение',
        metric: group === 'Чтение' ? 'Только чтение' : 'Пробный запуск',
        progress: 0,
        facets: {
          Тип: group,
          Аккаунты: 'По выбору',
          Подтверждение: group === 'Чтение' ? 'Не требуется' : 'Обязательно',
          Очередь: 'Общая'
        },
        time: `Шаг ${i + 1}`
      }));
    case 'activity':
      return s.jobs.map(j => ({
        id: j.id,
        title: j.title,
        description: j.detail,
        group: j.state,
        status: j.state,
        metric: `${j.progress}%`,
        progress: j.progress,
        time: j.time,
        facets: { Состояние: j.state, Прогресс: `${j.progress}%`, Время: j.time, Источник: 'Имитация' }
      }));
    case 'settings':
      return settingsGroups.map(([id, title, group, description]) => ({
        id,
        title,
        description,
        group,
        status: 'Локально',
        metric: id === 'cloud' ? '2 провайдера' : 'Открыть раздел',
        facets: {
          Область: group,
          Хранение: id === 'cloud' ? 'Диски независимо' : 'На этом ПК',
          Режим: 'Пример',
          Доступ: 'Без настоящих ключей'
        }
      }));
    default:
      return [];
  }
}
export function visibleEntries(page, s) {
  const query = s.query.trim().toLocaleLowerCase('ru-RU');
  const rows = entriesFor(page, s).filter(
    e =>
      (s.filter === 'all' || [e.group, e.status].includes(s.filter)) &&
      (!query ||
        [e.title, e.subtitle, e.description, e.group, ...Object.values(e.facets || {})]
          .join(' ')
          .toLocaleLowerCase('ru-RU')
          .includes(query))
  );
  if (page === 'today') return rows;
  return rows.sort((a, b) =>
    s.sort === 'status' ? a.status.localeCompare(b.status, 'ru') : a.title.localeCompare(b.title, 'ru')
  );
}
export function featureList(source) {
  return source === 'activity'
    ? [
        'Очередь всех операций',
        'Остановка без потери отчёта',
        'История результатов',
        'Повтор только безопасных ошибок',
        'Развёрнутый отчёт',
        'Диагностика'
      ]
    : PAGES.find(p => p.id === source)?.features || [];
}
export function selectedDay(s) {
  return mskAddDays(s.day.date, s.day.chosenDay);
}
export function markDay(s, key, value) {
  const date = selectedDay(s);
  (s.checkDates[date] ||= {})[key] = value;
}
export function launchParty(s, id, ids) {
  const party = s.parties.find(p => p.id === id);
  if (!party) return;
  for (const c of s.characters.filter(c => c.party === id && ids.includes(c.id)))
    if (!s.activeWindows.some(w => w.charId === c.id))
      s.activeWindows.push({ id: `window-${c.id}`, charId: c.id, title: `${c.nick} · ${party.name}` });
}
export function simulateCheck(s) {
  for (const row of s.day.marathonProgress)
    if (!row.checkedToday) {
      if (row.siteTodayDone) row.completed = Math.min(row.required, row.completed + 1);
      row.checkedToday = true;
    }
}
