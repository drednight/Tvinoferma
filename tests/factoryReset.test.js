// Полный сброс (js/settings/factoryReset.js): сбор ключей хранилища ОС и текст предупреждения.
// Ошибка здесь дорога: неполный список ключей оставит пароли после «чистой установки».
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  contactKeysOf, accountKeysOfAll, secretsToRemove, resetSummary, resetWarning
} from '../js/settings/factoryReset.js';

const characters = () => [
  {
    id: 'Ауразак', nick: 'Ауразак',
    launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'aura' } }, gcAccount: true, gcPath: 'D:\\GC' }
  },
  {
    id: 'Мираж', nick: 'Мираж',
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

  beforeEach(async () => {
    vi.resetModules();
    invokeMock.mockReset(); toastMock.mockReset();
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: (...a) => invokeMock(...a) }));
    vi.doMock('../js/core/ui.js', () => ({ toast: (...a) => toastMock(...a) }));
    window.__TAURI_INTERNALS__ = {};
    ({ performFactoryReset: perform } = await import('../js/settings/factoryReset.js'));
  });
  afterEach(() => { delete window.__TAURI_INTERNALS__; vi.doUnmock('@tauri-apps/api/core'); vi.doUnmock('../js/core/ui.js'); });

  it('вне приложения сброс не выполняется и ничего не удаляет', async () => {
    delete window.__TAURI_INTERNALS__;
    expect(await perform({ characters: characters() })).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('только в приложении'), 'error');
  });

  it('в Rust уходит полный список ключей хранилища ОС', async () => {
    invokeMock.mockResolvedValue({ problems: [] });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    expect(await perform({ characters: characters() })).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('factory_reset', { keys: expect.arrayContaining(['Ауразак', 'Ауразак@gc-1', 'Мираж@gc-2']) });
    vi.unstubAllGlobals();
  });

  it('ошибка Rust: сообщение пользователю, окно не перезагружается', async () => {
    invokeMock.mockRejectedValue(new Error('файл занят'));
    expect(await perform({ characters: characters() })).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('файл занят'), 'error');
  });
});
