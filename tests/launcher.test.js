import { describe, it, expect } from 'vitest';
import { launchCharacters, launchable } from '../js/modules/launcher/launch.js';
import { migrateState, SCHEMA_VERSION } from '../js/core/migrations.js';
import { normalizeCharacter } from '../js/core/state.js';

const ch = (id, gcPath) => ({ id, nick: id, launch: { gcPath } });

describe('launcher', () => {
  it('берёт только аккаунты с путём к GameCenter', () => {
    const list = [ch('a', 'D:\\GC1'), ch('b', ''), ch('c', '  '), { id: 'd' }, ch('e', 'D:\\GC2')];
    expect(launchable(list).map(c => c.id)).toEqual(['a', 'e']);
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

  it('передаёт ссылку и время ожидания клиента в команду запуска', async () => {
    const seen = [];
    const invoke = async (cmd, args) => { seen.push([cmd, args]); return {}; };
    await launchCharacters([ch('a', 'one')], { delayMs: 0, url: 'vkplay://play/0.61', waitSecs: 30 }, { invoke });
    expect(seen).toEqual([['launcher_start', { path: 'one', url: 'vkplay://play/0.61', waitSecs: 30 }]]);
  });

  it('миграция v7 добавляет launch.gcPath', () => {
    const { state, to } = migrateState({ schemaVersion: 6, characters: [{ id: 'x', nick: 'X' }] });
    expect(to).toBe(SCHEMA_VERSION);
    expect(state.characters[0].launch).toEqual({ gcPath: '' });
  });

  it('normalizeCharacter сохраняет путь и обрезает пробелы', () => {
    expect(normalizeCharacter({ nick: 'X', launch: { gcPath: '  D:\\GC1  ' } }).launch.gcPath).toBe('D:\\GC1');
    expect(normalizeCharacter({ nick: 'X' }).launch.gcPath).toBe('');
  });
});
