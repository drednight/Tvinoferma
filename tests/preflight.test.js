// Проверки перед запуском игры: кого пропустить, что исправить, когда показывать экран (preflight.js, preflightDialog.js).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchRunningClients, launchPreflight, shouldShowPreflight, preflightLog, availableFixes, chooseGcToAttach, attachGcTo,
  normalizePreflightMode
} from '../js/modules/launcher/preflight.js';
import { preflightRows, openPreflight } from '../js/modules/launcher/preflightDialog.js';
import { normalizeState } from '../js/core/state.js';

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const GC2 = { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' };
const ctx = { gameCenters: [GC1, GC2], preferredId: '' };
// По умолчанию вход ЗАПОМНЕН: без него персонаж отсеивается проверкой (см. ниже).
// Отдельные тесты делают персонажа без входа явно.
const ch = (id, nick, over = {}) => ({ id, nick, class: 'Воин', launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick } } }, ...over });
/** Персонаж с GameCenter, но без запомненного входа. */
const noLogin = (id, nick, over = {}) => ch(id, nick, { launch: { gcIds: ['gc-1'], gcAccounts: {} }, ...over });
const win = (nick, cls = 'Воин', over = {}) => ({ pid: 100 + nick.length, title: cls ? `${nick} — ${cls}` : nick, elevated: false, ...over });

describe('matchRunningClients: чьё окно уже запущено', () => {
  it('узнаёт персонажа по заголовку «Ник — Класс», регистр не важен', () => {
    const m = matchRunningClients([ch('a', 'Аа'), ch('b', 'Бб')], [win('аа')]);
    expect([...m.keys()]).toEqual(['a']);
    expect(m.get('a').pid).toBeGreaterThan(0);
  });

  it('другой класс при том же нике — не он; без класса в заголовке — совпадение по нику', () => {
    expect(matchRunningClients([ch('a', 'Аа', { class: 'Маг' })], [win('Аа', 'Воин')]).size).toBe(0);
    expect(matchRunningClients([ch('a', 'Аа', { class: 'Маг' })], [win('Аа', '')]).size).toBe(1);
    expect(matchRunningClients([ch('a', 'Аа', { class: '' })], [win('Аа', 'Воин')]).size).toBe(1);
  });

  it('одно окно закрывает одного персонажа: у двойников второй всё равно запустится', () => {
    const m = matchRunningClients([ch('a', 'Аа'), ch('b', 'Аа')], [win('Аа')]);
    expect([...m.keys()]).toEqual(['a']);
    expect(matchRunningClients([ch('a', 'Аа'), ch('b', 'Аа')], [win('Аа'), win('Аа')]).size).toBe(2);
  });

  it('игровые заголовки и пустые окна ником не считаются', () => {
    expect(matchRunningClients([ch('a', 'Perfect')], [{ pid: 1, title: 'Perfect World' }, { pid: 2, title: '' }]).size).toBe(0);
    expect(matchRunningClients([ch('a', 'Аа')], null).size).toBe(0);
  });
});

describe('launchPreflight', () => {
  const chars = [ch('a', 'Аа'), ch('b', 'Бб'), ch('c', 'Вв')];

  it('запущенное пропускается, остальные идут в очередь по порядку', () => {
    const pre = launchPreflight({ characters: chars, ctx, clients: [win('Бб')] });
    expect(pre.alreadyRunning.map(r => r.char.id)).toEqual(['b']);
    expect(pre.toLaunch.map(c => c.id)).toEqual(['a', 'c']);
    expect(pre.hasProblems).toBe(false);
  });

  it('настройка «пропускать» выключена — запускаются все', () => {
    const pre = launchPreflight({ characters: chars, ctx, clients: [win('Бб')], skipRunning: false });
    expect(pre.alreadyRunning).toEqual([]);
    expect(pre.toLaunch).toHaveLength(3);
  });

  it('окна неизвестны (сбой чтения) — ничего не пропускаем и об этом говорим', () => {
    const pre = launchPreflight({ characters: chars, ctx, clients: null });
    expect(pre.toLaunch).toHaveLength(3);
    expect(pre.runningKnown).toBe(false);
    expect(preflightRows(pre).some(r => /Не удалось узнать/.test(r.title))).toBe(true);
  });

  it('нет GameCenter — проблема; своего пути из карточки достаточно', () => {
    // Свой путь из карточки — тоже GameCenter, но он без запомненного входа (`gcAccount`)
    const list = [ch('a', 'Аа', { launch: {} }), ch('b', 'Бб', { launch: { gcPath: 'D:\\X\\GameCenter.exe', gcAccount: true } })];
    const pre = launchPreflight({ characters: list, ctx, clients: [] });
    expect(pre.noGc.map(c => c.id)).toEqual(['a']);
    expect(pre.toLaunch.map(c => c.id)).toEqual(['b']);
    expect(pre.problems).toEqual(['noGc']);
  });

  // Вход важен в том GameCenter, из которого пойдёт запуск, а не в любом прикреплённом:
  // прикреплённых GameCenter бывает несколько, и запускает персонаж один из них.
  it('вход нужен именно в том GameCenter, из которого пойдёт запуск', () => {
    const a = ch('a', 'Аа', { launch: { gcIds: ['gc-1', 'gc-2'], gcAccounts: { 'gc-2': { nick: 'Дракон' } } } });
    // по умолчанию берётся первый в списке (gc-1), входа в нём нет — персонаж отсеится
    expect(launchPreflight({ characters: [a], ctx, clients: [] }).noSavedLogin.map(c => c.id)).toEqual(['a']);
    // если пати запускается из gc-2, вход в нём есть — персонаж запускается
    const pre = launchPreflight({ characters: [a], ctx: { ...ctx, preferredId: 'gc-2' }, clients: [] });
    expect(pre.noSavedLogin).toEqual([]);
    expect(pre.toLaunch.map(c => c.id)).toEqual(['a']);
  });

  it('вход не запомнен — не запускаем: без него окно откроется под чужим аккаунтом', () => {
    const list = [noLogin('a', 'Аа', { isLoggedIn: false }), ch('b', 'Бб'), noLogin('c', 'Вв')];
    const pre = launchPreflight({ characters: list, ctx, clients: [] });
    expect(pre.noSavedLogin.map(c => c.id)).toEqual(['a', 'c']);
    expect(pre.siteNoLogin.map(c => c.id)).toEqual([]);       // уже не в запускаемых
    // Запускается только тот, у кого вход есть
    expect(pre.toLaunch.map(c => c.id)).toEqual(['b']);
    expect(pre.planned.map(c => c.id)).toEqual(['a', 'b', 'c']);
    expect(pre.problems).toEqual(['noSavedLogin']);
    expect(pre.hasProblems).toBe(true);
  });

  it('вход запомнен в единственном прикреплённом GameCenter — персонаж запускается', () => {
    const a = ch('a', 'Аа', { launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'Дракон' } } } });
    const pre = launchPreflight({ characters: [a], ctx, clients: [] });
    expect(pre.noSavedLogin).toEqual([]);
    expect(pre.toLaunch.map(c => c.id)).toEqual(['a']);
    expect(pre.hasProblems).toBe(false);
  });

  it('окно от администратора при Твинофе без прав — проблема; с правами или неизвестно — нет', () => {
    const w = [win('Зз', 'Воин', { elevated: true })];
    expect(launchPreflight({ characters: chars, ctx, clients: w, selfElevated: false }).problems).toEqual(['adminMismatch']);
    expect(launchPreflight({ characters: chars, ctx, clients: w, selfElevated: true }).hasProblems).toBe(false);
    expect(launchPreflight({ characters: chars, ctx, clients: w, selfElevated: null }).hasProblems).toBe(false);
  });

  it('чужие окна без ника считаются отдельно', () => {
    const pre = launchPreflight({ characters: chars, ctx, clients: [{ pid: 9, title: 'Perfect World' }, win('Аа')] });
    expect(pre.unknownClients).toBe(1);
  });
});

describe('когда показывать экран', () => {
  const chars = [ch('a', 'Аа'), ch('b', 'Бб')];
  const clean = () => launchPreflight({ characters: chars, ctx, clients: [] });
  const withProblem = () => launchPreflight({ characters: [...chars, ch('c', 'Вв', { launch: {} })], ctx, clients: [] });

  it('«при проблемах»: только когда они есть; «всегда» — всегда; «выключено» — никогда', () => {
    expect(shouldShowPreflight(clean(), 'issues')).toBe(false);
    expect(shouldShowPreflight(withProblem(), 'issues')).toBe(true);
    expect(shouldShowPreflight(clean(), 'always')).toBe(true);
    expect(shouldShowPreflight(withProblem(), 'off')).toBe(false);
    expect(shouldShowPreflight(clean(), 'мусор')).toBe(false);   // мусор = «при проблемах»
  });

  it('у всех нет входа — экран всё равно показываем, запускать некого', () => {
    const pre = launchPreflight({ characters: [noLogin('a', 'Аа'), noLogin('b', 'Бб')], ctx, clients: [] });
    expect(pre.toLaunch).toEqual([]);
    expect(pre.hasProblems).toBe(true);
    expect(shouldShowPreflight(pre, 'issues')).toBe(true);
  });

  it('пропуск запущенных сам по себе экран не открывает', () => {
    const pre = launchPreflight({ characters: chars, ctx, clients: [win('Аа')] });
    expect(pre.alreadyRunning).toHaveLength(1);
    expect(shouldShowPreflight(pre, 'issues')).toBe(false);
  });

  it('режим из настроек: мусор заменяется на умолчание, новые поля есть в state', () => {
    expect(normalizePreflightMode('off')).toBe('off');
    expect(normalizePreflightMode(5)).toBe('issues');
    const l = normalizeState({ characters: [], settings: { launcher: { preflight: 'zzz', skipRunning: false } } }).settings.launcher;
    expect([l.preflight, l.skipRunning]).toEqual(['issues', false]);
    const d = normalizeState({ characters: [], settings: {} }).settings.launcher;
    expect([d.preflight, d.skipRunning]).toEqual(['issues', true]);
  });
});

describe('журнал, исправления', () => {
  it('строки для журнала задачи: пропущенные, без GameCenter и без входа', () => {
    const pre = launchPreflight({
      characters: [ch('a', 'Аа'), ch('b', 'Бб', { launch: {} }), noLogin('c', 'Вв')], ctx, clients: [win('Аа')]
    });
    const text = preflightLog(pre).map(l => l.text).join(' | ');
    expect(text).toContain('Уже запущены, пропускаю (1): Аа');
    expect(text).toContain('Не указан GameCenter, пропускаю (1): Бб');
    expect(text).toContain('Вход в GameCenter не запомнен, пропускаю (1): Вв');
  });

  it('исправление одно и ведёт в окно: привязку и вход чинит только пользователь', () => {
    const none = launchPreflight({ characters: [ch('a', 'Аа')], ctx, clients: [] });
    expect(availableFixes(none, ctx)).toEqual([]);
    const pre = launchPreflight({ characters: [ch('a', 'Аа', { launch: {} })], ctx, clients: [] });
    // Раньше здесь был автопереход «прикрепить GameCenter из списка». Он не мог закрыть
    // вторую половину проблемы — вход без ручного входа в GameCenter не запомнить.
    expect(availableFixes(pre, ctx)).toHaveLength(1);
    expect(availableFixes(pre, ctx)[0].id).toBe('openGcWindow');
    // Жалоба была на вход, а не на привязку — окно тоже откроется
    const noLoginPre = launchPreflight({ characters: [noLogin('a', 'Аа')], ctx, clients: [] });
    expect(availableFixes(noLoginPre, ctx)[0].id).toBe('openGcWindow');
  });

  it('какой GameCenter прикрепить: у большинства группы, иначе предпочитаемый, иначе первый; нет списка — null', () => {
    const group = [ch('a', 'Аа', { launch: { gcIds: ['gc-2'] } }), ch('b', 'Бб', { launch: { gcIds: ['gc-2'] } }), ch('c', 'Вв', { launch: { gcIds: ['gc-1'] } }), ch('d', 'Гг', { launch: {} })];
    expect(chooseGcToAttach(group, ctx).id).toBe('gc-2');
    expect(chooseGcToAttach([ch('d', 'Гг', { launch: {} })], { ...ctx, preferredId: 'gc-2' }).id).toBe('gc-2');
    expect(chooseGcToAttach([ch('d', 'Гг', { launch: {} })], ctx).id).toBe('gc-1');
    expect(chooseGcToAttach(group, { gameCenters: [] })).toBeNull();
  });

  it('attachGcTo добавляет GameCenter и не трогает уже прикреплённые и запомненные входы', () => {
    const a = ch('a', 'Аа', { launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'x' } } } });
    const b = ch('b', 'Бб', { launch: {} });
    attachGcTo([a, b], 'gc-2');
    expect(a.launch.gcIds).toEqual(['gc-1', 'gc-2']);
    expect(a.launch.gcAccounts['gc-1'].nick).toBe('x');
    expect(b.launch.gcIds).toEqual(['gc-2']);
    attachGcTo([a], 'gc-2');
    expect(a.launch.gcIds).toEqual(['gc-1', 'gc-2']);
  });
});

describe('экран проверок', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="modal-root"></div>'; });

  const problemPre = () => launchPreflight({
    characters: [ch('a', 'Аа'), ch('b', 'Бб', { launch: {} }), ch('c', 'Вв')], ctx, clients: [win('Вв')], selfElevated: false
  });

  it('строки: запустятся, пропущены, нет GameCenter, нет входа', () => {
    const rows = preflightRows(problemPre());
    expect(rows.map(r => r.icon)).toEqual(['✅', '⏭', '❌']);
    expect(rows[0].text).toContain('Аа');
    expect(rows[1].text).toContain('Вв');
    expect(rows[2].text).toContain('Бб');
  });

  it('нет входа — строка блокирующая, кнопка обещает «остальных»', async () => {
    const pre = launchPreflight({
      characters: [ch('a', 'Аа'), noLogin('c', 'Вв'), ch('b', 'Бб', { launch: {} })], ctx, clients: []
    });
    const rows = preflightRows(pre);
    const login = rows.find(r => r.title.includes('не запомнен'));
    expect(login.level).toBe('error');
    expect(login.text).toContain('не запустятся');

    const p = openPreflight(pre);
    const btn = document.querySelector('[data-act="launch"]');
    expect(btn.textContent).toContain('Запустить остальных');
    expect(btn.textContent).toContain('(1)');          // запустится только «Аа»
    btn.click();
    expect(await p).toBe('launch');
  });

  it('кнопки: «Исправить и запустить» есть, когда есть что исправить; выбор возвращается', async () => {
    const p = openPreflight(problemPre(), { title: 'Запуск', gameCenters: ctx.gameCenters });
    expect(document.querySelector('[data-act="fix"]').textContent).toContain('Исправить и запустить');
    expect(document.querySelector('[data-act="launch"]').textContent).toContain('(1)');
    document.querySelector('[data-act="fix"]').click();
    expect(await p).toBe('fix');
  });

  it('«Запустить» и «Отмена»; без исправлений кнопки «Исправить» нет', async () => {
    const pre = launchPreflight({ characters: [ch('a', 'Аа')], ctx, clients: [] });
    const p = openPreflight(pre);
    expect(document.querySelector('[data-act="fix"]')).toBeNull();
    document.querySelector('[data-act="launch"]').click();
    expect(await p).toBe('launch');
    const q = openPreflight(pre);
    document.querySelector('[data-act="cancel"]').click();
    expect(await q).toBeNull();
  });

  it('закрытие крестиком — отмена; запускать некого — «Запустить» заблокирована', async () => {
    const pre = launchPreflight({ characters: [ch('a', 'Аа', { launch: {} })], ctx, clients: [] });
    const p = openPreflight(pre);
    expect(document.querySelector('[data-act="launch"]').disabled).toBe(true);
    document.querySelector('.tf-close').click();
    expect(await p).toBeNull();
  });
});
