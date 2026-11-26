// tests/externalApi.mutate.test.js
// Изменение статов и проходок через внешний API (M2).
//
// Проверяем то, что легко сломать: снимок истории статов не появляется, если
// статы не менялись; заблокированная запись (423) не меняет данные в памяти;
// массовое изменение возвращает частичный успех, а не падает целиком.
import { describe, it, expect } from 'vitest';
import {
  ApiError,
  applyPatch,
  bulkUpdate,
  errorBody,
  findCharacter,
  patchCharacter,
  validatePatch
} from '../js/modules/externalApi/actions/mutate.js';

const deps = (overrides = {}) => {
  const calls = { persist: 0, render: 0 };
  return {
    calls,
    assertStateWriteAvailable: () => {},
    persist: async () => {
      calls.persist += 1;
    },
    renderCharacters: () => {
      calls.render += 1;
    },
    now: () => '2026-11-24T12:00:00.000Z',
    ...overrides
  };
};

const state = () => ({
  characters: [
    {
      id: 'Mag_1',
      nick: 'Маг',
      stats: { physAttack: 12000, magAttack: 96000 },
      dungeonPasses: { weapon: 3, armor: 2, relic: 1 },
      statsHistory: [],
      updatedAt: '2026-11-24T09:00:00.000Z'
    },
    {
      id: 'Luchnik_2',
      nick: 'Лучник',
      stats: { physAttack: 91000 },
      dungeonPasses: { weapon: 1, armor: 0, relic: 0 },
      updatedAt: '2026-11-24T09:00:00.000Z'
    }
  ],
  archivedCharacters: [{ id: 'Zhrets_3', nick: 'Жрец', stats: { hp: 1 }, dungeonPasses: {} }]
});

describe('внешний API: проверка патча', () => {
  it('принимает только известные ключи и числовые значения', () => {
    expect(validatePatch({ stats: { physAttack: 1, unknownStat: 5 }, dungeonPasses: { weapon: 2 } })).toEqual({
      stats: { physAttack: 1 },
      dungeonPasses: { weapon: 2 }
    });
    // Неизвестный ключ статов игнорируется, но пустой патч — ошибка.
    expect(() => validatePatch({ stats: { unknownStat: 5 } })).toThrow(/нет ни одного известного поля/);
  });

  it('отклоняет мусор, отрицательные числа, дроби в проходках и лишние поля', () => {
    const code = fn => {
      try {
        fn();
      } catch (error) {
        return { status: error.status, code: error.code };
      }
      return null;
    };
    expect(code(() => validatePatch({ stats: { hp: '10' } }))).toEqual({ status: 422, code: 'invalid_value' });
    expect(code(() => validatePatch({ stats: { hp: -1 } }))).toEqual({ status: 422, code: 'invalid_value' });
    expect(code(() => validatePatch({ stats: { hp: 1_000_000_001 } }))).toEqual({ status: 422, code: 'invalid_value' });
    expect(code(() => validatePatch({ dungeonPasses: { weapon: 1.5 } }))).toEqual({
      status: 422,
      code: 'invalid_value'
    });
    expect(code(() => validatePatch({ dungeonPasses: { helmet: 1 } }))).toMatchObject({ status: 422 });
    expect(code(() => validatePatch({ hp: 1 }))).toEqual({ status: 422, code: 'invalid_value' });
    expect(code(() => validatePatch([1]))).toEqual({ status: 422, code: 'invalid_value' });
  });

  it('applyPatch меняет только переданное и возвращает список изменений', () => {
    const char = state().characters[0];
    const changed = applyPatch(char, { stats: { physAttack: 12500 }, dungeonPasses: { weapon: 2 } });
    expect(changed).toEqual(['stats.physAttack', 'dungeonPasses.weapon']);
    expect(char.stats).toEqual({ physAttack: 12500, magAttack: 96000 });
    expect(char.dungeonPasses).toEqual({ weapon: 2, armor: 2, relic: 1 });
    // Повторная запись тех же значений — «изменений нет», а не тихая перезапись.
    expect(applyPatch(char, { stats: { physAttack: 12500 } })).toEqual([]);
  });
});

describe('внешний API: изменение одного персонажа', () => {
  it('меняет статы, кладёт снимок истории и сохраняет', async () => {
    const s = state();
    const d = deps();
    const result = await patchCharacter(s, 'Mag_1', { stats: { physAttack: 12500 } }, d);
    expect(result.changed).toEqual(['stats.physAttack']);
    expect(result.statsHistoryAdded).toBe(true);
    expect(result.character.updatedAt).toBe('2026-11-24T12:00:00.000Z');
    // Снимок хранит прежние значения: по нему считается «было → стало».
    expect(s.characters[0].statsHistory[0]).toEqual({
      at: '2026-11-24T12:00:00.000Z',
      stats: { physAttack: 12000, magAttack: 96000 }
    });
    expect(d.calls.persist).toBe(1);
    expect(d.calls.render).toBe(1);
  });

  it('изменение только проходок не трогает историю статов', async () => {
    const s = state();
    const result = await patchCharacter(s, 'Mag_1', { dungeonPasses: { relic: 0 } }, deps());
    expect(result.changed).toEqual(['dungeonPasses.relic']);
    expect(result.statsHistoryAdded).toBe(false);
    expect(s.characters[0].statsHistory).toEqual([]);
  });

  it('несуществующий id — 404, а если значения уже такие — ничего не пишется', async () => {
    const s = state();
    await expect(patchCharacter(s, 'Nope_9', { stats: { hp: 1 } }, deps())).rejects.toMatchObject({
      status: 404,
      code: 'no_such_character'
    });
    const d = deps();
    const same = await patchCharacter(s, 'Mag_1', { dungeonPasses: { weapon: 3 } }, d);
    expect(same.changed).toEqual([]);
    expect(d.calls.persist).toBe(0);
    expect(d.calls.render).toBe(0);
  });

  it('находит архивного персонажа: архив виден в API как обычный', async () => {
    const s = state();
    expect(findCharacter(s, 'Zhrets_3')).toMatchObject({ nick: 'Жрец' });
    const result = await patchCharacter(s, 'Zhrets_3', { stats: { hp: 2 } }, deps());
    expect(result.character.stats.hp).toBe(2);
  });

  it('заблокированная запись — 423 и никаких изменений в памяти', async () => {
    const s = state();
    const before = JSON.stringify(s.characters[0]);
    const d = deps({
      assertStateWriteAvailable: () => {
        throw new Error('Сохранение остановлено');
      }
    });
    await expect(patchCharacter(s, 'Mag_1', { stats: { hp: 5 } }, d)).rejects.toMatchObject({
      status: 423,
      code: 'storage_blocked'
    });
    expect(JSON.stringify(s.characters[0])).toBe(before);
    expect(d.calls.persist).toBe(0);
  });

  it('ошибка persist — 500 save_failed, изменение остаётся в памяти', async () => {
    const s = state();
    const d = deps({
      persist: async () => {
        throw new Error('диск');
      }
    });
    await expect(patchCharacter(s, 'Mag_1', { stats: { hp: 7 } }, d)).rejects.toMatchObject({
      status: 500,
      code: 'save_failed'
    });
    expect(s.characters[0].stats.hp).toBe(7);
  });
});

describe('внешний API: массовое изменение', () => {
  it('частичный успех: один изменён, второго нет', async () => {
    const s = state();
    const d = deps();
    const result = await bulkUpdate(s, { ids: ['Mag_1', 'Nope_9'], patch: { dungeonPasses: { relic: 3 } } }, d);
    expect(result.updated).toEqual([{ id: 'Mag_1', nick: 'Маг', changed: ['dungeonPasses.relic'] }]);
    expect(result.failed).toEqual([{ id: 'Nope_9', code: 'no_such_character', message: 'Персонаж не найден' }]);
    expect(d.calls.persist).toBe(1);
    expect(d.calls.render).toBe(1);
  });

  it('проверяет список до правок: дубликаты, пустые строки, больше 100', async () => {
    const s = state();
    const d = deps();
    await expect(bulkUpdate(s, { ids: ['Mag_1', 'Mag_1'], patch: { stats: { hp: 1 } } }, d)).rejects.toMatchObject({
      code: 'invalid_value'
    });
    await expect(bulkUpdate(s, { ids: ['Mag_1', ' '], patch: { stats: { hp: 1 } } }, d)).rejects.toMatchObject({
      code: 'invalid_value'
    });
    const many = Array.from({ length: 101 }, (_, i) => `C_${i}`);
    await expect(bulkUpdate(s, { ids: many, patch: { stats: { hp: 1 } } }, d)).rejects.toMatchObject({
      code: 'invalid_value'
    });
    expect(d.calls.persist).toBe(0);
  });

  it('неверный патч не меняет никого, даже если id верные', async () => {
    const s = state();
    const before = JSON.stringify(s.characters);
    await expect(
      bulkUpdate(s, { ids: ['Mag_1', 'Luchnik_2'], patch: { dungeonPasses: { weapon: -1 } } }, deps())
    ).rejects.toMatchObject({ code: 'invalid_value' });
    expect(JSON.stringify(s.characters)).toBe(before);
  });

  it('если менять нечего, ничего не сохраняется', async () => {
    const s = state();
    const d = deps();
    const result = await bulkUpdate(s, { ids: ['Mag_1'], patch: { dungeonPasses: { weapon: 3 } } }, d);
    expect(result.updated).toEqual([{ id: 'Mag_1', changed: [], nickname: 'Маг' }]);
    expect(result.failed).toEqual([]);
    expect(d.calls.persist).toBe(0);
  });
});

describe('внешний API: формат ошибок', () => {
  it('ApiError превращается в общий формат ответа', () => {
    const error = new ApiError(404, 'no_such_character', 'Персонаж не найден');
    expect(errorBody(error)).toEqual({
      status: 404,
      body: { error: { code: 'no_such_character', message: 'Персонаж не найден' } }
    });
    // Обычная ошибка не должна утекать текстом в ответ: только общий код и сообщение.
    expect(errorBody(new Error('boom'))).toEqual({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Внутренняя ошибка приложения' } }
    });
  });
});
