import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateState, detectVersion, SCHEMA_VERSION } from '../js/migrations.js';
import { normalizeState, normalizeTags } from '../js/state.js';

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
    expect(applied).toEqual([3]);
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.version).toBeUndefined();
    expect(state.exportedAt).toBeUndefined();
    expect(state.characters.every(c => Array.isArray(c.tags))).toBe(true);
    expect(raw.version).toBe(2); // исходные данные не мутируются
  });

  it('v1: партии-строки получают порядок', () => {
    const { state, applied } = migrateState({ parties: ['A', { name: 'B' }], characters: [] });
    expect(applied).toEqual([2, 3]);
    expect(state.parties).toEqual([{ name: 'A', order: 1 }, { name: 'B', order: 2 }]);
  });

  it('данные из более новой версии не трогаются', () => {
    const raw = { schemaVersion: SCHEMA_VERSION + 1, characters: [{ id: 'x' }] };
    const r = migrateState(raw);
    expect(r.newer).toBe(true);
    expect(r.state).toBe(raw);
  });

  it('повторная миграция ничего не делает', () => {
    const once = migrateState(fixture('state-v2.json')).state;
    const twice = migrateState(once);
    expect(twice.applied).toEqual([]);
    expect(twice.state).toEqual(once);
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
