import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeCharacter } from '../js/core/state/character.js';
import { exportCharacter } from '../js/modules/cloudSync/characterExport.js';

const syncId = 'c9115bf2-e834-444d-aeb6-7c3af1db8890';
const party1 = 'ff78b899-5e27-4e64-b0e4-98aac0a5a0b1';
const party2 = 'ff78b899-5e27-4e64-b0e4-98aac0a5a0b2';
const partySyncIds = new Map([
  ['local-party-a', party1],
  ['local-party-b', party2]
]);
const opts = { syncId, partySyncIds };
let char;

beforeEach(() => {
  char = normalizeCharacter({
    id: 'local-profile-id',
    syncId,
    nick: 'Звеномир',
    class: 'Жрец',
    favorite: true,
    partyIds: ['local-party-a', 'local-party-b'],
    mainPartyId: 'local-party-a',
    partyOrder: { 'local-party-a': 3, 'local-party-b': 2 },
    notes: 'Вымышленная заметка',
    level: 105,
    sky: { name: 'Небо', level: 3 },
    contacts: {
      email: 'private@example.invalid',
      password: 'private-password',
      recoveryEmail: 'recovery@example.invalid',
      phone: '+123456789'
    },
    launch: { gcPath: 'C:\\Private\\GameCenter.exe', gcNick: 'private-login', gcAccount: true },
    isLoggedIn: true,
    lastLoginCheck: '2026-10-28T00:00:00Z',
    lastLoginReason: 'private-session',
    dungeonPasses: { weapon: 3, armor: 4, relic: 5 },
    stats: { hp: 1200, mp: 700 },
    statsHistory: [{ at: '2026-10-20T00:00:00Z', stats: { hp: 900 } }],
    tags: ['пример', 'основа'],
    ancientCoins: 100.5,
    lastCoinUpdate: '2026-10-25T00:00:00Z',
    coinsParserV: 2,
    coinHistory: [{ id: 'history-1', date: '2026-10-25T00:00:00Z', delta: 10.5, note: 'пример', balanceAfter: 100.5 }],
    marathonData: {
      lastSyncDate: '2026-10-26T00:00:00Z',
      quests: [{ title: 'Задание', description: 'Условие', completed: 3, total: 5, percentage: 60 }],
      summary: { completed: 3, total: 5, percentage: 60 }
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-10-27T00:00:00Z'
  });
});

describe('разрешённые поля персонажа для будущей синхронизации', () => {
  it('выбирает пользовательские поля, а контакты, сессии и локальные пути никогда не попадают в экспорт', () => {
    const before = JSON.stringify(char);
    const result = exportCharacter(char, opts);
    const raw = JSON.stringify(result);
    for (const secret of [
      'local-profile-id',
      'local-party-a',
      'local-party-b',
      'private@example.invalid',
      'private-password',
      'recovery@example.invalid',
      '+123456789',
      'Private\\\\GameCenter',
      'private-login',
      'private-session',
      'lastLoginCheck',
      'isLoggedIn',
      'contacts',
      'launch'
    ])
      expect(raw).not.toContain(secret);
    expect(result).toMatchObject({
      id: syncId,
      type: 'character',
      archived: false,
      fields: {
        nick: 'Звеномир',
        class: 'Жрец',
        favorite: true,
        partyIds: [party1, party2],
        mainPartyId: party1,
        partyOrder: { [party1]: 3, [party2]: 2 },
        notes: 'Вымышленная заметка',
        level: 105,
        stats: { hp: 1200, mp: 700 },
        ancientCoins: 100.5,
        marathonData: { quests: [{ title: 'Задание', completed: 3 }] }
      }
    });
    expect(result.fields.coinHistory).toEqual(char.coinHistory);
    expect(JSON.stringify(char)).toBe(before);
  });

  it('переименование и смена локального id не меняют постоянный sync-id', () => {
    const before = exportCharacter(char, opts);
    char.id = 'renamed-local-id';
    char.nick = 'Новое имя';
    const after = exportCharacter(char, opts);
    expect(after.id).toBe(before.id);
    expect(after.fields.nick).toBe('Новое имя');
  });

  it('не теряет ссылки на партии при отсутствии соответствия — останавливает экспорт', () => {
    expect(() => exportCharacter(char, { syncId, partySyncIds: new Map() })).toThrow('идентификаторы партий');
    const incomplete = new Map([['local-party-a', party1]]);
    expect(() => exportCharacter(char, { syncId, partySyncIds: incomplete })).toThrow('идентификаторы партий');
  });

  it('различает активного и архивного персонажа', () => {
    expect(exportCharacter(char, { ...opts, archived: true }).archived).toBe(true);
    expect(() => exportCharacter(char, { ...opts, archived: 'yes' })).toThrow();
  });

  it('не включает контакты даже по подставленному флажку; отдельная функция ещё не реализована', () => {
    expect(() => exportCharacter(char, { ...opts, includeSecrets: true })).toThrow('экспорт остановлен');
    expect(() => exportCharacter(char, { ...opts, includePasswords: true })).toThrow('экспорт остановлен');
  });

  it('останавливается на неизвестных полях, а не экспортирует их и не теряет молча', () => {
    char.newUnknownField = 'new-secret';
    expect(() => exportCharacter(char, opts)).toThrow('экспорт остановлен');
    delete char.newUnknownField;
    char.stats.accessToken = 123;
    expect(() => exportCharacter(char, opts)).toThrow('экспорт остановлен');
    delete char.stats.accessToken;
    char.coinHistory[0].cookie = 'not-for-sync';
    expect(() => exportCharacter(char, opts)).toThrow('экспорт остановлен');
  });

  it('не исполняет getter в полях или данных контактов', () => {
    let read = false;
    Object.defineProperty(char, 'contacts', {
      enumerable: true,
      configurable: true,
      get: () => {
        read = true;
        return {};
      }
    });
    expect(() => exportCharacter(char, opts)).toThrow('экспорт остановлен');
    expect(read).toBe(false);
  });

  it('не принимает невалидные данные, дубли идентичности и несвязанные партии', () => {
    expect(() => exportCharacter(char, { ...opts, syncId: 'Звеномир' })).toThrow();
    expect(() =>
      exportCharacter(char, {
        ...opts,
        partySyncIds: new Map([
          ['local-party-a', party1],
          ['local-party-b', party1]
        ])
      })
    ).toThrow();
    char.mainPartyId = 'not-in-party-list';
    expect(() => exportCharacter(char, opts)).toThrow();
  });

  it('не меняет ранее назначенный syncId и не принимает неподтверждённую подмену', () => {
    char.syncId = syncId;
    expect(exportCharacter(char, opts).id).toBe(syncId);
    char.syncId = 'f014f1a4-f37b-41ca-b86b-751e80d189d5';
    expect(() => exportCharacter(char, opts)).toThrow('экспорт остановлен');
    delete char.syncId;
    expect(() => exportCharacter(char, opts)).toThrow('экспорт остановлен');
  });

  it('не пропускает дырки массивов и недопустимые числа', () => {
    char.tags = [];
    char.tags.length = 2;
    char.tags[1] = 'метка';
    expect(() => exportCharacter(char, opts)).toThrow();
    char.tags = ['метка'];
    char.level = NaN;
    expect(() => exportCharacter(char, opts)).toThrow();
  });
});
