import { describe, expect, it, vi } from 'vitest';
import { createSelectiveRecordReview } from '../js/modules/cloudSync/selectiveRecordReview.js';

const live = fields => ({ deleted: false, fields });
const tombstone = () => ({ deleted: true });
const review = (base, local, remote) => createSelectiveRecordReview({ base, local, remote });
const changes = result => result.map(({ path, kind, reason }) => ({ path, kind, ...(reason ? { reason } : {}) }));

describe('предварительный выбор входящих изменений одной записи', () => {
  it('применяет только выбранное к кандидату и сохраняет локальные и ожидающие правки', () => {
    const base = live({ title: 'Событие', note: 'до', statusByDate: { '2026-11-01': 'todo' }, coins: 100 });
    const local = live({ title: 'Моё событие', note: 'до', statusByDate: { '2026-11-01': 'todo' }, coins: 100 });
    const remote = live({ title: 'Событие', note: 'с другого ПК', statusByDate: { '2026-11-01': 'done' }, coins: 100 });
    const before = JSON.stringify({ base, local, remote });
    const comparison = review(base, local, remote);
    expect(comparison.changes()).toEqual([
      { path: ['note'], kind: 'change_field' },
      { path: ['statusByDate', '2026-11-01'], kind: 'change_field' }
    ]);

    const result = comparison.plan({ selected: [['statusByDate', '2026-11-01']] });
    expect(result.status).toBe('planned');
    expect(result.record).toEqual(
      live({ title: 'Моё событие', note: 'до', statusByDate: { '2026-11-01': 'done' }, coins: 100 })
    );
    expect(result.applied).toEqual([{ path: ['statusByDate', '2026-11-01'], kind: 'change_field' }]);
    expect(result.pending).toEqual([{ path: ['note'], kind: 'change_field' }]);
    expect(result.blocked).toEqual([]);
    expect(JSON.stringify({ base, local, remote })).toBe(before);

    // Повторное сравнение здесь возможно лишь с исходной базой; реальная история ещё не ведётся.
    const later = review(base, result.record, remote);
    expect(later.changes()).toEqual([{ path: ['note'], kind: 'change_field' }]);
    const completed = later.plan({ selected: [['note']] });
    expect(completed.record.fields).toEqual({
      title: 'Моё событие',
      note: 'с другого ПК',
      statusByDate: { '2026-11-01': 'done' },
      coins: 100
    });
    expect(completed.pending).toEqual([]);
  });

  it('ничего не выбирает автоматически; одинаковые и только локальные правки не входящие', () => {
    const base = live({ localOnly: 1, equal: 1, incoming: 1 });
    const local = live({ localOnly: 2, equal: 2, incoming: 1 });
    const remote = live({ localOnly: 1, equal: 2, incoming: 2 });
    const result = review(base, local, remote).plan({ selected: [] });
    expect(result).toEqual({
      status: 'planned',
      record: local,
      applied: [],
      pending: [{ path: ['incoming'], kind: 'change_field' }],
      blocked: []
    });
  });

  it('при независимом добавлении поля различает отсутствие и null', () => {
    const comparison = review(live({}), live({ local: null }), live({ cloud: null }));
    expect(comparison.changes()).toEqual([{ path: ['cloud'], kind: 'add_field' }]);
    expect(comparison.plan({ selected: [['cloud']] }).record).toEqual(live({ local: null, cloud: null }));
  });

  it('обрабатывает ключи с точкой как точные пути, а не как строки с разделителем', () => {
    const base = live({ 'a.b': 0, a: { b: 0 } });
    const remote = live({ 'a.b': 1, a: { b: 2 } });
    const result = review(base, base, remote).plan({ selected: [['a.b']] });
    expect(result.record).toEqual(live({ 'a.b': 1, a: { b: 0 } }));
    expect(result.pending).toEqual([{ path: ['a', 'b'], kind: 'change_field' }]);
  });

  it('массив выбирается целиком, изменения с обеих сторон не смешиваются по индексам', () => {
    const base = live({ items: ['A', 'B'], note: 'до' });
    const local = live({ items: ['B'], note: 'до' });
    const remote = live({ items: ['A', 'B', 'C'], note: 'после' });
    const comparison = review(base, local, remote);
    expect(comparison.changes()).toEqual([
      { path: ['items'], kind: 'conflict', reason: 'concurrent-edit' },
      { path: ['note'], kind: 'change_field' }
    ]);
    const cleanOnly = comparison.plan({ selected: [['note']] });
    expect(cleanOnly.record).toEqual(live({ items: ['B'], note: 'после' }));
    expect(cleanOnly.pending).toEqual([{ path: ['items'], kind: 'conflict', reason: 'concurrent-edit' }]);
    const attemptBoth = comparison.plan({ selected: [['note'], ['items']] });
    expect(attemptBoth.status).toBe('needs_review');
    expect(attemptBoth.record).toBeNull();
    expect(attemptBoth.applied).toEqual([]);
    expect(attemptBoth.pending).toHaveLength(2);
  });

  it('конфликт одного поля не стирает локальную правку и остаётся ожидающим', () => {
    const base = live({ title: 'старое', completed: false });
    const local = live({ title: 'здесь', completed: false });
    const remote = live({ title: 'там', completed: true });
    const comparison = review(base, local, remote);
    const result = comparison.plan({ selected: [['completed']] });
    expect(result.record).toEqual(live({ title: 'здесь', completed: true }));
    expect(result.pending).toEqual([{ path: ['title'], kind: 'conflict', reason: 'concurrent-edit' }]);
    const blocked = comparison.plan({ selected: [['title']] });
    expect(blocked).toMatchObject({ status: 'needs_review', record: null, applied: [] });
    expect(blocked.blocked).toEqual([{ path: ['title'], kind: 'conflict', reason: 'concurrent-edit' }]);
  });

  it('не считает пропавшее поле подтверждённым удалением, даже при общем подтверждении удаления', () => {
    const base = live({ keep: 1, title: 'важное' });
    const remote = live({ keep: 2 });
    const comparison = review(base, base, remote);
    expect(comparison.changes()).toEqual([
      { path: ['keep'], kind: 'change_field' },
      { path: ['title'], kind: 'unverified_absence', reason: 'missing-field-history' }
    ]);
    const result = comparison.plan({ selected: [['keep']] });
    expect(result.record).toEqual(live({ keep: 2, title: 'важное' }));
    expect(result.pending).toHaveLength(1);
    expect(comparison.plan({ selected: [['title']], confirmDeletion: true })).toMatchObject({
      status: 'needs_review',
      record: null,
      blocked: [{ path: ['title'], kind: 'unverified_absence', reason: 'missing-field-history' }]
    });
  });

  it('конфликтует удаление поля против правки и правка против локального отсутствия', () => {
    const base = live({ title: 'старое' });
    expect(review(base, live({ title: 'здесь' }), live({})).changes()).toEqual([
      { path: ['title'], kind: 'conflict', reason: 'delete-versus-edit' }
    ]);
    expect(review(base, live({}), live({ title: 'там' })).changes()).toEqual([
      { path: ['title'], kind: 'conflict', reason: 'delete-versus-edit' }
    ]);
  });

  it('удаление записи требует явного выбора и отдельного подтверждения', () => {
    const base = live({ title: 'Событие', status: 'done' });
    const comparison = review(base, base, tombstone());
    expect(comparison.changes()).toEqual([{ path: [], kind: 'delete_record' }]);
    const unchecked = comparison.plan({ selected: [] });
    expect(unchecked.record).toEqual(base);
    expect(unchecked.pending).toEqual([{ path: [], kind: 'delete_record' }]);
    const unconfirmed = comparison.plan({ selected: [[]] });
    expect(unconfirmed).toMatchObject({
      status: 'confirm_deletion',
      record: null,
      applied: [],
      pending: [{ path: [], kind: 'delete_record' }]
    });
    expect(comparison.plan({ selected: [[]], confirmDeletion: false }).status).toBe('confirm_deletion');
    const confirmed = comparison.plan({ selected: [[]], confirmDeletion: true });
    expect(confirmed).toEqual({
      status: 'planned',
      record: tombstone(),
      applied: [{ path: [], kind: 'delete_record' }],
      pending: [],
      blocked: []
    });
  });

  it('не разрешает удаление записи против локальной правки даже с подтверждением', () => {
    const base = live({ title: 'старое' });
    const comparison = review(base, live({ title: 'моё' }), tombstone());
    expect(comparison.changes()).toEqual([{ path: [], kind: 'conflict', reason: 'delete-versus-edit' }]);
    expect(comparison.plan({ selected: [[]], confirmDeletion: true })).toMatchObject({
      status: 'needs_review',
      record: null,
      applied: [],
      blocked: [{ path: [], kind: 'conflict', reason: 'delete-versus-edit' }]
    });
  });

  it('оставляет локальную метку удаления, если удалённая сторона не менялась', () => {
    const base = live({ title: 'старое' });
    const result = review(base, tombstone(), base).plan({ selected: [] });
    expect(result.record).toEqual(tombstone());
    expect(result.pending).toEqual([]);
  });

  it('блокирует восстановление записи после удаления и удалённую правку против локального удаления', () => {
    const old = live({ title: 'старое' });
    expect(review(tombstone(), tombstone(), old).plan({ selected: [[]] })).toMatchObject({
      status: 'needs_review',
      blocked: [{ path: [], kind: 'conflict', reason: 'restore-deleted' }]
    });
    expect(review(old, tombstone(), live({ title: 'правка' })).plan({ selected: [[]] })).toMatchObject({
      status: 'needs_review',
      blocked: [{ path: [], kind: 'conflict', reason: 'delete-versus-edit' }]
    });
  });

  it('не считает новую облачную запись безопасной при отсутствии проверенной истории и ID', () => {
    const comparison = review(null, null, live({ title: 'Событие' }));
    expect(comparison.changes()).toEqual([{ path: [], kind: 'unverified_identity', reason: 'missing-base' }]);
    expect(comparison.plan({ selected: [] })).toMatchObject({
      status: 'planned',
      record: null,
      pending: comparison.changes()
    });
    expect(comparison.plan({ selected: [[]] })).toMatchObject({ status: 'needs_review', record: null, applied: [] });
    const same = live({ title: 'Одинаковое содержимое' });
    expect(review(null, same, same).plan({ selected: [[]] })).toMatchObject({
      status: 'needs_review',
      blocked: [{ path: [], kind: 'unverified_identity', reason: 'missing-base' }]
    });
  });

  it('не объединяет одновременно созданные разные записи и метки без базы', () => {
    const different = review(null, live({ title: 'А' }), live({ title: 'Б' }));
    expect(different.plan({ selected: [[]] })).toMatchObject({
      status: 'needs_review',
      blocked: [{ path: [], kind: 'conflict', reason: 'concurrent-create' }]
    });
    expect(review(null, null, tombstone()).changes()).toEqual([{ path: [], kind: 'conflict', reason: 'missing-base' }]);
  });

  it('прерывает сравнение, когда существовавшая запись пропала вместо метки удаления', () => {
    const base = live({ title: 'Событие' });
    expect(() => review(base, base, null)).toThrow('Неполная история');
    expect(() => review(base, null, base)).toThrow('Неполная история');
    expect(() => review(tombstone(), null, tombstone())).toThrow('Неполная история');
  });

  it('отклоняет устаревшие, повторные и несуществующие пути целиком', () => {
    const comparison = review(live({ a: 0 }), live({ a: 0 }), live({ a: 1 }));
    expect(() => comparison.plan({ selected: [['a'], ['a']] })).toThrow('Выбор устарел');
    expect(() => comparison.plan({ selected: [['a'], ['old']] })).toThrow('Выбор устарел');
    expect(() => comparison.plan({ selected: [[]] })).toThrow('Выбор устарел');
    expect(() => comparison.plan({ selected: ['a'] })).toThrow();
    expect(() => comparison.plan({ selected: [['a']], confirmDeletion: 'true' })).toThrow();
    expect(() => comparison.plan({ selected: [['a']], extra: true })).toThrow();
    expect(() => comparison.plan({})).toThrow();
  });

  it('фиксирует копии для просмотра и не возвращает изменяемых ссылок на них', () => {
    const base = live({ nested: { value: 0 }, untouched: { value: 1 } });
    const local = structuredClone(base);
    const remote = live({ nested: { value: 2 }, untouched: { value: 1 } });
    const comparison = review(base, local, remote);
    remote.fields.nested.value = 99;
    local.fields.untouched.value = 99;
    base.fields.nested.value = 99;
    const list = comparison.changes();
    list[0].path[0] = 'bad';
    const first = comparison.plan({ selected: [['nested', 'value']] });
    expect(first.record).toEqual(live({ nested: { value: 2 }, untouched: { value: 1 } }));
    first.record.fields.untouched.value = 42;
    first.applied[0].path[0] = 'bad';
    expect(comparison.plan({ selected: [['nested', 'value']] }).record).toEqual(
      live({ nested: { value: 2 }, untouched: { value: 1 } })
    );
    expect(comparison.changes()).toEqual([{ path: ['nested', 'value'], kind: 'change_field' }]);
  });

  it('не меняет невыбранную ветвь при общей объектной ссылке во входных данных', () => {
    const shared = { value: 0 };
    const base = live({ a: shared, b: shared });
    const local = live({ a: { value: 0 }, b: { value: 0 } });
    const remote = live({ a: { value: 1 }, b: { value: 0 } });
    const result = review(base, local, remote).plan({ selected: [['a', 'value']] });
    expect(result.record).toEqual(live({ a: { value: 1 }, b: { value: 0 } }));
    expect(shared.value).toBe(0);
  });

  it('не включает значения полей в метаданные различий, конфликтов и сообщения об ошибке', () => {
    const base = live({ note: 'base private' });
    const local = live({ note: 'local private' });
    const remote = live({ note: 'remote private' });
    const comparison = review(base, local, remote);
    const result = comparison.plan({ selected: [['note']] });
    expect(JSON.stringify([comparison.changes(), result.pending, result.blocked])).not.toMatch(/private/);
    try {
      comparison.plan({ selected: [['remote private']] });
      throw new Error('Выбор должен был быть отклонён');
    } catch (error) {
      expect(error.message).not.toContain('remote private');
    }
  });

  it('отклоняет getters и опасные ключи, не выполняя их', () => {
    const getter = vi.fn(() => live({ note: 'личное' }));
    expect(() =>
      createSelectiveRecordReview({
        get base() {
          return getter();
        },
        local: null,
        remote: null
      })
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const comparison = review(live({ a: 0 }), live({ a: 0 }), live({ a: 1 }));
    const selectedGetter = vi.fn(() => [['a']]);
    expect(() =>
      comparison.plan({
        get selected() {
          return selectedGetter();
        }
      })
    ).toThrow();
    expect(selectedGetter).not.toHaveBeenCalled();
    expect(() => review(live(JSON.parse('{"__proto__":{"polluted":true}}')), live({}), live({}))).toThrow();
    expect(() => review(live(new Proxy({ note: 'личное' }, {})), live({}), live({}))).toThrow(
      'Некорректные данные сравнения'
    );
    expect(() => comparison.plan({ selected: new Proxy([['a']], {}) })).toThrow('Некорректные данные сравнения');
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it('отклоняет несериализуемые, циклические и неполные данные', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    for (const fields of [cyclic, { value: NaN }, { value: undefined }, { arr: Array(2) }, { value: new Date() }]) {
      expect(() => review(live(fields), live({}), live({}))).toThrow();
    }
    expect(() => createSelectiveRecordReview({ base: null, local: null, remote: null, extra: true })).toThrow();
    expect(() => review({ deleted: true, fields: {} }, null, null)).toThrow();
  });

  it('останавливает слишком большой объём сравниваемых записей и выбора до построения кандидата', () => {
    const bigRecord = live({ note: 'x'.repeat(3 * 1024 * 1024) });
    expect(() => review(bigRecord, bigRecord, bigRecord)).toThrow('Сравнение записи слишком большое');
    const comparison = review(live({ a: 0 }), live({ a: 0 }), live({ a: 1 }));
    expect(() => comparison.plan({ selected: [['x'.repeat(8 * 1024 * 1024)]] })).toThrow(
      'Сравнение записи слишком большое'
    );
  });

  it('сохраняет все невыбранные поля в разнообразных сочетаниях локальных и облачных правок', () => {
    // 3 состояния каждой стороны на поле: без изменения, значение A или значение B.
    for (let mask = 0; mask < 3 ** 4; mask++) {
      let remaining = mask;
      const local = { a: 0, b: 0 };
      const remote = { a: 0, b: 0 };
      for (const [side, key] of [
        [local, 'a'],
        [local, 'b'],
        [remote, 'a'],
        [remote, 'b']
      ]) {
        side[key] = remaining % 3;
        remaining = Math.floor(remaining / 3);
      }
      const comparison = review(live({ a: 0, b: 0 }), live(local), live(remote));
      const available = comparison.changes();
      const chosen = available
        .filter(item => item.kind === 'change_field' && item.path[0] === 'a')
        .map(item => item.path);
      const result = comparison.plan({ selected: chosen });
      expect(result.status).toBe('planned');
      expect(result.record.fields.b).toBe(local.b);
      expect(result.record.fields.a).toBe(chosen.length ? remote.a : local.a);
      expect(changes(result.pending)).toEqual(
        changes(available.filter(item => !chosen.some(path => JSON.stringify(path) === JSON.stringify(item.path))))
      );
    }
  });
});
