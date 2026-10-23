// Повторный проход запуска пати (js/modules/launcher/partyLaunch.js): персонажи, которые не
// запустились, пробуются ещё раз, а успех повтора попадает в общий итог.
import { describe, it, expect } from 'vitest';
import { retryableCharacters, mergeLaunchResults } from '../js/modules/launcher/partyLaunch.js';

const chars = ids => ids.map(id => ({ id, nick: id }));
const res = (id, over = {}) => ({ id, nick: id, ok: true, cancelled: false, ms: 100, ...over });

/** Приклеивает `stages` так же, как это делает `launchCharacters`. */
const withStages = (list, stages) => {
  Object.defineProperty(list, 'stages', { value: stages, enumerable: false });
  return list;
};

describe('повторный проход: кого повторять', () => {
  it('только те, кто не запустился и кого не отменяли', () => {
    const list = chars(['а', 'б', 'в', 'г']);
    const first = [
      res('а'),
      res('б', { ok: false, error: 'окно не появилось' }),
      res('в', { ok: false, cancelled: true }),
      res('г', { ok: false, error: 'GameCenter не закрылся' })
    ];
    expect(retryableCharacters(list, first).map(c => c.id)).toEqual(['б', 'г']);
  });

  it('успешных и отменённых в повтор не берём', () => {
    const list = chars(['а', 'б']);
    const first = [res('а'), res('б', { ok: false, cancelled: true })];
    expect(retryableCharacters(list, first)).toEqual([]);
  });

  it('пустой результат не ломает выборку', () => {
    expect(retryableCharacters(chars(['а']), [])).toEqual([]);
    expect(retryableCharacters([], [res('а', { ok: false })])).toEqual([]);
  });
});

describe('повторный проход: слияние результатов', () => {
  it('удачный повтор заменяет провал', () => {
    const first = withStages([res('а'), res('б', { ok: false, error: 'окно не появилось' })], {
      gcClose: 10,
      account: 5,
      clientWait: 900,
      delay: 100,
      total: 1100
    });
    const second = withStages([res('б')], { gcClose: 2, account: 1, clientWait: 700, delay: 50, total: 800 });
    const merged = mergeLaunchResults(first, second);
    expect(merged.map(r => r.ok)).toEqual([true, true]);
    expect(merged.find(r => r.id === 'б').error).toBeUndefined();
  });

  it('неудачный повтор оставляет первую ошибку, а не вторую', () => {
    // Вторая попытка ничего не добавляет: показывать «окно не появилось дважды» незачем
    const first = withStages([res('а', { ok: false, error: 'окно не появилось' })], {});
    const second = withStages([res('а', { ok: false, error: 'снова не появилось' })], {});
    const merged = mergeLaunchResults(first, second);
    expect(merged[0].ok).toBe(false);
    expect(merged[0].error).toBe('окно не появилось');
  });

  it('отменённый пользователем не «чинится» повтором', () => {
    const first = withStages([res('а', { ok: false, cancelled: true })], {});
    const second = withStages([res('а')], {});
    const merged = mergeLaunchResults(first, second);
    expect(merged[0].cancelled).toBe(true);
  });

  it('замеры этапов складываются: иначе в журнале пропала бы половина времени', () => {
    const first = withStages([res('а'), res('б', { ok: false })], {
      gcClose: 10,
      account: 5,
      clientWait: 900,
      delay: 100,
      total: 1100
    });
    const second = withStages([res('б')], { gcClose: 1, account: 2, clientWait: 300, delay: 50, total: 400 });
    const merged = mergeLaunchResults(first, second);
    expect(merged.stages.gcClose).toBe(11);
    expect(merged.stages.account).toBe(7);
    expect(merged.stages.clientWait).toBe(1200);
    expect(merged.stages.delay).toBe(150);
    expect(merged.stages.total).toBe(1500);
    // `stages` не перечисляется: переборы и фильтры по нему не должны его видеть
    expect(Object.keys(merged)).toHaveLength(2);
  });

  it('повтор без результатов возвращает первый список как есть', () => {
    const first = withStages([res('а', { ok: false, error: 'x' })], { total: 1 });
    expect(mergeLaunchResults(first, [])).toBe(first);
    expect(mergeLaunchResults(first, null)).toBe(first);
  });

  it('время провала и повтора складывается в общий итог персонажа', () => {
    const first = withStages([res('а', { ok: false, ms: 300 })], {});
    const second = withStages([res('а', { ms: 200 })], {});
    expect(mergeLaunchResults(first, second)[0].ms).toBe(500);
  });
});
