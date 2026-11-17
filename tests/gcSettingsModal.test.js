import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

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
const called = cmd => invokeMock.mock.calls.some(c => c[0] === cmd);
const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const GC2 = { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' };

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  // и мок модуля, и «настоящий» @tauri-apps/api/core (через window.__TAURI_INTERNALS__) ведут в один и тот же invokeMock
  window.__TAURI_INTERNALS__ = { invoke: (...a) => invokeMock(...a) };
  invokeMock.mockReset();
  persistMock.mockClear();
  invokeMock.mockImplementation(async (cmd, args) => {
    if (cmd === 'launcher_gc_info')
      return {
        exe: 'x',
        nick: 'Twin',
        loggedIn: true,
        login: 'dissolute77@mail.ru'
      };
    if (cmd === 'launcher_saved_game_accounts') {
      const [charId, gcId] = args.charId.split('@');
      const char = state.characters.find(item => item.id === charId);
      if (char?.launch?.gcAccounts?.[gcId])
        return [
          { id: '49635696', name: 'WheeIman' },
          { id: '59424880', name: 'hotdevilcom' }
        ];
    }
    if (cmd === 'launcher_pick_gamecenter') return 'D:\\GC3\\GameCenter.exe';
    if (cmd === 'launcher_capture_account') return { ok: true, nick: 'Twin', steps: ['Готово: вход запомнен'] };
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
  it('keeps long launcher names, paths and account status in separate named grid areas', async () => {
    const name = 'Тестовый GameCenter с длинным названием';
    const path = `C:\\${'Очень длинная папка\\'.repeat(15)}GameCenter.exe`;
    state.settings.launcher.gameCenters = [{ ...GC1, name, path }];
    invokeMock.mockImplementation(async () => ({ nick: 'Длинное имя аккаунта '.repeat(10), loggedIn: true }));
    openGameCentersModal();
    await tick();
    expect(document.querySelector('.gcm-gc-name').value).toBe(name);
    expect(document.querySelector('.gcm-gc-path').getAttribute('title')).toBe(path);
    await until(() => document.querySelector('.gcm-gc-who')?.getAttribute('title')?.includes('Длинное имя аккаунта'));
    expect(document.querySelector('.gcm-gc-who').getAttribute('title')).toContain('Длинное имя аккаунта');
    const css = readFileSync('css/modules/launcher.css', 'utf8');
    expect(css).toContain("'icon kind name actions'");
    expect(css).toContain("'. path path path'");
    expect(css).toContain("'. account account account'");
    expect(css).toContain("'name name'");
    for (const area of ['icon', 'kind', 'name', 'path', 'account', 'actions']) {
      expect(css).toContain(`grid-area: ${area};`);
    }
  });

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

  it('разделяет игровые аккаунты по сохранённому VK Play-входу привязки', async () => {
    const accountsA = [
      { id: 'a-1', name: 'Альфа 1' },
      { id: 'a-2', name: 'Альфа 2' }
    ];
    const accountsB = [
      { id: 'b-1', name: 'Бета 1' },
      { id: 'b-2', name: 'Бета 2' }
    ];
    for (const char of state.characters) {
      char.launch.gcIds = ['gc-1'];
      char.launch.gcAccounts['gc-1'] = { nick: char.id };
    }
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'launcher_gc_info') return { nick: 'Twin', loggedIn: true };
      if (cmd === 'launcher_saved_game_accounts') return args.charId === 'a@gc-1' ? accountsA : accountsB;
      return null;
    });

    openGameCentersModal();
    await until(() => document.querySelectorAll('[data-act="game-acc"]').length === 2);

    const values = charId =>
      [...document.querySelectorAll(`[data-char="${charId}"] [data-act="game-acc"] option`)].map(
        option => option.value
      );
    const names = charId =>
      [...document.querySelectorAll(`[data-char="${charId}"] [data-act="game-acc"] option`)].map(
        option => option.textContent
      );
    expect(values('a')).toEqual(['', 'a-1', 'a-2']);
    expect(names('a')).toEqual(['Выбрать вручную при запуске', 'Альфа 1', 'Альфа 2']);
    expect(values('b')).toEqual(['', 'b-1', 'b-2']);
    expect(names('b')).toEqual(['Выбрать вручную при запуске', 'Бета 1', 'Бета 2']);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'launcher_saved_game_accounts').map(([, args]) => args.charId)
    ).toEqual(expect.arrayContaining(['a@gc-1', 'b@gc-1']));
    const row = document.querySelector('[data-char="a"] .gcm-bind[data-gc="gc-1"]');
    expect(row.querySelector('.gcm-gameacc-title').textContent).toBe('Игровой аккаунт для запуска');
    expect(row.querySelector('.gcm-gameacc small').textContent).toContain('выберете вручную');
    expect(row.querySelector('.gcm-bind-actions [data-act="cap"]')).not.toBeNull();
    const css = readFileSync('css/modules/launcher.css', 'utf8');
    const actionRules = css.match(/\.gcm-bind-actions\s*\{([^}]+)\}/)?.[1] || '';
    expect(actionRules).toContain('flex-wrap: nowrap;');
  });

  it('фильтрует персонажей, которым ещё нужно выбрать один из игровых аккаунтов', async () => {
    const accountsA = [
      { id: 'a-1', name: 'Альфа 1' },
      { id: 'a-2', name: 'Альфа 2' }
    ];
    const accountsB = [
      { id: 'b-1', name: 'Бета 1' },
      { id: 'b-2', name: 'Бета 2' }
    ];
    for (const char of state.characters) {
      char.launch.gcIds = ['gc-1'];
      char.launch.gcAccounts['gc-1'] = { nick: 'Twin' };
    }
    state.characters[0].launch.gcGameAccounts = { 'gc-1': accountsA[0] };
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'launcher_gc_info') return { nick: 'Twin', loggedIn: true };
      if (cmd === 'launcher_saved_game_accounts') return args.charId === 'a@gc-1' ? accountsA : accountsB;
      return null;
    });

    openGameCentersModal();
    await until(() => document.querySelectorAll('[data-act="game-acc"]').length === 2);
    expect(document.querySelectorAll('.gcm-char')).toHaveLength(2);

    const filter = document.getElementById('gcm-account-needed');
    filter.checked = true;
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    expect([...document.querySelectorAll('.gcm-char')].map(char => char.getAttribute('data-char'))).toEqual(['b']);
    expect(document.getElementById('gcm-shown').textContent).toBe('Показано: 1 из 2');
  });

  it('не показывает выбор, если для сохранённого входа остался один игровой персонаж', async () => {
    state.characters[0].launch.gcIds = ['gc-1'];
    state.characters[0].launch.gcAccounts['gc-1'] = { nick: 'Twin' };
    let accountsLoaded = false;
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'launcher_gc_info') return { nick: 'Twin', loggedIn: true };
      if (cmd === 'launcher_saved_game_accounts' && args.charId === 'a@gc-1') {
        await new Promise(resolve => setTimeout(resolve, 0));
        accountsLoaded = true;
        return [{ id: 'only-one', name: 'Единственный' }];
      }
      return null;
    });

    openGameCentersModal();
    await until(() => accountsLoaded);
    expect(document.querySelector('[data-char="a"] [data-act="game-acc"]')).toBeNull();
  });

  it('выбор игрового аккаунта окна «Выбор игрового аккаунта» сохраняется', async () => {
    state.characters[0].launch.gcIds = ['gc-1'];
    state.characters[0].launch.gcAccounts['gc-1'] = { nick: 'Twin' };
    openGameCentersModal();
    await until(() => document.querySelector('[data-char="a"] select[data-act="game-acc"]'));
    const sel = document.querySelector('[data-char="a"] select[data-act="game-acc"]');
    // Пока список не пришёл из launcher_gc_info, выбора нет; после ответа — оба аккаунта
    expect([...sel.options].map(o => o.value)).toEqual(['', '49635696', '59424880']);
    expect([...sel.options].map(o => o.textContent)).toEqual([
      'Выбрать вручную при запуске',
      'WheeIman',
      'hotdevilcom'
    ]);
    sel.value = '59424880';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(state.characters[0].launch.gcGameAccounts).toEqual({ 'gc-1': { id: '59424880', name: 'hotdevilcom' } });
    expect(persistMock).toHaveBeenCalled();
    // Пустое значение — снова «не выбирать автоматически»
    const sel2 = document.querySelector('[data-char="a"] select[data-act="game-acc"]');
    expect(sel2.value).toBe('59424880');
    sel2.value = '';
    sel2.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(state.characters[0].launch.gcGameAccounts).toEqual({});
  });

  it('«Запомнить вход» привязывает аккаунт к выбранному GameCenter персонажа', async () => {
    state.characters[0].launch.gcIds = ['gc-1', 'gc-2'];
    state.characters[0].launch.gcGameAccounts = { 'gc-2': { id: '59424880', name: 'hotdevilcom' } };
    openGameCentersModal();
    document.querySelector('[data-char="a"] .gcm-bind[data-gc="gc-2"] [data-act="cap"]').click();
    await until(() => called('launcher_capture_account') && state.characters[0].launch.gcAccounts['gc-2']);
    expect(invokeMock.mock.calls.map(c => [c[0], c[1]])).toContainEqual([
      'launcher_capture_account',
      { charId: 'a@gc-2', path: GC2.path }
    ]);
    expect(state.characters[0].launch.gcAccounts).toEqual({ 'gc-2': { nick: 'Twin' } });
    expect(state.characters[0].launch.gcGameAccounts).toEqual({}); // новый сохранённый вход не наследует выбор старого
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
    await tick();
    await tick();
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
    expect(invokeMock.mock.calls.map(c => [c[0], c[1]])).toContainEqual([
      'launcher_forget_account',
      { charId: 'a@gc-1' }
    ]);
  });
});
