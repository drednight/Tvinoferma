import { describe, expect, it, vi } from 'vitest';
import { mergeRecord } from '../js/modules/cloudSync/mergeRecord.js';

const live = fields => ({ deleted: false, fields });
const deleted = () => ({ deleted: true });
const base = () => live({ nick: 'Герой', stats: { level: 10, coins: 100 }, note: 'до' });

function compare(local, remote, original = base()) {
  return mergeRecord({ base: original, local, remote });
}

describe('изолированное трёхстороннее сравнение одной сущности', () => {
  it('применяет изменение с одной стороны, сохраняя остальное', () => {
    const local = live({ nick: 'Новое имя', stats: { level: 10, coins: 100 }, note: 'до' });
    expect(compare(local, base())).toEqual({ record: local, conflicts: [] });
    expect(compare(base(), local)).toEqual({ record: local, conflicts: [] });
  });

  it('при совпадении изменений сторон не создаёт конфликт', () => {
    const updated = live({ nick: 'Одинаково', stats: { coins: 100, level: 10 }, note: 'до' });
    expect(compare(updated, updated)).toEqual({ record: updated, conflicts: [] });
  });

  it('не считает другой порядок ключей объекта изменением', () => {
    const reordered = live({ note: 'до', stats: { coins: 100, level: 10 }, nick: 'Герой' });
    const updated = live({ nick: 'Герой', stats: { level: 11, coins: 100 }, note: 'до' });
    expect(compare(reordered, updated)).toEqual({ record: updated, conflicts: [] });
  });

  it('объединяет независимые поля и вложенные поля относительно общей базы', () => {
    const local = live({ nick: 'Альфа', stats: { level: 11, coins: 100 }, note: 'до' });
    const remote = live({ nick: 'Герой', stats: { level: 10, coins: 150 }, note: 'с другого ПК' });
    expect(compare(local, remote)).toEqual({
      record: live({ nick: 'Альфа', stats: { level: 11, coins: 150 }, note: 'с другого ПК' }),
      conflicts: []
    });
  });

  it('различает отсутствующее поле и null', () => {
    const result = compare(live({ a: null }), live({ a: 'текст' }), live({}));
    expect(result.record).toBeNull();
    expect(result.conflicts).toEqual([
      {
        reason: 'field',
        path: ['a'],
        base: { present: false },
        local: { present: true, value: null },
        remote: { present: true, value: 'текст' }
      }
    ]);
  });

  it('показывает конфликт одного вложенного поля и не возвращает частичный результат', () => {
    const local = live({ nick: 'Локальное', stats: { level: 11, coins: 100 }, note: 'до' });
    const remote = live({ nick: 'Герой', stats: { level: 12, coins: 150 }, note: 'до' });
    const result = compare(local, remote);
    expect(result.record).toBeNull();
    expect(result.conflicts).toEqual([
      {
        reason: 'field',
        path: ['stats', 'level'],
        base: { present: true, value: 10 },
        local: { present: true, value: 11 },
        remote: { present: true, value: 12 }
      }
    ]);
  });

  it('возвращает все конфликтные поля, даже когда в названии поля есть точка', () => {
    const result = compare(
      live({ 'a.b': 1, c: { d: 1 } }),
      live({ 'a.b': 2, c: { d: 2 } }),
      live({ 'a.b': 0, c: { d: 0 } })
    );
    expect(result.record).toBeNull();
    expect(result.conflicts.map(item => item.path)).toEqual([['a.b'], ['c', 'd']]);
  });

  it('показывает удаление поля против его изменения', () => {
    const result = compare(live({}), live({ title: 'новое' }), live({ title: 'старое' }));
    expect(result.record).toBeNull();
    expect(result.conflicts[0]).toEqual({
      reason: 'delete-versus-edit',
      path: ['title'],
      base: { present: true, value: 'старое' },
      local: { present: false },
      remote: { present: true, value: 'новое' }
    });
  });

  it('безопасно удаляет поле, если другая сторона его не меняла', () => {
    const result = compare(
      live({ keep: true }),
      live({ title: 'старое', keep: false }),
      live({ title: 'старое', keep: true })
    );
    expect(result).toEqual({ record: live({ keep: false }), conflicts: [] });
  });

  it('не сливает массивы по индексам, если обе стороны меняли их по-разному', () => {
    const result = compare(live({ values: ['B'] }), live({ values: ['A', 'C'] }), live({ values: ['A', 'B'] }));
    expect(result.record).toBeNull();
    expect(result.conflicts[0]).toMatchObject({ reason: 'field', path: ['values'] });
  });

  it('не сливает несовместимые изменения типа и одновременно созданные разные объекты', () => {
    expect(compare(live({ x: { a: 1 } }), live({ x: { b: 2 } }), live({})).conflicts[0].path).toEqual(['x']);
    expect(compare(live({ x: { a: 1 } }), live({ x: 'text' }), live({ x: null })).conflicts[0].path).toEqual(['x']);
  });

  it('сохраняет метку удаления, если другая сторона не меняла запись', () => {
    expect(compare(deleted(), base())).toEqual({ record: deleted(), conflicts: [] });
    expect(compare(base(), deleted())).toEqual({ record: deleted(), conflicts: [] });
    expect(compare(deleted(), deleted())).toEqual({ record: deleted(), conflicts: [] });
  });

  it('показывает удаление сущности против правки, вместо выбора по времени', () => {
    const updated = live({ nick: 'Новое имя', stats: { level: 10, coins: 100 }, note: 'до' });
    const result = compare(deleted(), updated);
    expect(result.record).toBeNull();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      reason: 'delete-versus-edit',
      path: [],
      local: { present: true, value: deleted() },
      remote: { present: true, value: updated }
    });
  });

  it('не восстанавливает удалённую запись без отдельного подтверждения', () => {
    const result = compare(live({ nick: 'старое' }), deleted(), deleted());
    expect(result.record).toBeNull();
    expect(result.conflicts[0]).toMatchObject({ reason: 'restore-deleted' });
    expect(compare(live({ nick: 'старое' }), live({ nick: 'старое' }), deleted()).conflicts[0].reason).toBe(
      'restore-deleted'
    );
  });

  it('не считает пропавшую запись удалением, если она была в базе', () => {
    expect(() => compare(null, base())).toThrow('Неполная история');
    expect(() => compare(base(), null)).toThrow('Неполная история');
    expect(() => compare(null, deleted(), deleted())).toThrow('Неполная история');
  });

  it('добавляет новую сущность с одной стороны или одинаковую с двух', () => {
    const added = live({ nick: 'Новая' });
    expect(compare(added, null, null)).toEqual({ record: added, conflicts: [] });
    expect(compare(null, added, null)).toEqual({ record: added, conflicts: [] });
    expect(compare(added, added, null)).toEqual({ record: added, conflicts: [] });
    expect(compare(null, null, null)).toEqual({ record: null, conflicts: [] });
  });

  it('не объединяет разные сущности с одним id без общей истории', () => {
    const result = compare(live({ nick: 'А' }), live({ nick: 'Б' }), null);
    expect(result.record).toBeNull();
    expect(result.conflicts[0].reason).toBe('concurrent-create');
  });

  it('не трактует метку удаления без базы как бесконфликтное удаление', () => {
    expect(compare(deleted(), null, null).conflicts[0].reason).toBe('missing-base');
    expect(compare(deleted(), deleted(), null).conflicts[0].reason).toBe('missing-base');
  });

  it('отклоняет неизвестные поля и некорректные формы записей', () => {
    for (const invalid of [
      { deleted: false },
      { deleted: false, fields: [] },
      { deleted: true, fields: {} },
      { deleted: true, extra: true },
      { deleted: 'yes' },
      {},
      []
    ]) {
      expect(() => compare(invalid, base())).toThrow();
    }
    expect(() => mergeRecord({ base: null, local: undefined, remote: null })).toThrow();
  });

  it('не выполняет getters, не принимает опасные ключи и не печатает значения', () => {
    const getter = vi.fn(() => 'личная заметка');
    const fields = {
      get note() {
        return getter();
      }
    };
    expect(() => compare(live(fields), base())).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const unsafe = JSON.parse('{"__proto__":{"secret":"личная заметка"}}');
    expect(() => compare(live(unsafe), base())).toThrow();
    expect(Object.prototype.secret).toBeUndefined();
  });

  it('не меняет входы и не возвращает ссылки на них', () => {
    const original = base();
    const local = live({ nick: 'А', stats: { level: 10, coins: 100 }, note: 'до' });
    const remote = live({ nick: 'Герой', stats: { level: 10, coins: 200 }, note: 'до' });
    const before = JSON.stringify({ original, local, remote });
    const result = compare(local, remote, original);
    result.record.fields.stats.coins = 999;
    expect(JSON.stringify({ original, local, remote })).toBe(before);
  });

  it('отдаёт копии значений в конфликте, а не ссылки на исходные данные', () => {
    const local = live({ values: [{ a: 1 }] });
    const remote = live({ values: [{ a: 2 }] });
    const result = compare(local, remote, live({ values: [{ a: 0 }] }));
    result.conflicts[0].local.value[0].a = 999;
    expect(local.fields.values[0].a).toBe(1);
  });
});
