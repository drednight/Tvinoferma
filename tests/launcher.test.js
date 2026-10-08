import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { launchCharacters, launchable, launchPlan, loginStatusText, formatDuration, windowsWord, launchSummary, launchablePartyNames, closeReportText, canCloseElevated, launchWarnings, withoutSavedLogin, decorateNotice, inspectVerdict, inspectReportText, PROBE_TITLE } from '../js/modules/launcher/launch.js';
import { confirmModal } from '../js/core/ui.js';
import { charactersInParty } from '../js/modules/parties/membership.js';
import { migrateState, SCHEMA_VERSION } from '../js/core/migrations.js';
import { normalizeCharacter, normalizeState } from '../js/core/state.js';

const ch = (id, gcPath, extra = {}) => ({ id, nick: id, launch: { gcPath, ...extra } });

describe('launcher', () => {
  it('берёт только аккаунты с путём к GameCenter', () => {
    const list = [ch('a', 'D:\\GC1'), ch('b', ''), ch('c', '  '), { id: 'd' }, ch('e', 'D:\\GC2')];
    expect(launchable(list).map(c => c.id)).toEqual(['a', 'e']);
  });

  it('план запуска: кого запускаем и кого пропускаем', () => {
    const plan = launchPlan([ch('a', 'D:\\GC1'), ch('b', ''), { id: 'c' }]);
    expect(plan.ready.map(c => c.id)).toEqual(['a']);
    expect(plan.skipped.map(c => c.id)).toEqual(['b', 'c']);
    expect(launchPlan(null)).toEqual({ ready: [], skipped: [] });
  });

  it('запускает по очереди, ошибка одного не мешает остальным', async () => {
    const calls = [];
    const invoke = async (cmd, args) => {
      calls.push([cmd, args.path]);
      if (args.path === 'bad') throw new Error('Файл не найден');
      return 1;
    };
    const done = [];
    const res = await launchCharacters(
      [ch('a', 'one'), ch('b', 'bad'), ch('c', 'three')],
      { delayMs: 0, onDone: (e) => done.push(e.id) },
      { invoke }
    );
    expect(calls.map(c => c[1])).toEqual(['one', 'bad', 'three']);
    expect(res.map(r => r.ok)).toEqual([true, false, true]);
    expect(res[1].error).toBe('Файл не найден');
    expect(done).toEqual(['a', 'b', 'c']);
  });

  it('в команду запуска уходят путь, id и ник аккаунта (токена в JS нет), ссылка и время ожидания', async () => {
    const seen = [];
    const invoke = async (cmd, args) => { seen.push([cmd, args]); return {}; };
    await launchCharacters(
      [ch('a', 'one', { gcNick: 'Twin', gcAccount: true })],
      { delayMs: 0, url: 'vkplay://play/0.61', waitSecs: 30 },
      { invoke }
    );
    expect(seen).toEqual([['launcher_start', { path: 'one', charId: 'a', nick: 'Twin', url: 'vkplay://play/0.61', waitSecs: 30, windowTitle: 'a', iconSmall: null, iconBig: null }]]);
    seen.length = 0;
    await launchCharacters([ch('b', 'two')], { delayMs: 0 }, { invoke });
    expect(seen[0][1]).toEqual({ path: 'two', charId: 'b', nick: null, url: null, waitSecs: null, windowTitle: 'b', iconSmall: null, iconBig: null });
  });

  it('onStart вызывается по очереди, а не для всех сразу', async () => {
    const log = [];
    const invoke = async (cmd, args) => { log.push(`start:${args.charId}`); await new Promise(r => setTimeout(r, 5)); log.push(`end:${args.charId}`); };
    await launchCharacters([ch('a', '1'), ch('b', '2')], { delayMs: 0, onStart: (c) => log.push(`onStart:${c.id}`) }, { invoke });
    expect(log).toEqual(['onStart:a', 'start:a', 'end:a', 'onStart:b', 'start:b', 'end:b']);
  });

  it('отмена: ожидающие в очереди не запускаются', async () => {
    const signal = { cancelled: false };
    const started = [];
    const invoke = async (cmd, args) => { started.push(args.charId); signal.cancelled = true; };
    const res = await launchCharacters([ch('a', '1'), ch('b', '2'), ch('c', '3')], { delayMs: 0, signal }, { invoke });
    expect(started).toEqual(['a']);
    expect(res.map(r => [r.ok, r.cancelled])).toEqual([[true, false], [false, true], [false, true]]);
  });

  it('текст про сохранённый вход', () => {
    expect(loginStatusText(ch('a', 'x'))).toContain('Вход не запомнен');
    expect(loginStatusText(ch('a', 'x', { gcAccount: true, gcNick: 'Twin' }))).toContain('«Twin»');
    expect(loginStatusText(ch('a', 'x', { gcAccount: true }))).toContain('Вход запомнен.');
  });

  it('миграция v7 добавляет launch.gcPath', () => {
    const { state, to } = migrateState({ schemaVersion: 6, characters: [{ id: 'x', nick: 'X' }] });
    expect(to).toBe(SCHEMA_VERSION);
    expect(state.characters[0].launch).toEqual({ gcPath: '' });
  });

  it('normalizeCharacter: путь и ник обрезаются, признак входа сохраняется, токена в данных нет', () => {
    const c = normalizeCharacter({ nick: 'X', launch: { gcPath: '  D:\\GC1  ', gcNick: ' Twin ', gcAccount: true, gcMagic: 'SECRET' } });
    expect(c.launch).toEqual({ gcPath: 'D:\\GC1', gcNick: 'Twin', gcAccount: true, gcIds: [], gcAccounts: {} });
    expect(JSON.stringify(c)).not.toContain('SECRET');
    expect(normalizeCharacter({ nick: 'X' }).launch).toEqual({ gcPath: '', gcNick: '', gcAccount: false, gcIds: [], gcAccounts: {} });
  });
});

describe('launcher: итог запуска, трей', () => {
  it('длительность: секунды, минуты, часы', () => {
    expect(formatDuration(0)).toBe('0 с');
    expect(formatDuration(45400)).toBe('45 с');
    expect(formatDuration(60000)).toBe('1 мин');
    expect(formatDuration(72000)).toBe('1 мин 12 с');
    expect(formatDuration(3900000)).toBe('1 ч 05 мин');
    expect(formatDuration(-5)).toBe('0 с');
  });

  it('склонение «окно»', () => {
    expect([0, 1, 2, 4, 5, 11, 12, 21, 22, 25].map(windowsWord))
      .toEqual(['окон', 'окно', 'окна', 'окна', 'окон', 'окон', 'окон', 'окно', 'окна', 'окон']);
  });

  it('одна строка итога: сколько окон и за какое время; ошибки и пропуски — в конце', () => {
    expect(launchSummary({ ok: 3, ms: 72000 })).toBe('Запущено 3 окна за 1 мин 12 с');
    expect(launchSummary({ ok: 1, ms: 9000 })).toBe('Запущено 1 окно за 9 с');
    expect(launchSummary({ ok: 5, failed: 1, cancelled: 2, skipped: 1, ms: 30000 }))
      .toBe('Запущено 5 окон за 30 с, с ошибкой: 1, отменено: 2, без пути к GameCenter: 1');
  });

  it('в меню трея попадают только пати, где есть кого запускать, в порядке вкладки «Пати»', () => {
    const parties = [{ id: 'p2', name: 'Вторая', order: 2 }, { id: 'p1', name: 'Первая', order: 1 }, { id: 'p3', name: 'Пустая', order: 3 }];
    const chars = [
      { id: 'a', partyIds: ['p1'], launch: { gcPath: 'D:\\GC1' } },
      { id: 'b', partyIds: ['p2'], launch: { gcPath: '' } },
      { id: 'c', partyIds: ['p3'], launch: { gcPath: 'D:\\GC3' } }
    ];
    expect(launchablePartyNames(parties, chars, charactersInParty)).toEqual(['Первая', 'Пустая']);
    expect(launchablePartyNames([], chars, charactersInParty)).toEqual([]);
  });

  it('настройка «показывать итог» включена по умолчанию и сохраняется', () => {
    expect(normalizeState({ characters: [], settings: {} }).settings.launcher.notify).toBe(true);
    expect(normalizeState({ characters: [], settings: { launcher: { notify: false } } }).settings.launcher.notify).toBe(false);
  });

  it('трей: пункты меню и префикс пати совпадают у Rust и интерфейса', () => {
    const rust = readFileSync('src-tauri/src/tray.rs', 'utf8');
    const desk = readFileSync('js/desktop/desktop.js', 'utf8');
    expect(rust).toContain('LAUNCH_PREFIX: &str = "launch-party:"');
    expect(desk).toContain("'launch-party:'");
    expect(rust).toContain('"close-game"');
    expect(rust).toContain('"game-closed"');
    expect(desk).toContain("'game-closed'");
    expect(rust).toContain('set_tray_parties');
    expect(readFileSync('src-tauri/src/lib.rs', 'utf8')).toContain('tray::set_tray_parties');
  });

  it('трей → «Скрипты»: промокод, передача предметов и активация подарков доходят до интерфейса', () => {
    const rust = readFileSync('src-tauri/src/tray.rs', 'utf8');
    const desk = readFileSync('js/desktop/desktop.js', 'utf8');
    expect(rust).toContain('PROMO_ACTION: &str = "promo"');
    expect(rust).toContain('TRANSFER_ACTION: &str = "transfer"');
    expect(rust).toContain('SHOP_ACTION: &str = "shop"');
    expect(rust).toContain('🪙 Активация подарков');
    expect(rust).toContain('&auth, &balance, &promo, &transfer, &shop, &caravan, &marathons');
    expect(rust).toContain('action == SHOP_ACTION');
    expect(rust).toContain('CARAVAN_ACTION: &str = "caravan"');
    expect(rust).toContain('🧰 Сундук караванщика');
    expect(rust).toContain('action == CARAVAN_ACTION');
    expect(desk).toContain("action === 'caravan'");
    expect(desk).toContain('openCaravanDialog');
    expect(rust).toContain('Ввести промокод');
    expect(rust).toContain('Передать предметы в игру');
    expect(desk).toContain("action === 'promo'");
    expect(desk).toContain("action === 'transfer'");
    expect(desk).toContain("action === 'shop'");
    expect(desk).toContain('openShopDialog');
    expect(desk).toContain('openPromoDialog');
    expect(desk).toContain('openTransferDialog');
  });

  it('итог закрытия окон: ничего не было, всё закрыто, часть не поддалась, ошибка поиска', () => {
    expect(closeReportText({ found: 0 })).toBe('Окон игры не запущено');
    expect(closeReportText({ found: 2, closed: 2, failed: 0 })).toBe('Закрыто окон игры: 2');
    expect(closeReportText({ found: 3, closed: 1, failed: 2 })).toContain('Закрыто 1 из 3');
    expect(closeReportText({ found: 3, closed: 1, failed: 2, denied: 2 })).toContain('нужны права администратора');
    expect(closeReportText({ found: 3, closed: 1, failed: 2, denied: 2, elevated: true })).not.toContain('нужны права');
    expect(closeReportText({ found: 2, closed: 0, failed: 2, details: ['PID 7: код ошибки Windows 1'] })).toContain('PID 7');
    expect(canCloseElevated({ found: 2, failed: 2, denied: 2 })).toBe(true);
    expect(canCloseElevated({ found: 2, failed: 2, denied: 2, elevated: true })).toBe(false);
    expect(canCloseElevated({ found: 2, failed: 2, denied: 0 })).toBe(false);
    expect(closeReportText({ error: 'tasklist: не найден' })).toContain('tasklist');
  });

  it('подтверждение в стиле приложения: «ОК» — да, «Отмена»/Esc — нет, окно убирается', async () => {
    const ask = () => confirmModal({ title: 'Закрыть?', text: 'Будет закрыто окон: 2', okText: 'Закрыть (2)', danger: true });
    let p = ask();
    expect(document.querySelector('.tf-confirm .modal-body').textContent).toContain('окон: 2');
    document.querySelector('[data-act="ok"]').click();
    expect(await p).toBe(true);
    expect(document.querySelector('.tf-confirm')).toBeNull();
    p = ask();
    document.querySelector('[data-act="cancel"]').click();
    expect(await p).toBe(false);
    p = ask();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBe(false);
    expect(document.querySelector('.tf-confirm-overlay')).toBeNull();
  });
});

describe('launcher: подпись окон и закрытие чужих GameCenter', () => {
  it('подпись, которая не удалась, объясняется человеческими словами', () => {
    expect(decorateNotice({ title: 'Ник — Маг', status: 'ok' })).toBeNull();
    expect(decorateNotice({ title: 'Ник — Маг', status: 'denied', code: 5 })).toMatch(/администратора/);
    expect(decorateNotice({ title: 'Ник — Маг', status: 'denied', code: 5 })).toContain('«Ник — Маг»');
    expect(decorateNotice({ title: 'Ник', status: 'failed', code: 1460 })).toContain('1460');
    expect(decorateNotice({ title: 'Ник', status: 'missing' })).toContain('90 с');
    expect(decorateNotice(undefined)).toBeNull();
  });

  it('предупреждения запуска: закрытый чужой GameCenter и GameCenter от администратора', () => {
    expect(launchWarnings(undefined)).toEqual([]);
    expect(launchWarnings({ closedOtherGc: 0, gcCloseFailed: 0 })).toEqual([]);
    expect(launchWarnings({ closedOtherGc: 1 })[0]).toContain('другой папки');
    expect(launchWarnings({ gcCloseFailed: 1 })[0]).toContain('от администратора');
  });

  it('считаются запуски без запомненного входа', () => {
    const ok = (switched) => ({ ok: true, info: { switched } });
    expect(withoutSavedLogin([ok(true), ok(false), ok(false), { ok: false, info: { switched: false } }, { ok: true }])).toBe(2);
    expect(withoutSavedLogin(undefined)).toBe(0);
  });

  it('ответ Rust (info) доходит до итога запуска', async () => {
    const info = { switched: true, closedOtherGc: 1 };
    const [r] = await launchCharacters(
      [ch('a', 'D:\\GC1')],
      { delayMs: 0, decorate: false },
      { invoke: async () => info }
    );
    expect(r.info).toEqual(info);
  });
});

describe('launcher.rs: GameCenter из других папок и итог подписи', () => {
  const rs = readFileSync('src-tauri/src/launcher.rs', 'utf8');
  it('перед запуском закрываются чужие GameCenter, а итог подписи уходит событием', () => {
    expect(rs).toContain('close_gamecenters(&exe, magic.is_some())');
    expect(rs).toContain('"launcher-decorate"');
    expect(rs).toContain('closed_other_gc');
  });
});

describe('launcher: проверка окон игры', () => {
  const win = (over = {}) => ({ hwnd: '0x1', class: 'ElementClient Window', title: 'Perfect World', visible: true, tool: false, owned: false, hung: false, app: false, hasSmallIcon: true, hasBigIcon: true, titleError: null, titleAfter: PROBE_TITLE, iconError: null, ...over });
  const report = (client, selfElevated = false) => ({ selfElevated, clients: [{ pid: 10, elevated: false, windows: [win()], ...client }] });

  it('нет игры — просим запустить', () => {
    expect(inspectVerdict({ selfElevated: false, clients: [] })[0]).toContain('не найдено');
  });

  it('игра от администратора, Твиноферма нет — главная причина названа прямо', () => {
    const v = inspectVerdict(report({ elevated: true }));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('от администратора');
    expect(v[0]).toContain('Запустите Твиноферму от имени администратора');
    // у обоих права администратора — причина другая, так что вывод её не повторяет
    expect(inspectVerdict(report({ elevated: true }, true)).join(' ')).not.toContain('Запустите Твиноферму от имени');
  });

  it('всё в порядке: подсказка про группировку кнопок панели задач', () => {
    const v = inspectVerdict(report({}));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Группировать кнопки');
  });

  it('называет конкретную неполадку окна', () => {
    expect(inspectVerdict(report({ windows: [win({ titleError: 1460 })] })).join(' ')).toContain('1460');
    expect(inspectVerdict(report({ windows: [win({ titleAfter: 'Perfect World' })] })).join(' ')).toContain('обрабатывает его по-своему');
    expect(inspectVerdict(report({ windows: [win({ iconError: 5 })] })).join(' ')).toContain('значок не принимается');
    expect(inspectVerdict(report({ windows: [win({ tool: true })] })).join(' ')).toContain('окно-инструмент');
    expect(inspectVerdict(report({ windows: [win({ hung: true })] })).join(' ')).toContain('не отвечает');
    expect(inspectVerdict(report({ windows: [win({ visible: false })] })).join(' ')).toContain('нет видимого окна');
  });

  it('текст отчёта содержит права, окна, значки и вывод', () => {
    const text = inspectReportText(report({}));
    expect(text).toContain('Твиноферма: обычные права');
    expect(text).toContain('PID 10 — обычные права');
    expect(text).toContain('«Perfect World»');
    expect(text).toContain('значки: свои (малый, большой)');
    expect(text).toContain('Вывод:');
    expect(inspectReportText(report({ windows: [win({ hasSmallIcon: false, hasBigIcon: false })] }))).toContain('своих нет');
  });

  it('Rust ставит пробный заголовок, который ждёт интерфейс', () => {
    const rs = readFileSync('src-tauri/src/launcher.rs', 'utf8');
    expect(rs).toContain(`const PROBE_TITLE: &str = "${PROBE_TITLE}"`);
  });
});
