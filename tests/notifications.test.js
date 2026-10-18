import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  collectAlerts,
  collectEventAlerts,
  eventNotificationSettings,
  leadText,
  notificationKind,
  NOTIFY_KINDS
} from '../js/desktop/notifications.js';
import { soundSettings, SOUND_TONES, toneForKind, DEFAULT_TONE } from '../js/desktop/sound.js';
import { createMarathon } from '../js/modules/marathons/model.js';
import { normalizeState } from '../js/core/state.js';
import { DEFAULT_SETTINGS } from '../js/core/constants.js';
import { RECURRING_EVENTS } from '../js/modules/dashboard/recurringEvents.js';

const st = (progress = {}) => ({
  characters: [{ id: 'c1', nick: 'Hero' }],
  marathons: [createMarathon({
    id: 'm1', title: 'Летний', startDate: '2026-06-01', endDate: '2026-06-10', participantIds: ['c1'],
    tasks: [{ id: 't1', title: 'Сны', targetChecks: 5 }], assignments: { c1: ['t1'] }, progress
  })],
  settings: { notifications: { enabled: true, dailyHour: 20 } }
});

describe('collectAlerts', () => {
  it('не успевает → уведомление behind', () => {
    const alerts = collectAlerts(st(), { today: '2026-06-08', hour: 10 });
    const behind = alerts.find(a => a.kind === 'behind');
    expect(behind.title).toMatch(/не успевают задания: 1/i);
    expect(behind.body).toMatch(/Летний — Hero — «Сны» \(не хватает 2 дн\.\)/);
    expect(alerts.find(a => a.kind === 'ending').title).toMatch(/марафоны заканчиваются: 1/i);
  });

  it('запас ≤ 1 дня → tight; ежедневное напоминание после заданного часа', () => {
    const alerts = collectAlerts(st(), { today: '2026-06-06', hour: 21 });
    expect(alerts.map(a => a.kind).sort()).toEqual(['daily', 'tight']);
  });

  it('выполненные задания и выключенные типы не напоминают', () => {
    const done = st({ c1: { t1: { site: 5, adjust: 0, marks: [], history: {} } } });
    expect(collectAlerts(done, { today: '2026-06-09', hour: 23 })).toEqual([]);
    const off = st();
    const offKind = { popup: false, inapp: false, sound: false };
    off.settings.notifications = {
      kinds: { behind: { ...offKind }, tight: { ...offKind }, ending: { ...offKind }, daily: { ...offKind } }
    };
    expect(collectAlerts(off, { today: '2026-06-08', hour: 23 })).toEqual([]);
    // С выключенными только марафонными видами остаются дневная сводка и «заканчивается»
    off.settings.notifications = { kinds: { behind: { ...offKind }, tight: { ...offKind } } };
    expect(collectAlerts(off, { today: '2026-06-08', hour: 23 }).map(a => a.kind).sort()).toEqual(['daily', 'ending']);
  });

  it('один марафон — одно уведомление на вид, а не сообщение на каждый марафон', () => {
    // Три марафона с отставанием это одно сообщение со списком, а не три всплывающие окна
    const many = st();
    many.marathons = ['m1', 'm2', 'm3'].map(id => createMarathon({
      id, title: `Марафон ${id}`, startDate: '2026-06-01', endDate: '2026-06-10', participantIds: ['c1'],
      tasks: [{ id: 't1', title: 'Сны', targetChecks: 5 }], assignments: { c1: ['t1'] }
    }));
    const alerts = collectAlerts(many, { today: '2026-06-08', hour: 10 });
    expect(alerts.filter(a => a.kind === 'behind')).toHaveLength(1);
    expect(alerts.find(a => a.kind === 'behind').body.split('\n')).toHaveLength(3);
  });

  it('длинный список дел обрезается, а не превращается в простыню', () => {
    const many = st();
    many.characters = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, nick: `Ник${i}` }));
    many.marathons = [createMarathon({
      id: 'm1', title: 'Летний', startDate: '2026-06-01', endDate: '2026-06-10',
      participantIds: many.characters.map(c => c.id),
      tasks: [{ id: 't1', title: 'Сны', targetChecks: 5 }],
      assignments: Object.fromEntries(many.characters.map(c => [c.id, ['t1']]))
    })];
    const alerts = collectAlerts(many, { today: '2026-06-08', hour: 10 });
    const behind = alerts.find(a => a.kind === 'behind');
    expect(behind.body.split('\n')).toHaveLength(5);
    expect(behind.body).toContain('…и ещё 2');
  });

  it('час для ежедневного напоминания берётся по Москве', () => {
    // 18:30 UTC = 21:30 МСК → напоминание уже пора; 15:00 UTC = 18:00 МСК → ещё рано
    const late = collectAlerts(st(), { today: '2026-06-06', hour: 21 });
    const early = collectAlerts(st(), { today: '2026-06-06', hour: 18 });
    expect(late.map(a => a.kind)).toContain('daily');
    expect(early.map(a => a.kind)).not.toContain('daily');
  });

  it('дневная сводка считает и задания марафонов, и дела календаря на сегодня', () => {
    const withTasks = st({ c1: { t1: { site: 5, adjust: 0, marks: [], history: {} } } });   // марафонные задания закрыты
    withTasks.plannerEntries = [
      { date: '2026-06-06', status: 'todo', title: 'Сдать промокод' },
      { date: '2026-06-06', status: 'done', title: 'Уже сделано' },
      { date: '2026-06-07', status: 'todo', title: 'На завтра' }
    ];
    const daily = collectAlerts(withTasks, { today: '2026-06-06', hour: 21 }).find(a => a.kind === 'daily');
    expect(daily.body).toContain('Дел на сегодня: 1');
    expect(daily.body).toContain('Идёт марафонов: 1');
    // Без марафонов и без дел сводка молчит: пустое напоминание — это шум
    const empty = st({ c1: { t1: { site: 5, adjust: 0, marks: [], history: {} } } });
    expect(collectAlerts(empty, { today: '2026-06-06', hour: 21 }).map(a => a.kind)).not.toContain('daily');
  });
});

describe('виды уведомлений: галочки', () => {
  it('нет записи в настройках — вид работает целиком', () => {
    expect(notificationKind('behind', {})).toEqual({ popup: true, inapp: true, sound: true });
    expect(notificationKind('behind', { kinds: {} })).toEqual({ popup: true, inapp: true, sound: true });
  });

  it('выбор пользователя сохраняется', () => {
    expect(notificationKind('behind', { kinds: { behind: { popup: false, sound: false } } }))
      .toEqual({ popup: false, inapp: true, sound: false });
  });

  it('всякий вид имеет карточку в приложении, всплывающее окно и звук', () => {
    for (const item of NOTIFY_KINDS) {
      expect(item.kind, item.title).toBeTruthy();
      expect(item.title, item.kind).toBeTruthy();
      expect(item.hint, item.kind).toBeTruthy();
      expect(notificationKind(item.kind, {}), item.kind).toEqual({ popup: true, inapp: true, sound: true });
    }
    // «нет своего вида» в списке не остаётся: виды собираются из одного места
    expect(new Set(NOTIFY_KINDS.map(k => k.kind)).size).toBe(NOTIFY_KINDS.length);
  });
});

describe('настройки звука', () => {
  it('звук уведомлений включается на восемь десятых, а звук дневной сводки настроен', () => {
    expect(soundSettings({})).toEqual({ enabled: true, volume: 80, tone: 'clear' });
    expect(soundSettings(undefined)).toEqual({ enabled: true, volume: 80, tone: 'clear' });
    // Дневная сводка — напоминание, ради которого стоит оторваться: звук у неё включён
    expect(notificationKind('daily', {}).sound).toBe(true);
    expect(DEFAULT_SETTINGS.notifications.kinds.daily.sound).toBe(true);
  });

  it('громкость приводится к 0..100', () => {
    expect(soundSettings({ sound: { enabled: false, volume: 300 } }).volume).toBe(100);
    expect(soundSettings({ sound: { volume: -5 } }).volume).toBe(0);
    expect(soundSettings({ sound: { volume: 'сорок' } }).volume).toBe(80);
    expect(soundSettings({ sound: { enabled: false } }).enabled).toBe(false);
  });

  it('набор звука выбирается, неизвестный отбрасывается в пользу набора по умолчанию', () => {
    expect(soundSettings({ sound: { tone: 'signal' } }).tone).toBe('signal');
    // Набор из более новой версии приложения не должен ломать настройки
    expect(soundSettings({ sound: { tone: 'мелодия' } }).tone).toBe('clear');
    expect(DEFAULT_SETTINGS.notifications.sound.tone).toBe('clear');
    // Каждый набор пригоден для показа: у него есть название, пояснение и ноты
    for (const tone of SOUND_TONES) {
      expect(tone.id).toBeTruthy();
      expect(tone.title).toBeTruthy();
      expect(tone.hint).toBeTruthy();
      expect(tone.notes.length).toBeGreaterThan(0);
      for (const note of tone.notes) {
        expect(note.freq).toBeGreaterThan(0);
        expect(note.dur).toBeGreaterThan(0);
      }
    }
    // Список уникален по id: иначе один набор нельзя будет выбрать
    expect(new Set(SOUND_TONES.map(t => t.id)).size).toBe(SOUND_TONES.length);
  });

  it('в настройках есть список наборов, кнопка «Послушать» и настройка набора', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('data-setting="notifications.sound.tone"');
    expect(html).toContain('id="sound-preview"');
    const js = readFileSync('js/settings/settings.js', 'utf8');
    expect(js).toContain('previewNotificationSound');
    expect(js).toContain('SOUND_TONES');
  });
});

describe('напоминания о постоянных ивентах', () => {
  // 2026-06-10 — среда: Ритм Гильдии 19:30 (1170 мин), Запретное учение 20:00 (1200 мин)
  const WED = '2026-06-10';
  const settings = (leadMinutes = 10) => ({
    events: {
      'guild-rhythm': { enabled: true, leadMinutes },
      'forbidden-teaching': { enabled: true, leadMinutes }
    }
  });

  it('напоминает ровно за выбранное время до начала', () => {
    const alerts = collectEventAlerts({ today: WED, nowMinutes: 1160, settings: settings(10) });
    expect(alerts.map(a => a.eventId)).toEqual(['guild-rhythm']);   // 19:20 → до начала 10 мин
    expect(alerts[0].title).toContain('Ритм Гильдии');
    expect(alerts[0].body).toContain('осталось 10 мин');
    expect(alerts[0].key).toBe(`event:guild-rhythm:${WED}`);
  });

  it('вне окна не напоминает, а уже начавшийся ивент не напоминает', () => {
    expect(collectEventAlerts({ today: WED, nowMinutes: 1000, settings: settings(10) })).toEqual([]);
    expect(collectEventAlerts({ today: WED, nowMinutes: 1170, settings: settings(10) })).toEqual([]);
  });

  it('выбор «за 1 час» расширяет окно', () => {
    expect(collectEventAlerts({ today: WED, nowMinutes: 1120, settings: settings(60) }).map(a => a.eventId))
      .toEqual(['guild-rhythm']);   // 18:40 — за 50 минут
    expect(collectEventAlerts({ today: WED, nowMinutes: 1120, settings: settings(30) })).toEqual([]);
  });

  it('снятая галочка выключает напоминание об ивенте', () => {
    const off = { events: { 'guild-rhythm': { enabled: false, leadMinutes: 10 }, 'forbidden-teaching': { enabled: false, leadMinutes: 10 } } };
    expect(collectEventAlerts({ today: WED, nowMinutes: 1165, settings: off })).toEqual([]);
  });

  it('ивент другого дня не напоминает сегодня', () => {
    expect(collectEventAlerts({ today: '2026-06-13', nowMinutes: 1165, settings: settings(10) })).toEqual([]);
  });

  it('после полуночи ивент предыдущего дня не тянется', () => {
    // Арена Героев идёт в четверг до 24:00, в пятницу 00:05 напоминать не о чем
    expect(collectEventAlerts({ today: '2026-06-12', nowMinutes: 5, settings: settings(10) })).toEqual([]);
  });

  it('настройки ивента приводятся к допустимым значениям', () => {
    expect(eventNotificationSettings({ events: { 'hero-arena': { leadMinutes: 15 } } }, 'hero-arena'))
      .toEqual({ enabled: true, leadMinutes: 15 });
    // Битое значение заменяется на умолчание, иначе окно напоминания стало бы непредсказуемым
    expect(eventNotificationSettings({ events: { 'hero-arena': { leadMinutes: 7 } } }, 'hero-arena').leadMinutes).toBe(10);
    expect(eventNotificationSettings({}, 'hero-arena')).toEqual({ enabled: true, leadMinutes: 10 });
    expect(leadText(60)).toBe('за 1 час');
  });
});

describe('настройки уведомлений в разметке', () => {
  const html = readFileSync('index.html', 'utf8');
  it('звук и таблица видов есть, старые галочки ушли', () => {
    expect(html).toContain('data-setting="notifications.sound.enabled"');
    expect(html).toContain('data-setting="notifications.sound.volume"');
    expect(html).toContain('id="notify-kinds"');
    expect(html).toContain('id="event-notify-list"');
    // Одна старая галочка держала несколько видов: вместо неё таблица «всплывающее / звук»
    expect(html).not.toContain('data-setting="notifications.marathonBehind"');
    expect(html).not.toContain('data-setting="notifications.dailyReminder"');
  });

  it('таблица видов рисуется из NOTIFY_KINDS, а не из разметки', () => {
    const js = readFileSync('js/settings/settings.js', 'utf8');
    expect(js).toContain('data-kind-popup=');
    expect(js).toContain('data-kind-sound=');
    expect(js).toContain('NOTIFY_KINDS');
  });
});

describe('настройки уведомлений в состоянии', () => {
  it('старый state.json без настроек ивентов получает их по умолчанию', () => {
    // Иначе напоминание о новом ивенте молча не работало бы у тех, кто обновился
    const s = normalizeState({ characters: [], settings: { notifications: { dailyHour: 21 } } });
    expect(s.settings.notifications.dailyHour).toBe(21);
    for (const event of RECURRING_EVENTS) {
      expect(s.settings.notifications.events[event.id]).toEqual({ enabled: true, leadMinutes: 10 });
    }
  });

  it('выбор пользователя сохраняется, а не затирается умолчаниями', () => {
    const s = normalizeState({
      characters: [],
      settings: { notifications: { events: { 'hero-arena': { enabled: false, leadMinutes: 30 } } } }
    });
    expect(s.settings.notifications.events['hero-arena']).toEqual({ enabled: false, leadMinutes: 30 });
    // Ивент без своей записи всё равно получает умолчание
    expect(s.settings.notifications.events['guild-rhythm']).toEqual({ enabled: true, leadMinutes: 10 });
  });

  it('битое значение «за сколько» приводится к положительному числу', () => {
    const s = normalizeState({
      characters: [],
      settings: { notifications: { events: { 'guild-rhythm': { leadMinutes: -5 } } } }
    });
    expect(s.settings.notifications.events['guild-rhythm'].leadMinutes).toBe(10);
    // `eventNotificationSettings` дополнительно отсекает значения вне списка вариантов
    expect(eventNotificationSettings(s.settings.notifications, 'guild-rhythm').leadMinutes).toBe(10);
  });

  it('новые настройки появляются у всех, кто обновляется', () => {
    const s = normalizeState({ characters: [], settings: {} });
    const n = s.settings.notifications;
    expect(n.sound).toEqual({ enabled: true, volume: 80, tone: 'clear' });
    expect(n.kinds.event).toEqual({ popup: true, inapp: true, sound: true });
    // Старые галочки уходят: иначе в настройках остался бы мёртвый ключ
    expect(n.marathonBehind).toBeUndefined();
    expect(n.dailyReminder).toBeUndefined();
  });

  it('старые галочки переносятся в виды, а не сбрасываются', () => {
    const s = normalizeState({
      characters: [],
      settings: { notifications: { marathonBehind: false, marathonEnding: false, dailyReminder: false } }
    });
    const k = s.settings.notifications.kinds;
    // Одна старая галочка держала два вида: «не успевает» и «запас ≤ 1 дня»
    expect(k.behind.popup).toBe(false);
    expect(k.tight.popup).toBe(false);
    expect(k.ending.popup).toBe(false);
    expect(k.daily.popup).toBe(false);
    // Звук старая галочка не выключала: звука тогда не было вовсе
    expect(k.behind.sound).toBe(true);
    // Остальные виды не задеты
    expect(k.event.popup).toBe(true);
  });

  it('битый час и громкость приводятся к допустимым', () => {
    const s = normalizeState({
      characters: [],
      settings: { notifications: { dailyHour: 99, sound: { volume: 900 } } }
    });
    expect(s.settings.notifications.dailyHour).toBe(23);
    expect(s.settings.notifications.sound.volume).toBe(100);
  });
});

describe('звук по видам уведомлений', () => {
  // Раньше набор выбирался один на всё: «напоминание о марафоне» и «ошибка запуска»
  // звучали одинаково, и через неделю человек переставал их замечать.
  it('без своего набора вид звучит общим', () => {
    expect(toneForKind('daily', { sound: { tone: 'soft' } })).toBe('soft');
  });

  it('у вида может быть свой набор', () => {
    expect(toneForKind('launchError', { sound: { tone: 'soft' }, kinds: { launchError: { tone: 'signal' } } })).toBe('signal');
  });

  it('незнакомый набор не ломает звук: берётся значение по умолчанию', () => {
    // Набор приходит из state.json и может быть чем угодно
    expect(toneForKind('daily', { sound: { tone: 'выдуманный' } })).toBe(DEFAULT_TONE);
    expect(toneForKind('daily', { sound: { tone: 'выдуманный' }, kinds: { daily: { tone: 'ещё хуже' } } })).toBe(DEFAULT_TONE);
  });

  it('настройки видов переживают нормализацию, а чужие отбрасываются', () => {
    const s = normalizeState({ settings: { notifications: { kinds: {
      daily: { popup: false, inapp: true, sound: true, tone: 'signal' },
      behind: { popup: true, inapp: true, sound: false, tone: 'не-набор' }
    } } } });
    expect(s.settings.notifications.kinds.daily.tone).toBe('signal');
    // Чужой набор хранить незачем: он всё равно не сыграет, но в настройках смутит
    expect(s.settings.notifications.kinds.behind.tone).toBeUndefined();
  });

  it('у вида с настройкой по умолчанию есть и карточка в приложении, и звук', () => {
    const s = normalizeState({ settings: {} });
    expect(s.settings.notifications.kinds.daily).toEqual({ popup: true, inapp: true, sound: true });
  });
});

