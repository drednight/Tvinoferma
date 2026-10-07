import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateState, detectVersion, SCHEMA_VERSION } from '../js/core/migrations.js';
import { normalizeState, normalizeTags, NOTES_MAX_LENGTH } from '../js/core/state.js';

const fixture = (name) => JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8'));

describe('migrateState', () => {
  it('определяет версию по schemaVersion или старому полю version', () => {
    expect(detectVersion({ version: 2 })).toBe(2);
    expect(detectVersion({ schemaVersion: 3, version: 2 })).toBe(3);
    expect(detectVersion({})).toBe(1);
  });

  it('v2 → текущая: теги, служебные поля экспорта убраны', () => {
    const raw = fixture('state-v2.json');
    const { state, from, applied, newer } = migrateState(raw);
    expect(from).toBe(2);
    expect(newer).toBe(false);
    expect(applied).toEqual([3, 4, 5, 6, 7, 8]);
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.version).toBeUndefined();
    expect(state.exportedAt).toBeUndefined();
    expect(state.characters.every(c => Array.isArray(c.tags))).toBe(true);
    expect(state.archivedCharacters).toEqual([]);
    expect(state.archivedParties).toEqual([]);
    expect(raw.version).toBe(2); // исходные данные не мутируются
  });

  it('v1: партии-строки получают порядок', () => {
    const { state, applied } = migrateState({ parties: ['A', { name: 'B' }], characters: [] });
    expect(applied).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(state.parties.map(p => ({ name: p.name, order: p.order }))).toEqual([{ name: 'A', order: 1 }, { name: 'B', order: 2 }]);
    expect(state.parties.every(p => typeof p.id === 'string' && p.id)).toBe(true);
  });

  it('данные из более новой версии не трогаются', () => {
    const raw = { schemaVersion: SCHEMA_VERSION + 1, characters: [{ id: 'x' }] };
    const r = migrateState(raw);
    expect(r.newer).toBe(true);
    expect(r.state).toBe(raw);
  });

  it('v7 получает пустые архивы, а normalizeState сохраняет связи архивной пати', () => {
    const upgraded = migrateState({ schemaVersion: 7, characters: [], parties: [] });
    expect(upgraded.state.archivedCharacters).toEqual([]);
    expect(upgraded.state.archivedParties).toEqual([]);

    const normalized = normalizeState({
      schemaVersion: SCHEMA_VERSION,
      parties: [{ id: 'active-party', name: 'Активная' }],
      archivedParties: [{
        id: 'archived-party',
        name: 'Архивная',
        memberLinks: [{ characterId: 'archived-char', isMain: true, order: null }]
      }],
      characters: [{ id: 'active-char', nick: 'Активный', partyIds: ['archived-party'] }],
      archivedCharacters: [{ id: 'archived-char', nick: 'Архивный', partyIds: ['archived-party'] }]
    });
    expect(normalized.archivedParties[0].memberLinks).toEqual([
      { characterId: 'archived-char', isMain: true, order: null }
    ]);
    expect(normalized.characters[0].partyIds).toEqual(['archived-party']);
    expect(normalized.archivedCharacters[0].partyIds).toEqual(['archived-party']);
  });

  it('повторная миграция ничего не делает', () => {
    const once = migrateState(fixture('state-v2.json')).state;
    const twice = migrateState(once);
    expect(twice.applied).toEqual([]);
    expect(twice.state).toEqual(once);
  });
});

describe('миграция v5: partyIds и notes (issues #4, #20)', () => {
  const v4 = () => ({
    schemaVersion: 4,
    parties: [{ id: 'p1', name: 'Основа', order: 1 }, { name: 'Крипы', order: 2 }],
    characters: [
      { id: 'A', nick: 'A', party: 'основа' },            // регистр не важен
      { id: 'B', nick: 'B', party: 'Крипы' },             // у партии не было id
      { id: 'C', nick: 'C', party: 'Неявная' },           // партии нет в списке — создаётся
      { id: 'D', nick: 'D', party: null }
    ]
  });

  it('party (название) → partyIds (id), поле party удаляется, notes по умолчанию пустые', () => {
    const { state, applied } = migrateState(v4());
    expect(applied).toEqual([5, 6, 7, 8]);
    const id = (name) => state.parties.find(p => p.name === name).id;
    expect(state.parties.every(p => p.id)).toBe(true);
    expect(state.parties.find(p => p.name === 'Основа').id).toBe('p1');
    const by = Object.fromEntries(state.characters.map(c => [c.id, c]));
    expect(by.A.partyIds).toEqual(['p1']);
    expect(by.A.mainPartyId).toBe('p1');
    expect(by.D.mainPartyId).toBe(null);
    expect(by.B.partyIds).toEqual([id('Крипы')]);
    expect(by.C.partyIds).toEqual([id('Неявная')]);
    expect(by.D.partyIds).toEqual([]);
    expect(state.characters.every(c => !('party' in c) && c.notes === '')).toBe(true);
    expect(state.parties.find(p => p.name === 'Неявная').order).toBe(3);
  });

  it('повторная миграция ничего не меняет, существующие notes и partyIds сохраняются', () => {
    const once = migrateState(v4()).state;
    once.characters[0].notes = 'докачать';
    const twice = migrateState(once);
    expect(twice.applied).toEqual([]);
    expect(twice.state.characters[0].notes).toBe('докачать');
    expect(twice.state.characters[0].partyIds).toEqual(['p1']);
  });

  it('normalizeState: несуществующие id партий убираются, примечание обрезается по лимиту', () => {
    const st = normalizeState({ schemaVersion: 5, parties: [{ id: 'p1', name: 'X' }], characters: [
      { id: 'a', nick: 'A', partyIds: ['p1', 'ghost', 'p1'], notes: 'я'.repeat(NOTES_MAX_LENGTH + 10) }
    ] });
    expect(st.characters[0].partyIds).toEqual(['p1']);
    expect(st.characters[0].notes).toHaveLength(NOTES_MAX_LENGTH);
  });
});

describe('миграция v6: порог свежести входа 24 ч (issue #16)', () => {
  it('старое значение по умолчанию 12 ч заменяется на 24 ч, остальные не трогаются', () => {
    const run = (freshness) => migrateState({ schemaVersion: 5, settings: { freshness }, characters: [] }).state.settings.freshness;
    expect(run({ balanceHours: 24, loginHours: 12, marathonHours: 24 })).toEqual({ balanceHours: 24, loginHours: 24, marathonHours: 24 });
    expect(run({ balanceHours: 6, loginHours: 18, marathonHours: 48 })).toEqual({ balanceHours: 6, loginHours: 18, marathonHours: 48 });
  });

  it('без settings.freshness миграция не падает', () => {
    expect(() => migrateState({ schemaVersion: 5, characters: [] })).not.toThrow();
    expect(() => migrateState({ schemaVersion: 5, settings: {}, characters: [] })).not.toThrow();
  });
});

describe('normalizeState', () => {
  it('большой фикстур загружается без потерь персонажей и марафонов', () => {
    const raw = fixture('state-v2-large.json');
    const st = normalizeState(raw);
    expect(st.schemaVersion).toBe(SCHEMA_VERSION);
    expect(st.characters).toHaveLength(raw.characters.length);
    expect(st.marathons.length).toBe((raw.marathons || []).length);
    expect(st.settings.scripts.concurrency).toBe(3);
  });

  it('сохраняет все характеристики и теги', () => {
    const st = normalizeState({ characters: [{ id: 'c', nick: 'N', stats: { hp: '100', critChance: 5 }, tags: ['твин', ' Твин ', 'крафт'] }] });
    expect(st.characters[0].stats).toMatchObject({ hp: 100, critChance: 5, pa: 0 });
    expect(st.characters[0].tags).toEqual(['твин', 'крафт']);
  });
});

describe('normalizeTags', () => {
  it('строка через запятую', () => {
    expect(normalizeTags('a,  b , ,A, c  d')).toEqual(['a', 'b', 'c d']);
  });
});

describe('миграция v7: путь GameCenter у каждого аккаунта', () => {
  it('у каждого персонажа появляется launch.gcPath, пробелы обрезаются, существующий путь сохраняется', () => {
    const raw = {
      schemaVersion: 6,
      characters: [{ id: 'a' }, { id: 'b', launch: { gcPath: '  D:\\GC  ' } }, { id: 'c', launch: null }]
    };
    const { state, applied } = migrateState(raw);
    expect(applied).toEqual([7, 8]);
    expect(state.characters.map(c => c.launch.gcPath)).toEqual(['', 'D:\\GC', '']);
    expect(raw.characters[0].launch).toBeUndefined(); // исходные данные не мутируются
  });
});

describe('цепочка миграций для релиза 1.0', () => {
  it('самый старый формат (пустой объект) доходит до текущей схемы без падений', () => {
    const { state, from, to, applied } = migrateState({});
    expect(from).toBe(1);
    expect(to).toBe(SCHEMA_VERSION);
    expect(applied).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(state.characters).toEqual([]);
    expect(state.parties).toEqual([]);
    expect(state.marathons).toEqual([]);
  });

  it('персонаж со старыми полями (party, ник с #) сохраняется со всеми данными', () => {
    const raw = { version: 2, characters: [{ id: 'Dragon#1', nick: 'Dragon#1', party: 'Рейд', notes: 'важно' }], parties: [] };
    const { state } = migrateState(raw);
    const [c] = state.characters;
    expect(c.id).toBe('Dragon_1');
    expect(c.notes).toBe('важно');
    expect(state.parties.map(p => p.name)).toEqual(['Рейд']);
    expect(c.partyIds).toEqual([state.parties[0].id]);
    expect(c.party).toBeUndefined();
  });

  it('мусор вместо данных не ломает загрузку', () => {
    for (const bad of [null, undefined, 42, 'text', []]) {
      expect(() => migrateState(bad)).not.toThrow();
    }
  });

  it('нормализация после миграции не теряет персонажей и марафоны на крупной фикстуре', () => {
    const { state } = migrateState(fixture('state-v2.json'));
    const normalized = normalizeState(state);
    expect(normalized.characters.length).toBe(state.characters.length);
    expect(normalized.marathons.length).toBe(state.marathons.length);
  });
});
