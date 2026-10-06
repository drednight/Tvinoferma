import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Логика автообновления (issue #70): без всплывающих окон, общее состояние, прогресс, повтор при ошибке.

const checkMock = vi.fn();
const relaunchMock = vi.fn();
const toastMock = vi.fn();
const saveNowMock = vi.fn();
const createBackupMock = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({ check: (...a) => checkMock(...a) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: (...a) => relaunchMock(...a) }));
vi.mock('../js/core/ui.js', () => ({ toast: (...a) => toastMock(...a) }));
vi.mock('../js/core/storage.js', () => ({ saveNow: (...a) => saveNowMock(...a), createBackup: (...a) => createBackupMock(...a) }));

const fakeUpdate = (over = {}) => ({
  version: '0.3.0',
  currentVersion: '0.2.0',
  body: '- новая кнопка\n- исправления',
  downloadAndInstall: vi.fn(async (cb) => {
    cb({ event: 'Started', data: { contentLength: 200 } });
    cb({ event: 'Progress', data: { chunkLength: 100 } });
    cb({ event: 'Progress', data: { chunkLength: 100 } });
    cb({ event: 'Finished' });
  }),
  ...over
});

let mod, state, ui;
const load = async () => {
  vi.resetModules();
  state = await import('../js/desktop/updateState.js');
  mod = await import('../js/desktop/updater.js');
  ui = await import('../js/desktop/updateUi.js');
};

describe('updateState: подписи и признаки', () => {
  beforeEach(load);

  it('hasUpdate/isBusy зависят от статуса', () => {
    expect(state.hasUpdate({ status: 'idle', version: null })).toBe(false);
    expect(state.hasUpdate({ status: 'uptodate', version: null })).toBe(false);
    expect(state.hasUpdate({ status: 'check_error', version: '0.3.0' })).toBe(false);
    expect(state.hasUpdate({ status: 'available', version: '0.3.0' })).toBe(true);
    expect(state.hasUpdate({ status: 'error', version: '0.3.0' })).toBe(true);
    expect(state.isBusy({ status: 'downloading' })).toBe(true);
    expect(state.isBusy({ status: 'available' })).toBe(false);
  });

  it('подписи кнопок', () => {
    expect(state.badgeLabel({ status: 'available', version: '0.3.0' })).toBe('⬆️ Доступно обновление v0.3.0');
    expect(state.badgeLabel({ status: 'downloading', version: '0.3.0', progress: 42 })).toContain('42%');
    expect(state.badgeLabel({ status: 'error', version: '0.3.0' })).toContain('повторить');
    expect(state.installButtonLabel({ status: 'available', version: '0.3.0' })).toBe('⬆️ Обновить до v0.3.0');
    expect(state.installButtonLabel({ status: 'downloading', progress: 7 })).toBe('Загрузка 7%');
    expect(state.formatVersion('v1.0.0')).toBe('v1.0.0');
  });

  it('время последней проверки и статус вне Tauri', () => {
    expect(state.checkedAtText({ lastCheckedAt: null })).toBe('');
    expect(state.checkedAtText({ lastCheckedAt: new Date().toISOString() })).toMatch(/^Последняя проверка:/);
    expect(state.statusText({ status: 'idle' }, { supported: false })).toMatch(/только в установленном/);
  });

  it('подписчик получает текущее значение сразу и обновления потом', () => {
    const seen = [];
    const off = state.subscribeUpdate((s) => seen.push(s.status));
    state.setUpdateState({ status: 'checking' });
    off();
    state.setUpdateState({ status: 'uptodate' });
    expect(seen).toEqual(['idle', 'checking']);
  });
});

describe('updater: проверка и установка', () => {
  let confirmSpy;
  beforeEach(async () => {
    checkMock.mockReset(); relaunchMock.mockReset(); toastMock.mockReset(); saveNowMock.mockReset(); createBackupMock.mockReset();
    window.__TAURI_INTERNALS__ = {};
    confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    document.body.innerHTML = '';
    await load();
  });
  afterEach(() => { delete window.__TAURI_INTERNALS__; confirmSpy.mockRestore(); vi.useRealTimers(); });

  it('нет обновления → uptodate; тост только при ручной проверке', async () => {
    checkMock.mockResolvedValue(null);
    await mod.checkForUpdates({ silent: true });
    expect(state.getUpdateState().status).toBe('uptodate');
    expect(state.getUpdateState().lastCheckedAt).toBeTruthy();
    expect(toastMock).not.toHaveBeenCalled();
    await mod.checkForUpdates();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('тихая проверка находит обновление: состояние available, без тостов и диалогов', async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    await mod.checkForUpdates({ silent: true });
    const s = state.getUpdateState();
    expect(s).toMatchObject({ status: 'available', version: '0.3.0', currentVersion: '0.2.0' });
    expect(s.notes).toContain('новая кнопка');
    expect(toastMock).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('ручная проверка при найденном обновлении: тост, но не подтверждение', async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    await mod.checkForUpdates();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('ошибка тихой проверки не показывает тост и не создаёт кнопку', async () => {
    checkMock.mockRejectedValue(new Error('offline'));
    await mod.checkForUpdates({ silent: true });
    expect(toastMock).not.toHaveBeenCalled();
    expect(state.getUpdateState().status).toBe('check_error');
    expect(state.hasUpdate()).toBe(false);
  });

  it('ошибка повторной проверки не убирает уже найденное обновление', async () => {
    checkMock.mockResolvedValueOnce(fakeUpdate());
    await mod.checkForUpdates({ silent: true });
    checkMock.mockRejectedValueOnce(new Error('offline'));
    await mod.checkForUpdates({ silent: true });
    expect(state.getUpdateState().status).toBe('available');
    expect(state.hasUpdate()).toBe(true);
  });

  it('установка: прогресс в процентах, saveNow и relaunch', async () => {
    const upd = fakeUpdate();
    checkMock.mockResolvedValue(upd);
    await mod.checkForUpdates({ silent: true });
    const progress = [];
    state.subscribeUpdate((s) => progress.push(`${s.status}:${s.progress}`));
    const ok = await mod.installUpdate();
    expect(ok).toBe(true);
    expect(progress).toContain('downloading:0');
    expect(progress).toContain('downloading:50');
    expect(progress).toContain('installing:100');
    // saveNow дважды: перед копией и перед перезапуском
    expect(saveNowMock).toHaveBeenCalledTimes(2);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(saveNowMock.mock.invocationCallOrder[1]).toBeLessThan(relaunchMock.mock.invocationCallOrder[0]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('перед установкой делается резервная копия с версиями в имени', async () => {
    const upd = fakeUpdate();
    checkMock.mockResolvedValue(upd);
    await mod.checkForUpdates({ silent: true });
    await mod.installUpdate();
    expect(createBackupMock).toHaveBeenCalledWith('pre-update-v0.2.0-to-v0.3.0');
    expect(createBackupMock.mock.invocationCallOrder[0]).toBeLessThan(upd.downloadAndInstall.mock.invocationCallOrder[0]);
  });

  it('сбой резервной копии не блокирует установку', async () => {
    createBackupMock.mockRejectedValue(new Error('disk full'));
    const upd = fakeUpdate();
    checkMock.mockResolvedValue(upd);
    await mod.checkForUpdates({ silent: true });
    expect(await mod.installUpdate()).toBe(true);
    expect(upd.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it('без найденного обновления installUpdate ничего не делает', async () => {
    expect(await mod.installUpdate()).toBe(false);
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it('ошибка установки: статус error, версия сохраняется, повтор работает', async () => {
    const upd = fakeUpdate();
    upd.downloadAndInstall.mockRejectedValueOnce(new Error('network'));
    checkMock.mockResolvedValue(upd);
    await mod.checkForUpdates({ silent: true });
    expect(await mod.installUpdate()).toBe(false);
    expect(state.getUpdateState()).toMatchObject({ status: 'error', version: '0.3.0', error: 'network' });
    expect(state.hasUpdate()).toBe(true);
    expect(relaunchMock).not.toHaveBeenCalled();
    // повтор
    upd.downloadAndInstall.mockImplementation(async (cb) => { cb({ event: 'Finished' }); });
    expect(await mod.installUpdate()).toBe(true);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it('планировщик, режим startup: одна проверка через 5 с, дальше тишина', async () => {
    vi.useFakeTimers();
    checkMock.mockResolvedValue(null);
    mod.startUpdateScheduler({ getMode: () => 'startup', getLastChecked: () => null });
    await vi.advanceTimersByTimeAsync(mod.FIRST_CHECK_DELAY_MS - 1);
    expect(checkMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(1);
    mod.stopUpdateScheduler();
  });

  it('планировщик, режим never: ничего не проверяет', async () => {
    vi.useFakeTimers();
    mod.startUpdateScheduler({ getMode: () => 'never', getLastChecked: () => null });
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
    expect(checkMock).not.toHaveBeenCalled();
    mod.stopUpdateScheduler();
  });

  it('планировщик, режим daily: догоняет пропущенное при запуске и срабатывает в полночь', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 23, 50, 0));
    let last = new Date(2026, 9, 6, 12, 0, 0).toISOString();   // вчера — срок пропущен
    checkMock.mockImplementation(async () => { last = new Date().toISOString(); return null; });
    mod.startUpdateScheduler({ getMode: () => 'daily', getLastChecked: () => last });
    await vi.advanceTimersByTimeAsync(mod.FIRST_CHECK_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);          // надогнали
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);    // все ещё до полуночи
    expect(checkMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);    // перешли в 00:00
    expect(checkMock).toHaveBeenCalledTimes(2);
    mod.stopUpdateScheduler();
  });

  it('вне Tauri проверка ничего не делает', async () => {
    delete window.__TAURI_INTERNALS__;
    await mod.checkForUpdates();
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe('updateUi: кнопка в шапке и окно', () => {
  beforeEach(async () => {
    window.__TAURI_INTERNALS__ = {};
    document.body.innerHTML = `
      <div id="modal-root"></div>
      <button id="update-badge" hidden></button>
      <div id="update-status"></div><div id="update-checked-at"></div>
      <button id="install-update-btn" hidden></button>
      <button id="check-updates-btn">Проверить обновления</button>`;
    installMocks();
    await load();
    ui.initUpdateUi();
  });
  afterEach(() => { delete window.__TAURI_INTERNALS__; document.body.innerHTML = ''; });
  function installMocks() { checkMock.mockReset(); relaunchMock.mockReset(); }

  it('кнопка скрыта, пока обновления нет', () => {
    expect(document.getElementById('update-badge').hidden).toBe(true);
    expect(document.getElementById('install-update-btn').hidden).toBe(true);
  });

  it('при найденной версии показывается кнопка; клик открывает окно, «Позже» оставляет кнопку', () => {
    state.setUpdateState({ status: 'available', version: '0.3.0', currentVersion: '0.2.0', notes: '- пункт' });
    const badge = document.getElementById('update-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('⬆️ Доступно обновление v0.3.0');
    expect(document.getElementById('install-update-btn').textContent).toBe('⬆️ Обновить до v0.3.0');

    badge.click();
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('v0.2.0');
    expect(overlay.textContent).toContain('v0.3.0');
    expect(overlay.textContent).toContain('- пункт');
    expect(overlay.textContent).toContain('Установить и перезапустить');

    overlay.querySelector('[data-later]').click();
    expect(document.querySelector('.modal-overlay')).toBeNull();
    expect(badge.hidden).toBe(false);
  });

  it('прогресс загрузки виден на кнопке и в окне', () => {
    state.setUpdateState({ status: 'available', version: '0.3.0', currentVersion: '0.2.0' });
    document.getElementById('update-badge').click();
    state.setUpdateState({ status: 'downloading', progress: 35 });
    expect(document.getElementById('update-badge').textContent).toContain('35%');
    expect(document.querySelector('.modal-overlay').textContent).toContain('Загрузка 35%');
    expect(document.querySelector('[data-install]').disabled).toBe(true);
  });

  it('после ошибки в окне появляется «Повторить»', () => {
    state.setUpdateState({ status: 'error', version: '0.3.0', currentVersion: '0.2.0', error: 'network' });
    document.getElementById('update-badge').click();
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay.textContent).toContain('network');
    expect(overlay.querySelector('[data-install]').textContent).toBe('Повторить');
  });

  it('кнопка «Проверить обновления» запускает проверку без подтверждения', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    checkMock.mockResolvedValue(null);
    document.getElementById('check-updates-btn').click();
    await vi.waitFor(() => expect(checkMock).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
