import { describe, it, expect } from 'vitest';
import { launchCharacters, launchable, launchPlan, loginStatusText } from '../js/modules/launcher/launch.js';
import { migrateState, SCHEMA_VERSION } from '../js/core/migrations.js';
import { normalizeCharacter } from '../js/core/state.js';

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
    expect(seen).toEqual([['launcher_start', { path: 'one', charId: 'a', nick: 'Twin', url: 'vkplay://play/0.61', waitSecs: 30 }]]);
    seen.length = 0;
    await launchCharacters([ch('b', 'two')], { delayMs: 0 }, { invoke });
    expect(seen[0][1]).toEqual({ path: 'two', charId: 'b', nick: null, url: null, waitSecs: null });
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
    expect(c.launch).toEqual({ gcPath: 'D:\\GC1', gcNick: 'Twin', gcAccount: true });
    expect(JSON.stringify(c)).not.toContain('SECRET');
    expect(normalizeCharacter({ nick: 'X' }).launch).toEqual({ gcPath: '', gcNick: '', gcAccount: false });
  });
});
