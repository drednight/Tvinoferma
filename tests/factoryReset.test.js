// Полный сброс (js/settings/factoryReset.js): сбор ключей хранилища ОС и текст предупреждения.
// Ошибка здесь дорога: неполный список ключей оставит пароли после «чистой установки».
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  contactKeysOf,
  accountKeysOfAll,
  secretsToRemove,
  resetSummary,
  resetWarning
} from '../js/settings/factoryReset.js';

const characters = () => [
  {
    id: 'Ауразак',
    nick: 'Ауразак',
    launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'aura' } }, gcAccount: true, gcPath: 'D:\\GC' }
  },
  {
    id: 'Мираж',
    nick: 'Мираж',
    launch: { gcIds: ['gc-2'], gcAccounts: { 'gc-2': { nick: 'mirage' }, 'gc-2legacy': { nick: 'old', legacy: true } } }
  },
  { id: 'Пустой', nick: 'Пустой' }
];

describe('ключи хранилища ОС для сброса', () => {
  it('контакты — по id персонажа', () => {
    expect(contactKeysOf(characters())).toEqual(['Ауразак', 'Мираж', 'Пустой']);
    expect(contactKeysOf([])).toEqual([]);
    expect(contactKeysOf(null)).toEqual([]);
  });

  it('входы GameCenter — по ключу «персонаж@GameCenter» и старый ключ', () => {
    const keys = accountKeysOfAll(characters());
    expect(keys).toContain('Ауразак@gc-1');
    expect(keys).toContain('Мираж@gc-2');
    // Перенесённый вход (legacy) хранится под старым ключом — id персонажа
    expect(keys).toContain('Мираж');
    // У персонажа со «своим путём» вход лежит под его id
    expect(keys).toContain('Ауразак');
  });

  it('итоговый список без повторов и пустых значений', () => {
    const keys = secretsToRemove(characters());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(k => k && k.trim())).toBe(true);
    expect(keys).toContain('Ауразак');
    expect(keys).toContain('Ауразак@gc-1');
  });

  it('персонажи без launch не ломают сбор', () => {
    expect(secretsToRemove([{ id: 'x' }, null, {}])).toEqual(['x']);
  });
});

describe('сводка и предупреждение', () => {
  const appState = () => ({
    characters: characters(),
    parties: [{ id: 'p1' }, { id: 'p2' }],
    marathons: [{ id: 'm1' }]
  });

  it('считает персонажей, пати, марафоны и записи хранилища', () => {
    const s = resetSummary(appState());
    expect(s.chars).toBe(3);
    expect(s.parties).toBe(2);
    expect(s.marathons).toBe(1);
    expect(s.secrets).toBeGreaterThan(0);
  });

  it('пустые данные дают нули', () => {
    expect(resetSummary({})).toEqual({ chars: 0, parties: 0, marathons: 0, secrets: 0 });
  });

  it('предупреждение перечисляет, что удаляется, и говорит о необратимости', () => {
    const text = resetWarning(resetSummary(appState()));
    expect(text).toContain('персонажей: 3');
    expect(text).toContain('пати: 2');
    expect(text).toContain('марафонов: 1');
    expect(text).toContain('журналы');
    expect(text).toContain('сессии');
    expect(text).toContain('откатить это действие нельзя');
    expect(text).toContain('сначала сделайте экспорт');
    expect(text).toContain('открытые контакты и пароли');
    expect(text).toContain('не включает отдельные журналы, сессии, профили и входы GameCenter');
    expect(text).toContain('пытается удалить известные локальные записи доступа к облаку');
    expect(text).toContain('локальную очередь отправки');
    expect(text).toContain('облачные файлы и разрешения, выданные провайдерам, сохраняются');
    expect(text).toContain('неизвестные записи хранилища ОС могут остаться');
  });

  it('на пустых данных предупреждение не перечисляет ничего лишнего', () => {
    const text = resetWarning(resetSummary({}));
    expect(text).not.toContain('Будет удалено');
    expect(text).toContain('откатить это действие нельзя');
  });
});

describe('performFactoryReset: порядок и обработка ошибок', () => {
  const invokeMock = vi.fn();
  const toastMock = vi.fn();
  let perform;
  let prepare;
  let discard;

  beforeEach(async () => {
    vi.resetModules();
    invokeMock.mockReset();
    toastMock.mockReset();
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: (...a) => invokeMock(...a) }));
    vi.doMock('../js/core/ui.js', () => ({ toast: (...a) => toastMock(...a) }));
    window.__TAURI_INTERNALS__ = {};
    ({
      performFactoryReset: perform,
      prepareFactoryReset: prepare,
      discardFactoryResetPlan: discard
    } = await import('../js/settings/factoryReset.js'));
  });
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.doUnmock('@tauri-apps/api/core');
    vi.doUnmock('../js/core/ui.js');
  });

  it('вне приложения сброс не выполняется и ничего не удаляет', async () => {
    delete window.__TAURI_INTERNALS__;
    expect(await perform({ characters: characters() })).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('только в приложении'), 'error');
  });

  it('не выполняется без одноразового плана от диалога подтверждения', async () => {
    const appState = { characters: characters() };
    const plan = prepare(appState);
    expect(await perform(appState)).toBe(false);
    expect(await perform(appState, { ...plan })).toBe(false);
    expect(await perform({ characters: characters() }, plan)).toBe(false);
    discard(plan);
    expect(await perform(appState, plan)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('передаёт разные пространства имён и учитывает архивных персонажей', async () => {
    invokeMock.mockImplementation(async command =>
      command === 'load_state_raw'
        ? '{"fictional":true}'
        : {
            stateRemoved: true,
            backupsRemoved: 1,
            sessionsRemoved: true,
            profilesRemoved: true,
            secretsRemoved: 4,
            problems: [],
            message: 'Готово'
          }
    );
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const archived = { id: 'Архив', launch: { gcIds: ['gc-old'] } };
    const appState = { characters: characters(), archivedCharacters: [archived] };
    expect(await perform(appState, prepare(appState))).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('factory_reset', {
      keys: expect.arrayContaining(['Ауразак', 'Мираж', 'Архив']),
      accountKeys: expect.arrayContaining(['Ауразак', 'Ауразак@gc-1', 'Мираж@gc-2', 'Архив', 'Архив@gc-old']),
      expectedRaw: '{"fictional":true}'
    });
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('ошибка IPC считается неизвестным исходом и не раскрывает сообщение системы', async () => {
    invokeMock.mockImplementation(async command => {
      if (command === 'load_state_raw') return null;
      throw new Error('PRIVATE-PATH');
    });
    const appState = { characters: characters() };
    expect(await perform(appState, prepare(appState))).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Сброс мог затронуть часть данных'), 'error', 60000);
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain('PRIVATE-PATH');
    expect(await perform(appState, prepare(appState))).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
