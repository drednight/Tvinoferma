// tests/externalApi.extended.test.js
// Внешний API, часть 2: марафоны, планировщик, учёт, выгрузки и запуск выбора.
//
// Тесты чистые: ни сервера, ни приложения — только функции действий и мост.
// Каждый проверяет то, что нельзя увидеть глазами в интерфейсе:
//   - секреты (контакты, пароли, куки) не попадают в ответы;
//   - отметки марафона не ставятся в чужие дни и чужим персонажам;
//   - CSV экранирует `;`, кавычки и переводы строк;
//   - запуск выбора сохраняет порядок и честно сообщает о пропусках.

import { describe, it, expect, vi } from 'vitest';
import {
  publicMarathons,
  publicMarathonById,
  marathonParticipants,
  publicCharacters
} from '../js/modules/externalApi/actions/read.js';
import {
  setMarathonMark,
  adjustMarathonCell,
  patchDungeonPasses,
  patchCharacterFields,
  createCharacter,
  patchParty,
  patchCharacter
} from '../js/modules/externalApi/actions/mutate.js';
import { buildExport, toCsv, EXPORT_DATASETS } from '../js/modules/externalApi/actions/export.js';
import { launchSelectionJob, JobRegistry, MAX_SELECTION } from '../js/modules/externalApi/actions/launch.js';

/** Состояние как в приложении: персонажи, пати, марафон с заданиями, учёт. */
function makeState() {
  return {
    characters: [
      {
        id: 'Mag_1',
        nick: 'Маг',
        class: 'Маг',
        level: 100,
        partyIds: ['p1'],
        mainPartyId: 'p1',
        stats: { hp: 100, physAttack: 5, magAttack: 50 },
        dungeonPasses: { weapon: 2, armor: 1, relic: 0 },
        tags: ['основа'],
        notes: 'секрет',
        ancientCoins: 12,
        contacts: { gameCenter: 'gc@example.com', password: 'p@ss' },
        launch: { path: 'C:/game.exe' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      {
        id: 'Luk_2',
        nick: 'Лучник',
        class: 'Лучник',
        level: 90,
        partyIds: ['p1'],
        stats: { hp: 80 },
        dungeonPasses: { weapon: 0 },
        tags: [],
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      {
        id: 'Drug_3',
        nick: 'Чужой',
        class: 'Жрец',
        level: 50,
        partyIds: [],
        stats: {},
        dungeonPasses: {}
      }
    ],
    parties: [{ id: 'p1', name: 'Основа', color: '#fff' }],
    marathons: [
      {
        id: 'm1',
        title: 'Марафон ноября',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        status: 'active',
        participantIds: ['Mag_1', 'Luk_2'],
        source: { type: 'site', url: 'https://example.com/m', siteName: 'Сайт' },
        tasks: [
          {
            id: 't1',
            title: 'Ежедневки',
            targetChecks: 10,
            schedule: { mode: 'everyDay', dates: [] },
            rewards: [{ threshold: 5, rewardText: '100 монет', rewardCoins: 100 }]
          },
          { id: 't2', title: 'Арена', targetChecks: 3, schedule: { mode: 'dates', dates: ['2026-11-10'] } }
        ],
        progress: {
          Mag_1: { t1: { marks: ['2026-11-02'], adjust: 1, site: 2 } },
          Luk_2: { t1: { marks: [], adjust: 0 } }
        },
        bonuses: [{ needTasks: 2, text: 'Бонус' }],
        awards: [],
        createdAt: '2026-11-01T00:00:00.000Z'
      },
      { id: 's1', kind: 'series', title: 'Папка', childIds: ['m1'] }
    ],
    plannerEntries: [
      {
        id: 'pe1',
        title: 'Собрать пати',
        date: '2026-11-25',
        time: '19:00',
        durationMinutes: 60,
        kind: 'party',
        priority: 'high',
        recurrence: 'weekly'
      }
    ],
    finance: {
      operations: [{ id: 'op1', date: '2026-11-20', kind: 'in', amount: 500, currency: 'gold' }],
      shopItems: [],
      loans: [],
      settings: { goldRate: 2.5, commissionPct: 5, opening: { gold: 100 } }
    }
  };
}

/** deps для мутаций: сохранение «успешно», запись разрешена, время фиксировано. */
function makeDeps(extra = {}) {
  return {
    persist: vi.fn(async () => {}),
    assertStateWriteAvailable: () => {},
    now: () => '2026-11-25T12:00:00.000Z',
    ...extra
  };
}

describe('внешний API: марафоны', () => {
  it('отдаёт прогресс, задания и награды, не теряя структуру ячейки', () => {
    const state = makeState();
    const { marathons } = publicMarathons(state);
    expect(marathons).toHaveLength(2);
    const marathon = marathons.find(row => row.id === 'm1');
    expect(marathon.tasks.map(task => task.id)).toEqual(['t1', 't2']);
    expect(marathon.tasks[0].rewards).toEqual([{ threshold: 5, rewardText: '100 монет', rewardCoins: 100 }]);
    expect(marathon.progress.Mag_1.t1).toEqual({ marks: ['2026-11-02'], adjust: 1, site: 2 });
    // Папка — отдельная запись без заданий и прогресса.
    expect(marathon.progress.Luk_2.t1).toEqual({ marks: [], adjust: 0, site: null });
    const folder = marathons.find(row => row.id === 's1');
    expect(folder.kind).toBe('series');
    expect(folder.childIds).toEqual(['m1']);
    expect(folder.tasks).toBeUndefined();
  });

  it('считает итоги через переданную функцию, а её падение не ломает список', () => {
    const state = makeState();
    const totals = publicMarathons(state, () => ({ checks: 3, maxChecks: 23, coins: 0, maxCoins: 100 }));
    expect(totals.marathons[0].totals).toEqual({ checks: 3, maxChecks: 23, coins: 0, maxCoins: 100 });
    const broken = publicMarathons(state, () => {
      throw new Error('нет задач');
    });
    expect(broken.marathons.find(row => row.id === 'm1').totals).toBeNull();
  });

  it('находит марафон по id и отдаёт 404-семантику через null', () => {
    const state = makeState();
    expect(publicMarathonById(state, 'm1').title).toBe('Марафон ноября');
    expect(publicMarathonById(state, 's1').kind).toBe('series');
    expect(publicMarathonById(state, 'нет')).toBeNull();
  });

  it('перечисляет участников и их пати', () => {
    const state = makeState();
    const participants = marathonParticipants(state, 'm1');
    expect(participants.characters).toEqual([
      { id: 'Mag_1', nick: 'Маг' },
      { id: 'Luk_2', nick: 'Лучник' }
    ]);
    expect(participants.parties).toEqual([{ id: 'p1', name: 'Основа' }]);
    expect(marathonParticipants(state, 'нет')).toBeNull();
  });

  it('отдаёт отметку только после проверки персонажа, задания и даты', async () => {
    const state = makeState();
    const deps = makeDeps();

    const result = await setMarathonMark(state, 'm1', { characterId: 'Mag_1', taskId: 't1', date: '2026-11-05' }, deps);
    expect(result).toMatchObject({ marked: true, changed: true });
    expect(state.marathons[0].progress.Mag_1.t1.marks).toContain('2026-11-05');

    // Снять отметку.
    const removed = await setMarathonMark(
      state,
      'm1',
      { characterId: 'Mag_1', taskId: 't1', date: '2026-11-05', marked: false },
      deps
    );
    expect(removed.changed).toBe(true);
    expect(state.marathons[0].progress.Mag_1.t1.marks).not.toContain('2026-11-05');
  });

  it('отклоняет дату вне сроков, чужого персонажа и папку марафонов', async () => {
    const state = makeState();
    const deps = makeDeps();
    const codeOf = async promise => {
      try {
        await promise;
      } catch (error) {
        return { status: error.status, code: error.code };
      }
      return null;
    };
    expect(
      await codeOf(setMarathonMark(state, 'm1', { characterId: 'Mag_1', taskId: 't1', date: '2026-10-31' }, deps))
    ).toEqual({ status: 422, code: 'invalid_value' });
    expect(
      await codeOf(setMarathonMark(state, 'm1', { characterId: 'Drug_3', taskId: 't1', date: '2026-11-05' }, deps))
    ).toEqual({ status: 422, code: 'invalid_value' });
    expect(
      await codeOf(setMarathonMark(state, 's1', { characterId: 'Mag_1', taskId: 't1', date: '2026-11-05' }, deps))
    ).toEqual({ status: 409, code: 'marathon_not_ready' });
    expect(
      await codeOf(setMarathonMark(state, 'm1', { characterId: 'Mag_1', taskId: 'нет', date: '2026-11-05' }, deps))
    ).toEqual({ status: 404, code: 'no_such_task' });
    // Неизвестное поле — тоже отказ, а не тихое игнорирование.
    expect(
      await codeOf(
        setMarathonMark(state, 'm1', { characterId: 'Mag_1', taskId: 't1', date: '2026-11-05', extra: 1 }, deps)
      )
    ).toEqual({ status: 422, code: 'invalid_value' });
  });

  it('меняет поправку и не сохраняет, если значение не изменилось', async () => {
    const state = makeState();
    const deps = makeDeps();
    const result = await adjustMarathonCell(state, 'm1', { characterId: 'Mag_1', taskId: 't1', value: 4 }, deps);
    expect(result).toMatchObject({ adjust: 4, previous: 1, changed: true });
    expect(deps.persist).toHaveBeenCalledTimes(1);

    const same = await adjustMarathonCell(state, 'm1', { characterId: 'Mag_1', taskId: 't1', value: 4 }, deps);
    expect(same.changed).toBe(false);
    expect(deps.persist).toHaveBeenCalledTimes(1);
    await expect(
      adjustMarathonCell(state, 'm1', { characterId: 'Mag_1', taskId: 't1', value: 1.5 }, deps)
    ).rejects.toMatchObject({ status: 422, code: 'invalid_value' });
  });
});

describe('внешний API: персонажи и проходки', () => {
  it('PATCH /dungeon-passes меняет только проходки и возвращает прежние значения', async () => {
    const state = makeState();
    const deps = makeDeps();
    const result = await patchDungeonPasses(state, 'Mag_1', { weapon: 5, relic: 3 }, deps);
    expect(result.dungeonPasses).toEqual({ weapon: 5, armor: 1, relic: 3 });
    expect(result.previous).toEqual({ weapon: 2, armor: 1, relic: 0 });
    expect(result.changed).toEqual(['dungeonPasses.weapon', 'dungeonPasses.relic']);
    expect(state.characters[0].stats.hp).toBe(100); // статы не тронуты
  });

  it('поля карточки меняются через PATCH /characters вместе со статами', async () => {
    const state = makeState();
    const deps = makeDeps();
    const result = await patchCharacter(
      state,
      'Mag_1',
      { stats: { hp: 150 }, nick: 'Маг II', level: 101, tags: ' осн , PvP ' },
      deps
    );
    expect(result.changed).toContain('stats.hp');
    expect(result.changed).toContain('nick');
    expect(state.characters[0].nick).toBe('Маг II');
    expect(state.characters[0].level).toBe(101);
    expect(state.characters[0].tags).toEqual(['осн', 'PvP']);
    // История статов добавляется именно за статы.
    expect(result.statsHistoryAdded).toBe(true);
    expect(state.characters[0].statsHistory?.length).toBe(1);
  });

  it('неизвестное поле карточки — 422, пустой патч — 422', async () => {
    const state = makeState();
    const deps = makeDeps();
    await expect(patchCharacterFields(state, 'Mag_1', { password: 'x' }, deps)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_value'
    });
    await expect(patchCharacterFields(state, 'Mag_1', {}, deps)).rejects.toMatchObject({ status: 422 });
    await expect(patchCharacterFields(state, 'нет', { nick: 'x' }, deps)).rejects.toMatchObject({ status: 404 });
  });

  it('создаёт персонажа с обязательным ником и помечает дубль', async () => {
    const state = makeState();
    const deps = makeDeps();
    const created = await createCharacter(state, { nick: 'маг', class: 'Маг', level: 3 }, deps);
    expect(created.duplicateNick).toBe(true);
    expect(state.characters).toHaveLength(4);
    const added = state.characters.find(char => char.id === created.character.id);
    expect(added).toMatchObject({ nick: 'маг', class: 'Маг', level: 3, favorite: false });
    await expect(createCharacter(state, { class: 'Маг' }, deps)).rejects.toMatchObject({ status: 422 });
  });

  it('чтение не отдаёт контакты, пароль и путь запуска', () => {
    const state = makeState();
    const { characters } = publicCharacters(state);
    const json = JSON.stringify(characters);
    expect(json).not.toContain('p@ss');
    expect(json).not.toContain('gc@example.com');
    expect(json).not.toContain('game.exe');
    // А нужное для твин-фермы — отдаёт.
    expect(characters[0]).toHaveProperty('dungeonPasses.weapon', 2);
    expect(characters[0]).toHaveProperty('tags');
    expect(characters[0]).toHaveProperty('coinHistory');
  });

  it('пати: название и цвет меняются, пустое название — отказ', async () => {
    const state = makeState();
    const deps = makeDeps({ renderParties: vi.fn() });
    const result = await patchParty(state, 'p1', { name: 'Основа+', color: '#000' }, deps);
    expect(result.changed).toEqual(['name', 'color']);
    expect(deps.renderParties).toHaveBeenCalled();
    await expect(patchParty(state, 'p1', { name: '  ' }, deps)).rejects.toMatchObject({ status: 422 });
    await expect(patchParty(state, 'нет', { name: 'x' }, deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('внешний API: выгрузки', () => {
  it('CSV экранирует разделитель, кавычки и перевод строки', () => {
    const csv = toCsv(
      [
        ['a', 'A'],
        ['b', 'B']
      ],
      [
        { a: 'с;точкой', b: 'кавычка "тут"' },
        { a: 'строка\nперенос', b: 5 }
      ]
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('A;B');
    expect(csv).toContain('"с;точкой";"кавычка ""тут"""');
    expect(csv).toContain('"строка\nперенос";5');
    expect(csv.split('\r\n')[0]).toBe('\uFEFFA;B');
  });

  it('выгружает персонажей с понятными колонками и без секретов', () => {
    const state = makeState();
    const csv = buildExport(state, 'characters', { dateStamp: '2026-11-25' });
    expect(csv.fileName).toBe('tvinoferma_characters_2026-11-25.csv');
    expect(csv.contentType).toContain('text/csv');
    expect(csv.rows).toBe(3);
    expect(csv.text).toContain('Ник');
    expect(csv.text).toContain('Маг');
    expect(csv.text).not.toContain('p@ss');
    expect(csv.text).not.toContain('game.exe');
  });

  it('выгрузка JSON — массив строк, без обёрток облачной синхронизации', () => {
    const state = makeState();
    const json = buildExport(state, 'parties', { format: 'json' });
    expect(json.contentType).toContain('application/json');
    const parsed = JSON.parse(json.text);
    expect(parsed.dataset).toBe('parties');
    expect(parsed.rows[0]).toMatchObject({ id: 'p1', name: 'Основа', membersCount: 2 });
  });

  it('выгружает марафоны, планировщик и учёт', () => {
    const state = makeState();
    const marathons = buildExport(state, 'marathons');
    expect(marathons.text).toContain('Марафон ноября');
    expect(marathons.rows).toBe(2);
    const planner = buildExport(state, 'planner');
    expect(planner.text).toContain('Собрать пати');
    const finance = buildExport(state, 'finance');
    expect(finance.text).toContain('2026-11-20');
    expect(finance.text).toContain('500');
  });

  it('неизвестный набор — ошибка, а не пустой файл', () => {
    expect(() => buildExport(makeState(), 'секреты')).toThrow(/Неизвестный набор/);
    expect(EXPORT_DATASETS).not.toContain('contacts');
  });
});

describe('внешний API: запуск выбранных персонажей', () => {
  it('сохраняет порядок выбора и сообщает о неизвестных id', () => {
    const state = makeState();
    const jobs = new JobRegistry({ now: () => 1_000 });
    const launchGroup = vi.fn(async () => []);
    const job = launchSelectionJob(
      state,
      { characterIds: ['Luk_2', 'Mag_1', 'нет'] },
      { jobs, launchGroup, preflight: async () => ({ toLaunch: [], alreadyRunning: [] }) }
    );
    expect(job.kind).toBe('selection');
    // Двое найдены, «нет» — в ignoredIds; архивных персонажей в выборе нет.
    expect(job.result).toBeNull();
    expect(jobs.get(job.id).progress.total).toBe(2);
  });

  it('отклоняет пустой список, дубликаты и слишком длинный выбор', () => {
    const state = makeState();
    const jobs = { active: () => null, create: vi.fn(), get: () => null };
    const codeOf = body => {
      try {
        launchSelectionJob(state, body, { jobs, launchGroup: vi.fn(), preflight: vi.fn() });
      } catch (error) {
        return { status: error.status, code: error.code };
      }
      return null;
    };
    expect(codeOf({ characterIds: [] })).toEqual({ status: 422, code: 'invalid_value' });
    expect(codeOf({ characterIds: ['Mag_1', 'Mag_1'] })).toEqual({ status: 422, code: 'invalid_value' });
    expect(codeOf({ characterIds: ['нет'] })).toEqual({ status: 404, code: 'no_such_character' });
    const many = Array.from({ length: MAX_SELECTION + 1 }, (_, index) => `c${index}`);
    expect(codeOf({ characterIds: many })).toEqual({ status: 422, code: 'invalid_value' });
  });
});
