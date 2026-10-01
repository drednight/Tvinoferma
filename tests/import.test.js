import { describe, it, expect } from 'vitest';
import { planImport, liftLegacyContacts } from '../js/data/import.js';
import { diffCharacters, buildMerged, presentPaths, mergeValues, ALL_FIELDS } from '../js/data/characterFields.js';
import { normalizeCharacter } from '../js/core/state.js';

const ch = (over = {}) => normalizeCharacter({ id: 'Bob', nick: 'Bob', level: 10, ...over });

describe('импорт: сопоставление', () => {
  it('новые, совпадающие и одинаковые', () => {
    const local = [ch(), ch({ id: 'Ann', nick: 'Ann' })];
    const incoming = [ch({ level: 20 }), ch({ id: 'Ann', nick: 'Ann' }), ch({ id: 'Zed', nick: 'Zed' })];
    const plan = planImport(local, incoming);
    expect(plan.added.map(c => c.id)).toEqual(['Zed']);
    expect(plan.identical).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].diffs.map(f => f.path)).toEqual(['level']);
  });

  it('совпадение по нику без учёта регистра, даже если id разные', () => {
    const plan = planImport([ch({ id: 'old-uuid' })], [ch({ id: 'bob', nick: 'BOB', level: 11 })]);
    expect(plan.added).toHaveLength(0);
    expect(plan.conflicts[0].local.id).toBe('old-uuid');
  });

  it('поля, которых нет в файле, не считаются отличиями', () => {
    const local = ch({ contacts: { email: 'a@a', password: 'secret' }, stats: { pa: 5 } });
    const raw = { id: 'Bob', nick: 'Bob', level: 10, contacts: { email: 'a@a' } }; // без пароля и статов
    const incoming = normalizeCharacter(raw);
    expect(diffCharacters(local, incoming).map(f => f.path)).toContain('contacts.password');
    expect(diffCharacters(local, incoming, presentPaths(raw))).toEqual([]);
  });
});

describe('импорт: сборка карточки', () => {
  it('берёт выбранные поля из файла, остальные — из текущей', () => {
    const local = ch({ class: 'Маг', stats: { pa: 1, pz: 1 } });
    const inc = ch({ class: 'Жрец', stats: { pa: 9, pz: 9 } });
    const merged = buildMerged(local, inc, { 'stats.pa': 'incoming' });
    expect(merged.stats.pa).toBe(9);
    expect(merged.stats.pz).toBe(1);
    expect(merged.class).toBe('Маг');
    expect(merged.id).toBe('Bob');
  });

  it('объединяет теги и историю монет', () => {
    const tags = ALL_FIELDS.find(f => f.path === 'tags');
    expect(mergeValues(tags, ['a', 'B'], ['b', 'c'])).toEqual(['a', 'B', 'c']);
    const hist = ALL_FIELDS.find(f => f.path === 'coinHistory');
    const merged = mergeValues(hist, [{ id: '1', date: '2024-01-01' }], [{ id: '1', date: '2024-01-01' }, { id: '2', date: '2024-02-01' }]);
    expect(merged.map(h => h.id)).toEqual(['2', '1']);
  });

  it('старый формат гибкого экспорта: email/password переносятся в contacts', () => {
    const out = liftLegacyContacts({ characters: [{ id: 'x', nick: 'X', email: 'e@e', password: 'p' }] });
    expect(out.characters[0]).toEqual({ id: 'x', nick: 'X', contacts: { email: 'e@e', password: 'p' } });
  });
});
