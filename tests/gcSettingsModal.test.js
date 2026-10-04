import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invokeMock(...a) }));
const persistMock = vi.fn(async () => {});
vi.mock('../js/core/storage.js', () => ({ persist: (...a) => persistMock(...a), isTauri: () => true }));
vi.mock('../js/core/ui.js', () => ({
  toast: vi.fn(),
  confirmModal: vi.fn(async () => true),
  showModal: ({ title, content, onClose }) => {
    document.getElementById('modal-root').innerHTML =
      `<div class="modal-container"><div class="modal-body">${content}</div></div>`;
    globalThis.__closeModal = onClose;
  }
}));

import { state } from '../js/core/state.js';
import { openGameCentersModal, gcSummaryText } from '../js/modules/launcher/gcSettingsModal.js';

const tick = () => new Promise(r => setTimeout(r, 0));
/** Ждёт, пока условие выполнится (динамические import в тестах занимают несколько тактов). */
async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('условие не выполнилось вовремя');
    await tick();
  }
}
const called = (cmd) => invokeMock.mock.calls.some(c => c[0] === cmd);
const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const GC2 = { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' };

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  // и мок модуля, и «настоящий» @tauri-apps/api/core (через window.__TAURI_INTERNALS__) ведут в один и тот же invokeMock
  window.__TAURI_INTERNALS__ = { invoke: (...a) => invokeMock(...a) };
  invokeMock.mockReset();
  persistMock.mockClear();
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === 'launcher_gc_info') return { exe: 'x', nick: 'Twin', loggedIn: true };
    if (cmd === 'launcher_pick_gamecenter') return 'D:\\GC3\\GameCenter.exe';
    if (cmd === 'launcher_capture_account') return 'Twin';
    return null;
  });
  state.settings.launcher.gameCenters = [{ ...GC1 }, { ...GC2 }];
  state.settings.launcher.preferredGcId = '';
  state.characters = [
    { id: 'a', nick: 'Альфа', class: 'Маг', launch: { gcPath: '', gcIds: [], gcAccounts: {} } },
    { id: 'b', nick: 'Бета', class: 'Воин', launch: { gcPath: 'D:\\own', gcIds: [], gcAccounts: {} } }
  ];
});

describe('окно «GameCenter и персонажи»', () => {
  it('показывает GameCenter, персонажей и подсказку про перенос путей из карточек', async () => {
    openGameCentersModal();
    await tick();
    const html = document.getElementById('gcm-root').innerHTML;
    expect(html).toContain('Папка 1');
    expect(html).toContain('Папка 2');
    expect(html).toContain('Альфа');
    expect(document.getElementById('gcm-import').hidden).toBe(false); // у «Бета» есть свой путь
    expect(document.querySelector('.gcm-gc-who').textContent).toContain('Twin'); // кто сейчас вошёл
    expect(gcSummaryText()).toBe('GameCenter в списке: 2 · персонажей готово к запуску: 1 из 2');
  });

  it('прикрепление GameCenter к персонажу сохраняется, можно прикрепить второй', async () => {
    openGameCentersModal();
    const sel = document.querySelector('[data-char="a"] select[data-act="attach"]');
    sel.value = 'gc-2';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(state.characters[0].launch.gcIds).toEqual(['gc-2']);
    expect(persistMock).toHaveBeenCalled();
    const sel2 = document.querySelector('[data-char="a"] select[data-act="attach"]');
    expect([...sel2.options].map(o => o.value)).toEqual(['', 'gc-1']); // уже прикреплённый не предлагается
    sel2.value = 'gc-1';
    sel2.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(state.characters[0].launch.gcIds).toEqual(['gc-2', 'gc-1']);
    expect(document.querySelector('[data-char="a"] .gcm-badge').textContent).toBe('основной');
  });

  it('«Запомнить вход» привязывает аккаунт к выбранному GameCenter персонажа', async () => {
    state.characters[0].launch.gcIds = ['gc-1', 'gc-2'];
    openGameCentersModal();
    document.querySelector('[data-char="a"] .gcm-bind[data-gc="gc-2"] [data-act="cap"]').click();
    await until(() => called('launcher_capture_account') && state.characters[0].launch.gcAccounts['gc-2']);
    expect(invokeMock.mock.calls.map(c => [c[0], c[1]])).toContainEqual(['launcher_capture_account', { charId: 'a@gc-2', path: GC2.path }]);
    expect(state.characters[0].launch.gcAccounts).toEqual({ 'gc-2': { nick: 'Twin' } });
    expect(document.querySelector('[data-char="a"] .gcm-acc.is-saved').textContent).toContain('Twin');
  });

  it('«Добавить GameCenter» открывает проводник и добавляет запись с названием по папке', async () => {
    openGameCentersModal();
    document.querySelector('[data-act="gc-add"]').click();
    await until(() => state.settings.launcher.gameCenters.length === 3);
    const list = state.settings.launcher.gameCenters;
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({ name: 'GC3', path: 'D:\\GC3\\GameCenter.exe' });
    // повторный выбор того же файла не создаёт дубль
    document.querySelector('[data-act="gc-add"]').click();
    await until(() => invokeMock.mock.calls.filter(c => c[0] === 'launcher_pick_gamecenter').length === 2);
    await tick(); await tick();
    expect(state.settings.launcher.gameCenters).toHaveLength(3);
  });

  it('переименование, выбор «в первую очередь» и перенос путей сохраняются', async () => {
    openGameCentersModal();
    const name = document.querySelector('.gcm-gc[data-gc="gc-2"] input');
    name.value = '  Вторая папка ';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(state.settings.launcher.gameCenters[1].name).toBe('Вторая папка');
    const pref = document.getElementById('gcm-pref');
    pref.value = 'gc-2';
    pref.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(state.settings.launcher.preferredGcId).toBe('gc-2');
    document.querySelector('[data-act="import"]').click();
    await until(() => state.characters[1].launch.gcIds.length === 1);
    expect(state.characters[1].launch.gcIds).toHaveLength(1);
    expect(state.settings.launcher.gameCenters).toHaveLength(3);
  });

  it('удаление GameCenter открепляет его и чистит сохранённые входы', async () => {
    state.characters[0].launch.gcIds = ['gc-1'];
    state.characters[0].launch.gcAccounts = { 'gc-1': { nick: 'Twin' } };
    openGameCentersModal();
    document.querySelector('.gcm-gc[data-gc="gc-1"] [data-act="gc-del"]').click();
    await until(() => called('launcher_forget_account') && state.characters[0].launch.gcIds.length === 0);
    expect(state.settings.launcher.gameCenters.map(g => g.id)).toEqual(['gc-2']);
    expect(state.characters[0].launch.gcIds).toEqual([]);
    expect(invokeMock.mock.calls.map(c => [c[0], c[1]])).toContainEqual(['launcher_forget_account', { charId: 'a@gc-1' }]);
  });
});
