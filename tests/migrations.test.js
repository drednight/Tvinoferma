import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateState, detectVersion, SCHEMA_VERSION } from '../js/core/migrations.js';
import { normalizeState, normalizeTags, NOTES_MAX_LENGTH } from '../js/core/state.js';

const fixture = name => JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8'));

/**
 * Список миграций от `from` до текущей схемы.
 *
 * Раньше цепочка была выписана в тестах константой («[3, 4, 5, 6, 7, 8, 9]»), и любая
 * новая миграция ломала шесть проверок в других сценариях — причём падали они не там,
 * где дело было. Список выводится из номера версии: добавили миграцию — правок в тестах
 * не нужно, а пропущенный шаг по-прежнему ловится.
 */
const chainFrom = from => Array.from({ length: SCHEMA_VERSION - from }, (_, i) => from + 1 + i);

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
    expect(applied).toEqual(chainFrom(2));
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
    expect(applied).toEqual(chainFrom(1));
    expect(state.parties.map(p => ({ name: p.name, order: p.order }))).toEqual([
      { name: 'A', order: 1 },
      { name: 'B', order: 2 }
    ]);
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
      archivedParties: [
        {
          id: 'archived-party',
          name: 'Архивная',
          memberLinks: [{ characterId: 'archived-char', isMain: true, order: null }]
        }
      ],
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
    parties: [
      { id: 'p1', name: 'Основа', order: 1 },
      { name: 'Крипы', order: 2 }
    ],
    characters: [
      { id: 'A', nick: 'A', party: 'основа' }, // регистр не важен
      { id: 'B', nick: 'B', party: 'Крипы' }, // у партии не было id
      { id: 'C', nick: 'C', party: 'Неявная' }, // партии нет в списке — создаётся
      { id: 'D', nick: 'D', party: null }
    ]
  });

  it('party (название) → partyIds (id), поле party удаляется, notes по умолчанию пустые', () => {
    const { state, applied } = migrateState(v4());
    expect(applied).toEqual(chainFrom(4));
    const id = name => state.parties.find(p => p.name === name).id;
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
    const st = normalizeState({
      schemaVersion: 5,
      parties: [{ id: 'p1', name: 'X' }],
      characters: [{ id: 'a', nick: 'A', partyIds: ['p1', 'ghost', 'p1'], notes: 'я'.repeat(NOTES_MAX_LENGTH + 10) }]
    });
    expect(st.characters[0].partyIds).toEqual(['p1']);
    expect(st.characters[0].notes).toHaveLength(NOTES_MAX_LENGTH);
  });
});

describe('миграция v6: порог свежести входа 24 ч (issue #16)', () => {
  it('старое значение по умолчанию 12 ч заменяется на 24 ч, остальные не трогаются', () => {
    const run = freshness =>
      migrateState({ schemaVersion: 5, settings: { freshness }, characters: [] }).state.settings.freshness;
    expect(run({ balanceHours: 24, loginHours: 12, marathonHours: 24 })).toEqual({
      balanceHours: 24,
      loginHours: 24,
      marathonHours: 24
    });
    expect(run({ balanceHours: 6, loginHours: 18, marathonHours: 48 })).toEqual({
      balanceHours: 6,
      loginHours: 18,
      marathonHours: 48
    });
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
    const st = normalizeState({
      characters: [{ id: 'c', nick: 'N', stats: { hp: '100', critChance: 5 }, tags: ['твин', ' Твин ', 'крафт'] }]
    });
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
    expect(applied).toEqual(chainFrom(6));
    expect(state.characters.map(c => c.launch.gcPath)).toEqual(['', 'D:\\GC', '']);
    expect(raw.characters[0].launch).toBeUndefined(); // исходные данные не мутируются
  });
});

describe('миграция v9: раздел «Учёт»', () => {
  it('старый файл без раздела получает пустой, а не битый', () => {
    const { state, applied } = migrateState({ schemaVersion: 8, characters: [], parties: [] });
    expect(applied).toEqual(chainFrom(8));
    expect(state.finance).toEqual({});
    expect(normalizeState(state).finance.operations).toEqual([]);
  });

  it('уже заведённые деньги переживают миграцию и обновление схемы', () => {
    const finance = {
      operations: [{ id: 'o1', date: '2026-06-09', kind: 'in', amount: 1000, currency: 'gold', counterparty: 'Ежа' }],
      shopItems: [{ id: 'i1', side: 'sell', name: 'Зелье', price: 100, qty: 3 }],
      loans: [
        {
          id: 'l1',
          direction: 'lent',
          who: 'Шкила',
          principal: 500,
          percent: 5,
          start: '2026-06-01',
          end: '2026-12-01'
        }
      ],
      settings: { goldRate: 1000000, commissionPct: 8, goldRateAt: '2026-06-09' }
    };
    const normalized = normalizeState(migrateState({ schemaVersion: 8, finance, characters: [] }).state);
    expect(normalized.finance.operations).toHaveLength(1);
    expect(normalized.finance.operations[0].counterparty).toBe('Ежа');
    expect(normalized.finance.shopItems[0].name).toBe('Зелье');
    expect(normalized.finance.loans[0].who).toBe('Шкила');
    expect(normalized.finance.settings.goldRate).toBe(1000000);
  });

  it('мусор на месте раздела не ломает загрузку', () => {
    for (const bad of [null, 42, 'text', []]) {
      expect(() => normalizeState(migrateState({ schemaVersion: 8, finance: bad }).state)).not.toThrow();
    }
  });
});

describe('цепочка миграций для релиза 1.0', () => {
  it('самый старый формат (пустой объект) доходит до текущей схемы без падений', () => {
    const { state, from, to, applied } = migrateState({});
    expect(from).toBe(1);
    expect(to).toBe(SCHEMA_VERSION);
    expect(applied).toEqual(chainFrom(1));
    expect(state.characters).toEqual([]);
    expect(state.parties).toEqual([]);
    expect(state.marathons).toEqual([]);
  });

  it('персонаж со старыми полями (party, ник с #) сохраняется со всеми данными', () => {
    const raw = {
      version: 2,
      characters: [{ id: 'Dragon#1', nick: 'Dragon#1', party: 'Рейд', notes: 'важно' }],
      parties: []
    };
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

describe('миграция v10: раздел клана eternals → guild', () => {
  // Переименование ключа настроек через миграцию, а не правкой на чтении: иначе откат на
  // старую версию увидел бы незнакомый ключ, счёл файл битым и записал поверх умолчания.
  const old = settings => ({ schemaVersion: 9, settings });

  it('настройки клана переезжают в новый ключ', () => {
    const { state, applied } = migrateState(old({ eternals: { enabled: true, syncedAt: 1700000000000 } }));
    expect(applied).toEqual([10]);
    expect(state.settings.guild.enabled).toBe(true);
    expect(state.settings.guild.syncedAt).toBe(1700000000000);
  });

  it('старый ключ удаляется, иначе он переживёт переименование навсегда', () => {
    const { state } = migrateState(old({ eternals: { enabled: true } }));
    expect(state.settings.eternals).toBeUndefined();
  });

  it('новый ключ важнее старого: дважды переименованный файл не откатывается назад', () => {
    const { state } = migrateState(old({ guild: { enabled: false }, eternals: { enabled: true } }));
    expect(state.settings.guild.enabled).toBe(false);
  });

  it('файл без раздела клана остаётся без него', () => {
    const { state } = migrateState(old({ launcher: {} }));
    expect(state.settings.guild).toBeUndefined();
  });

  it('битое settings не ломает загрузку', () => {
    for (const bad of [null, 'text', [], 42]) {
      expect(() => migrateState({ schemaVersion: 9, settings: bad })).not.toThrow();
    }
  });

  it('миграция идемпотентна: повторный запуск на новой версии ничего не меняет', () => {
    const once = migrateState(old({ eternals: { enabled: true } }));
    const twice = migrateState(once.state);
    expect(twice.applied).toEqual([]);
    expect(twice.state.settings.guild.enabled).toBe(true);
  });

  it('файл из более новой версии не трогается — этим и защищён откат', () => {
    // Старая версия, увидев файл с большим номером схемы, обязана оставить его как есть.
    // Именно это делает переименование ключа безопасным при откате: без миграции старая
    // версия сочла бы файл битым и записала поверх него умолчания.
    const fromFuture = { schemaVersion: SCHEMA_VERSION + 1, settings: { guild: { enabled: true } } };
    const res = migrateState(fromFuture);
    expect(res.newer).toBe(true);
    expect(res.applied).toEqual([]);
    expect(res.state).toEqual(fromFuture);
  });
});
