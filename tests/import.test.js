import { describe, it, expect } from 'vitest';
import { planImport, liftLegacyContacts, mergeFinance } from '../js/data/import.js';
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

describe('импорт: совпадение с архивом', () => {
  it('персонаж, уже лежащий в архиве, не считается новым и обновляет архивную запись', () => {
    const archived = [ch({ id: 'Bob', nick: 'Bob', level: 10 })];
    const incoming = [ch({ id: 'Bob', nick: 'Bob', level: 20 })];
    const plan = planImport([], incoming, () => null, archived);
    expect(plan.added).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].archived).toBe(true);
    expect(plan.conflicts[0].local.id).toBe('Bob');
    expect(plan.conflicts[0].diffs.map(f => f.path)).toEqual(['level']);
  });

  it('идентичный архивный персонаж пропускается — дубликат не создаётся', () => {
    const archived = [ch({ id: 'Bob', nick: 'Bob', level: 10 })];
    const incoming = [ch({ id: 'Bob', nick: 'Bob', level: 10 })];
    const plan = planImport([], incoming, () => null, archived);
    expect(plan.added).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.identical).toHaveLength(1);
    expect(plan.identical[0].archived).toBe(true);
  });

  it('совпадение с архивом по нику без учёта регистра, даже если id разные', () => {
    const archived = [ch({ id: 'old-uuid', nick: 'Bob' })];
    const incoming = [ch({ id: 'bob', nick: 'BOB', level: 11 })];
    const plan = planImport([], incoming, () => null, archived);
    expect(plan.added).toHaveLength(0);
    expect(plan.conflicts[0].local.id).toBe('old-uuid');
    expect(plan.conflicts[0].archived).toBe(true);
  });

  it('активный персонаж в приоритете над архивным с тем же ником', () => {
    const active = [ch({ id: 'Bob', nick: 'Bob', level: 10 })];
    const archived = [ch({ id: 'Bob-2', nick: 'Bob', level: 30 })];
    const incoming = [ch({ id: 'Bob', nick: 'Bob', level: 20 })];
    const plan = planImport(active, incoming, () => null, archived);
    expect(plan.conflicts[0].local.id).toBe('Bob');
    expect(plan.conflicts[0].archived).toBe(false);
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

describe('импорт: слияние финансов', () => {
  const op = (id, over = {}) => ({ id, date: '2026-01-05', kind: 'in', amount: 100, currency: 'gold', ...over });
  const fin = (ops = [], settings = {}) => ({ operations: ops, shopItems: [], loans: [], settings });

  it('реестры объединяются по id, дубль не создаётся, при дубле берётся локальная запись', () => {
    const local = fin([op('a', { amount: 100 }), op('b')]);
    const incoming = fin([op('a', { amount: 999 }), op('c')]);
    const merged = mergeFinance(local, incoming);
    expect(merged.operations.map(o => o.id).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.operations.find(o => o.id === 'a').amount).toBe(100);
  });

  it('настройки: не затирает локальный более свежий курс', () => {
    const local = fin([], { goldRate: 5, goldRateAt: '2026-02-01', commissionPct: 3 });
    const incoming = fin([], { goldRate: 1, goldRateAt: '2026-01-01', commissionPct: 2 });
    expect(mergeFinance(local, incoming).settings.goldRate).toBe(5);
  });

  it('настройки: более свежий курс файла побеждает', () => {
    const local = fin([], { goldRate: 1, goldRateAt: '2026-01-01' });
    const incoming = fin([], { goldRate: 7, goldRateAt: '2026-03-01' });
    expect(mergeFinance(local, incoming).settings.goldRate).toBe(7);
  });

  it('пустой файл не трогает локальные финансы', () => {
    const local = fin([op('a')], { goldRate: 5, goldRateAt: '2026-02-01' });
    const merged = mergeFinance(local, fin());
    expect(merged.operations.map(o => o.id)).toEqual(['a']);
    expect(merged.settings.goldRate).toBe(5);
  });

  it('поправки месяцев и начальный остаток едут из файла даже при старом курсе', () => {
    const local = fin([], { goldRate: 5, goldRateAt: '2026-02-01' });
    const incoming = fin([], {
      goldRate: 1,
      goldRateAt: '2026-01-01',
      opening: { gold: 100 },
      monthAdjust: { '2026-09': { gold: 500 } },
      monthCarry: { '2026-09': { gold: 400 } }
    });
    const merged = mergeFinance(local, incoming);
    expect(merged.settings.goldRate).toBe(5);
    expect(merged.settings.opening.gold).toBe(100);
    expect(merged.settings.monthAdjust).toEqual({ '2026-09': { gold: 500 } });
    expect(merged.settings.monthCarry).toEqual({ '2026-09': { gold: 400 } });
  });
});
