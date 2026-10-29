import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  modal: null,
  save: vi.fn(),
  backup: vi.fn(),
  persist: vi.fn(),
  assertWritable: vi.fn(),
  halt: vi.fn(),
  compare: vi.fn(),
  rename: vi.fn(),
  toast: vi.fn()
}));
vi.mock('../js/core/storage.js', () => ({
  saveNow: mocks.save,
  createBackup: mocks.backup,
  forceRenderAndPersist: mocks.persist,
  assertStateWriteAvailable: mocks.assertWritable,
  haltAfterPartialStateChange: mocks.halt,
  isTauri: () => false
}));
vi.mock('../js/core/ui.js', () => ({
  showModal: options => (mocks.modal = options),
  toast: mocks.toast
}));
vi.mock('../js/data/compare.js', () => ({ openCompareDialog: mocks.compare }));
vi.mock('../js/modules/characters/identity.js', async importOriginal => ({
  ...(await importOriginal()),
  syncIdWithNick: mocks.rename
}));

import { state, normalizeState, normalizeCharacter } from '../js/core/state.js';
import { normalizePlannerEntry } from '../js/modules/dashboard/planner.js';
import { openImportDialog } from '../js/data/import.js';

function deferred() {
  let resolve;
  const promise = new Promise(yes => (resolve = yes));
  return { promise, resolve };
}
function form(mode = 'replace', cmp = [], add = ['New']) {
  return { get: () => mode, getAll: key => (key === 'cmp' ? cmp : key === 'add' ? add : []) };
}
function newCharacterFile() {
  return { schemaVersion: 10, characters: [{ id: 'New', nick: 'New', level: 3 }] };
}
function conflictFile() {
  return { schemaVersion: 10, characters: [{ id: 'Bob', nick: 'Robert', level: 20 }] };
}
function planner(overrides = {}) {
  return normalizePlannerEntry({
    id: 'event',
    title: 'Встреча',
    date: '2026-10-29',
    time: '19:30',
    kind: 'event',
    recurrence: 'weekly',
    status: 'doing',
    statusByDate: { '2026-11-05': 'done' },
    reminderMinutes: 30,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides
  });
}
async function submitted(mode, raw = newCharacterFile(), cmp = []) {
  openImportDialog(raw);
  return mocks.modal.onSubmit(form(mode, cmp));
}
async function waitForToast(text) {
  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining(text), expect.any(String), expect.anything())
  );
}

beforeEach(() => {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, normalizeState({ schemaVersion: 10 }));
  state.characters = [
    normalizeCharacter({ id: 'Bob', nick: 'Bob', level: 10, contacts: { password: 'PRIVATE-INPUT' } })
  ];
  mocks.modal = null;
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.backup.mockReset().mockResolvedValue('test-backup');
  mocks.persist.mockReset().mockResolvedValue(undefined);
  mocks.assertWritable.mockReset();
  mocks.halt.mockReset();
  mocks.compare.mockReset().mockResolvedValue({ action: 'take' });
  mocks.rename.mockReset().mockResolvedValue({ changed: false });
  mocks.toast.mockReset();
});

describe('импорт требует сохранения и подтверждённой предварительной копии', () => {
  it.each(['replace', 'merge'])(
    '%s: останавливается до изменения данных, если сохранение не подтверждено',
    async mode => {
      const before = JSON.stringify(state);
      mocks.save.mockRejectedValueOnce(new Error('PRIVATE-INPUT'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await submitted(mode);
        await waitForToast('Импорт остановлен');
        expect(JSON.stringify(state)).toBe(before);
        expect(mocks.backup).not.toHaveBeenCalled();
        expect(mocks.persist).not.toHaveBeenCalled();
        expect(mocks.halt).not.toHaveBeenCalled();
        expect(JSON.stringify([mocks.toast.mock.calls, warn.mock.calls])).not.toContain('PRIVATE-INPUT');
      } finally {
        warn.mockRestore();
      }
    }
  );

  it.each(['replace', 'merge'])('%s: останавливается до изменения данных, если копия не создана', async mode => {
    const before = JSON.stringify(state);
    mocks.backup.mockRejectedValueOnce(new Error('PRIVATE-INPUT'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await submitted(mode);
      await waitForToast('Импорт остановлен');
      expect(JSON.stringify(state)).toBe(before);
      expect(mocks.save).toHaveBeenCalledOnce();
      expect(mocks.backup).toHaveBeenCalledWith('pre-import');
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.halt).not.toHaveBeenCalled();
      expect(JSON.stringify([mocks.toast.mock.calls, warn.mock.calls])).not.toContain('PRIVATE-INPUT');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([undefined, null, false, {}, '', '  '])('отклоняет неверное подтверждение копии: %s', async response => {
    const before = JSON.stringify(state);
    mocks.backup.mockResolvedValueOnce(response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await submitted('replace')).toBe(false);
      expect(JSON.stringify(state)).toBe(before);
      expect(mocks.persist).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('явно предупреждает об отключённой копии, но уважает выбор пользователя', async () => {
    state.settings.backups.createBeforeImport = false;
    openImportDialog(newCharacterFile());
    expect(mocks.modal.content).toContain('Автоматическая копия перед импортом отключена');
    expect(mocks.modal.content).toContain('контакты в хранилище ОС');
    expect(await mocks.modal.onSubmit(form())).toBe(true);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(state.characters.map(c => c.id)).toEqual(['New']);
  });

  it('без автоматической копии тоже останавливается, если сохранить прежние данные не удалось', async () => {
    state.settings.backups.createBeforeImport = false;
    const before = JSON.stringify(state);
    mocks.save.mockRejectedValueOnce(new Error('PRIVATE'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await submitted('replace')).toBe(false);
      expect(JSON.stringify(state)).toBe(before);
      expect(mocks.backup).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('при включённой копии честно описывает её ограничения', () => {
    openImportDialog(newCharacterFile());
    expect(mocks.modal.content).toContain('создаст копию состояния');
    expect(mocks.modal.content).toContain('контакты в хранилище ОС');
    expect(mocks.modal.content).toContain('GameCenter');
  });
});

describe('актуальность выбора и пересечения в одном JS-контексте', () => {
  it('не применяет устаревшее решение, если данные изменились, пока была открыта сводка', async () => {
    openImportDialog(newCharacterFile());
    state.characters[0].level = 99;
    expect(await mocks.modal.onSubmit(form())).toBe(false);
    expect(state.characters.map(c => c.id)).toEqual(['Bob']);
    expect(mocks.save).not.toHaveBeenCalled();
    await waitForToast('Данные изменились');
  });

  it('не считает изменение ui изменением сохраняемых данных', async () => {
    openImportDialog(newCharacterFile());
    state.ui.currentPage = 'settings';
    expect(await mocks.modal.onSubmit(form())).toBe(true);
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it.each(['replace', 'merge'])('%s: прекращает импорт, если данные изменились при сохранении', async mode => {
    mocks.save.mockImplementationOnce(async () => {
      state.characters[0].level = 99;
    });
    await submitted(mode);
    await waitForToast('Данные изменились');
    expect(state.characters.map(c => c.id)).toEqual(['Bob']);
    expect(state.characters[0].level).toBe(99);
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it.each(['replace', 'merge'])('%s: прекращает импорт, если данные изменились во время копии', async mode => {
    mocks.backup.mockImplementationOnce(async () => {
      state.characters[0].level = 99;
      return 'test-backup';
    });
    await submitted(mode);
    await waitForToast('Данные изменились');
    expect(state.characters.map(c => c.id)).toEqual(['Bob']);
    expect(state.characters[0].level).toBe(99);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('не применяет результаты сравнения, если локальные данные изменились во время диалога', async () => {
    mocks.compare.mockImplementationOnce(async () => {
      state.characters[0].level = 99;
      return { action: 'take' };
    });
    await submitted('merge', conflictFile(), ['Bob']);
    await waitForToast('Данные изменились');
    expect(state.characters[0].level).toBe(99);
    expect(state.characters[0].nick).toBe('Bob');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.backup).not.toHaveBeenCalled();
  });

  it('отмена сравнения ничего не сохраняет и не меняет', async () => {
    const before = JSON.stringify(state);
    mocks.compare.mockResolvedValueOnce({ action: 'cancel' });
    await submitted('merge', conflictFile(), ['Bob']);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Импорт отменён', 'info'));
    expect(JSON.stringify(state)).toBe(before);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.backup).not.toHaveBeenCalled();
  });

  it('не запускает второй импорт, пока первый ожидает сохранения', async () => {
    const pending = deferred();
    mocks.save.mockReturnValueOnce(pending.promise);
    openImportDialog(newCharacterFile());
    const firstModal = mocks.modal;
    const first = firstModal.onSubmit(form());
    expect(await firstModal.onSubmit(form())).toBe(false);
    openImportDialog(conflictFile());
    expect(mocks.modal).toBe(firstModal);
    expect(mocks.save).toHaveBeenCalledOnce();
    pending.resolve();
    expect(await first).toBe(true);
    expect(mocks.backup).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it.each(['save', 'backup'])('закрытие окна при ожидании %s отменяет замену данных', async step => {
    const pending = deferred();
    if (step === 'save') mocks.save.mockReturnValueOnce(pending.promise);
    else mocks.backup.mockReturnValueOnce(pending.promise);
    const before = JSON.stringify(state);
    openImportDialog(newCharacterFile());
    const oldModal = mocks.modal;
    const running = oldModal.onSubmit(form());
    if (step === 'backup') await vi.waitFor(() => expect(mocks.backup).toHaveBeenCalledOnce());
    oldModal.onClose();
    pending.resolve(step === 'backup' ? 'test-backup' : undefined);
    expect(await running).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.halt).not.toHaveBeenCalled();
    openImportDialog(newCharacterFile());
    expect(mocks.modal).not.toBe(oldModal);
  });

  it('не меняет память, если запись заблокирована перед самым применением', async () => {
    const before = JSON.stringify(state);
    mocks.assertWritable.mockImplementationOnce(() => {
      throw new Error('PRIVATE');
    });
    expect(await submitted('replace')).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.halt).not.toHaveBeenCalled();
  });
});

describe('задачи и события при обычном импорте JSON', () => {
  it('при явной замене переносит календарь с повторами, отметками и клановым ID', async () => {
    state.plannerEntries = [planner({ id: 'old', title: 'Старое' })];
    const entries = [
      planner({ syncId: 'a9115bf2-e834-444d-aeb6-7c3af1db8890' }),
      planner({ id: 'guild-42', title: 'Клан', status: 'done', recurrence: 'daily' })
    ];
    const file = { ...newCharacterFile(), plannerEntries: entries };
    openImportDialog(file);
    expect(mocks.modal.content).toContain('Задач и событий в файле: 2');
    expect(mocks.modal.content).toContain('заменят текущий календарь целиком');
    expect(mocks.modal.content).toContain('объединение календаря пока не поддерживается');
    expect(await mocks.modal.onSubmit(form())).toBe(true);
    expect(state.plannerEntries).toEqual(entries);
    expect(state.plannerEntries[0].statusByDate).toEqual({ '2026-11-05': 'done' });
    expect(state.plannerEntries[0].syncId).toBe('a9115bf2-e834-444d-aeb6-7c3af1db8890');
    expect(state.plannerEntries[1].id).toBe('guild-42');
    expect(mocks.backup).toHaveBeenCalledBefore(mocks.persist);
  });

  it('пустой календарь в файле заменяет текущие записи только после подтверждения копии', async () => {
    state.plannerEntries = [planner()];
    expect(await submitted('replace', { ...newCharacterFile(), plannerEntries: [] })).toBe(true);
    expect(state.plannerEntries).toEqual([]);
  });

  it('если календаря в файле нет, предупреждает и оставляет текущие записи', async () => {
    state.plannerEntries = [planner()];
    const before = JSON.stringify(state.plannerEntries);
    openImportDialog(newCharacterFile());
    expect(mocks.modal.content).toContain('В файле нет календаря');
    expect(await mocks.modal.onSubmit(form())).toBe(true);
    expect(JSON.stringify(state.plannerEntries)).toBe(before);
  });

  it('при объединении явно предупреждает и не меняет календарь', async () => {
    state.plannerEntries = [planner({ id: 'old' })];
    const before = JSON.stringify(state.plannerEntries);
    const file = { ...newCharacterFile(), plannerEntries: [planner({ id: 'from-file' })] };
    openImportDialog(file);
    expect(mocks.modal.content).toContain('объединение календаря пока не поддерживается');
    expect(await mocks.modal.onSubmit(form('merge'))).toBe(true);
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    expect(JSON.stringify(state.plannerEntries)).toBe(before);
  });

  it('не меняет календарь, если предварительная копия не подтверждена', async () => {
    state.plannerEntries = [planner({ id: 'old' })];
    const before = JSON.stringify(state.plannerEntries);
    mocks.backup.mockRejectedValueOnce(new Error('PRIVATE'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await submitted('replace', { ...newCharacterFile(), plannerEntries: [planner()] })).toBe(false);
      expect(JSON.stringify(state.plannerEntries)).toBe(before);
      expect(mocks.persist).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['не массив', () => ({ plannerEntries: {} })],
    ['пустое название', () => ({ plannerEntries: [{ ...planner(), title: '' }] })],
    ['недопустимая дата', () => ({ plannerEntries: [{ ...planner(), date: '2026-02-30' }] })],
    ['недопустимое время', () => ({ plannerEntries: [{ ...planner(), time: '25:01' }] })],
    ['неизвестное поле', () => ({ plannerEntries: [{ ...planner(), futureField: 'PRIVATE' }] })],
    ['неоднозначный ID', () => ({ plannerEntries: [planner({ id: 'Task' }), planner({ id: 'task' })] })],
    [
      'неоднозначный sync-ID',
      () => ({ plannerEntries: [planner({ id: 'a', syncId: 'same' }), planner({ id: 'b', syncId: 'same' })] })
    ],
    ['повреждённая отметка', () => ({ plannerEntries: [{ ...planner(), statusByDate: { '2026-02-30': 'done' } }] })]
  ])('не заменяет данные, если календарь содержит %s', async (_label, fixture) => {
    state.plannerEntries = [planner({ id: 'old' })];
    const before = JSON.stringify(state);
    openImportDialog({ ...newCharacterFile(), ...fixture() });
    expect(mocks.modal.content).toContain('замена будет остановлена');
    expect(await mocks.modal.onSubmit(form())).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE');
  });

  it('останавливает неподдерживаемую новую схему до открытия окна и до изменений', () => {
    const before = JSON.stringify(state);
    openImportDialog({ ...newCharacterFile(), schemaVersion: 999 });
    expect(mocks.modal).toBeNull();
    expect(JSON.stringify(state)).toBe(before);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('более новой версией'), 'error', 60000);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe('неподтверждённый результат после изменения данных', () => {
  it.each(['replace', 'merge'])(
    '%s: останавливает будущие записи и не объявляет успех при ошибке сохранения',
    async mode => {
      mocks.persist.mockRejectedValueOnce(new Error('PRIVATE-INPUT'));
      await submitted(mode);
      await waitForToast('Импорт мог выполниться частично');
      expect(mocks.halt).toHaveBeenCalledOnce();
      expect(
        mocks.toast.mock.calls.some(([text, kind]) => kind === 'success' && text.includes('Импорт завершён'))
      ).toBe(false);
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE-INPUT');
    }
  );

  it('сначала сохраняет объединённые данные, потом переименовывает профиль и сохраняет новый ID', async () => {
    const sequence = [];
    mocks.persist.mockImplementation(async () => {
      sequence.push(`save:${state.characters[0].id}:${state.characters[0].nick}`);
    });
    mocks.rename.mockImplementation(async character => {
      sequence.push('rename');
      character.id = 'Robert';
      return { changed: true, oldId: 'Bob', newId: 'Robert' };
    });
    await submitted('merge', conflictFile(), ['Bob']);
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(2));
    expect(sequence).toEqual(['save:Bob:Robert', 'rename', 'save:Robert:Robert']);
    expect(mocks.halt).not.toHaveBeenCalled();
  });

  it('блокирует дальнейшие записи при неизвестном исходе переноса профиля', async () => {
    mocks.rename.mockResolvedValueOnce({ changed: false, error: 'profile_rename_unconfirmed' });
    await submitted('merge', conflictFile(), ['Bob']);
    await waitForToast('Импорт мог выполниться частично');
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.halt).toHaveBeenCalledOnce();
  });

  it('считает занятый профиль частичным результатом: native мог уже затронуть банк cookie', async () => {
    mocks.rename.mockResolvedValueOnce({ changed: false, error: 'profile_busy' });
    await submitted('merge', conflictFile(), ['Bob']);
    await waitForToast('Импорт мог выполниться частично');
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.halt).toHaveBeenCalledOnce();
  });

  it('блокирует дальнейшие записи при неизвестной ошибке переноса, не раскрывая её текст', async () => {
    mocks.rename.mockResolvedValueOnce({ changed: false, error: 'PRIVATE-IPC-DETAIL' });
    await submitted('merge', conflictFile(), ['Bob']);
    await waitForToast('Импорт мог выполниться частично');
    expect(mocks.halt).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('PRIVATE-IPC-DETAIL');
  });

  it('предупреждает о конфликте ссылок, обнаруженном до переноса профиля', async () => {
    mocks.rename.mockResolvedValueOnce({ changed: false, error: 'references_conflict' });
    await submitted('merge', conflictFile(), ['Bob']);
    await waitForToast('перенос некоторых профилей');
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.halt).not.toHaveBeenCalled();
  });
});
