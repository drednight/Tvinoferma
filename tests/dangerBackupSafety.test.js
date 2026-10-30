import { beforeEach, describe, expect, it, vi } from 'vitest';

// Реальная кнопка настроек: отказ копии не должен превращаться в удаление.
const mocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  saveNow: vi.fn(),
  createBackup: vi.fn(),
  forceRenderAndPersist: vi.fn(),
  isTauri: vi.fn(),
  confirmModal: vi.fn(),
  toast: vi.fn(),
  forgetAccount: vi.fn()
}));

vi.mock('../js/core/storage.js', async importOriginal => ({
  ...(await importOriginal()),
  getAdapter: mocks.getAdapter,
  saveNow: mocks.saveNow,
  createBackup: mocks.createBackup,
  forceRenderAndPersist: mocks.forceRenderAndPersist,
  isTauri: mocks.isTauri
}));
vi.mock('../js/core/ui.js', async importOriginal => ({
  ...(await importOriginal()),
  confirmModal: mocks.confirmModal,
  toast: mocks.toast
}));
vi.mock('../js/modules/launcher/launch.js', async importOriginal => ({
  ...(await importOriginal()),
  forgetAccount: mocks.forgetAccount
}));

let state;

async function click(kind) {
  document.querySelector(`[data-danger="${kind}"]`).click();
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
}

function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.getAdapter.mockReturnValue({});
  mocks.saveNow.mockResolvedValue(undefined);
  mocks.createBackup.mockResolvedValue('verified-backup');
  mocks.forceRenderAndPersist.mockResolvedValue(undefined);
  mocks.isTauri.mockReturnValue(false);
  mocks.confirmModal.mockResolvedValue(true);
  mocks.forgetAccount.mockResolvedValue(null);
  document.body.innerHTML = `
    <div id="danger-zone">
      <button data-danger="parties">Пати</button>
      <button data-danger="marathons">Марафоны</button>
      <button data-danger="characters">Персонажи</button>
      <button id="factory-reset-btn">Сброс</button>
    </div>`;
  ({ state } = await import('../js/core/state.js'));
  state.parties = [{ id: 'p' }];
  state.marathons = [{ id: 'm' }];
  state.characters = [{ id: 'c', partyIds: ['p'], launch: { gcAccount: true } }];
  const { bindSettings } = await import('../js/settings/settings.js');
  bindSettings();
});

describe('массовое удаление требует подтверждённой копии', () => {
  it('не удаляет, если адаптер недоступен', async () => {
    mocks.getAdapter.mockReturnValue(null);
    await click('parties');
    expect(state.parties).toHaveLength(1);
    expect(mocks.saveNow).not.toHaveBeenCalled();
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Удаление остановлено'), 'error', 60000);
  });

  it('не удаляет и не создаёт копию, если сохранение не подтверждено', async () => {
    mocks.saveNow.mockRejectedValue(new Error('sensitive/path'));
    await click('marathons');
    expect(state.marathons).toHaveLength(1);
    expect(mocks.createBackup).not.toHaveBeenCalled();
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('sensitive/path');
  });

  it('не удаляет, если создание копии завершилось ошибкой', async () => {
    mocks.createBackup.mockRejectedValue(new Error('sensitive/backup'));
    await click('characters');
    expect(state.characters).toHaveLength(1);
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
    expect(mocks.forgetAccount).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('sensitive/backup');
  });

  it.each([undefined, null, false, {}, '', '   '])('не удаляет при неверном ответе копии: %s', async reply => {
    mocks.createBackup.mockResolvedValue(reply);
    await click('parties');
    expect(state.parties).toHaveLength(1);
    expect(state.characters[0].partyIds).toEqual(['p']);
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
  });

  it('не удаляет, если данные изменились во время подтверждения', async () => {
    const pending = deferred();
    mocks.confirmModal.mockReturnValueOnce(pending.promise);
    document.querySelector('[data-danger="parties"]').click();
    await vi.waitFor(() => expect(mocks.confirmModal).toHaveBeenCalledOnce());
    state.parties.push({ id: 'new-party' });
    pending.resolve(true);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('изменились'), 'warning', 60000)
    );
    expect(state.parties).toHaveLength(2);
    expect(mocks.saveNow).not.toHaveBeenCalled();
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
  });

  it('не создаёт копию и не удаляет при изменении во время сохранения', async () => {
    const pending = deferred();
    mocks.saveNow.mockReturnValueOnce(pending.promise);
    document.querySelector('[data-danger="parties"]').click();
    await vi.waitFor(() => expect(mocks.saveNow).toHaveBeenCalledOnce());
    state.characters[0].partyIds.push('other');
    pending.resolve();
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('изменились'), 'warning', 60000)
    );
    expect(state.parties).toHaveLength(1);
    expect(mocks.createBackup).not.toHaveBeenCalled();
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
  });

  it('не удаляет при изменении во время создания копии', async () => {
    const pending = deferred();
    mocks.createBackup.mockReturnValueOnce(pending.promise);
    document.querySelector('[data-danger="characters"]').click();
    await vi.waitFor(() => expect(mocks.createBackup).toHaveBeenCalledOnce());
    state.characters.push({ id: 'new-character' });
    pending.resolve('verified-backup');
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('изменились'), 'warning', 60000)
    );
    expect(state.characters).toHaveLength(2);
    expect(mocks.forgetAccount).not.toHaveBeenCalled();
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
  });

  it('не считает изменением данных обычное переключение интерфейса', async () => {
    const pending = deferred();
    mocks.confirmModal.mockReturnValueOnce(pending.promise);
    document.querySelector('[data-danger="parties"]').click();
    await vi.waitFor(() => expect(mocks.confirmModal).toHaveBeenCalledOnce());
    state.ui.activeTab = 'settings';
    pending.resolve(true);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Удалено'), 'success'));
    expect(state.parties).toHaveLength(0);
  });

  it.each(['parties', 'factory-reset-btn'])(
    'не начинает второе опасное действие во время подтверждения: %s',
    async next => {
      const pending = deferred();
      mocks.confirmModal.mockReturnValueOnce(pending.promise);
      document.querySelector('[data-danger="marathons"]').click();
      await vi.waitFor(() => expect(mocks.confirmModal).toHaveBeenCalledOnce());
      document.querySelector(next === 'parties' ? '[data-danger="parties"]' : '#factory-reset-btn').click();
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Другое опасное действие'), 'warning');
      expect(mocks.confirmModal).toHaveBeenCalledOnce();
      pending.resolve(false);
      expect(mocks.saveNow).not.toHaveBeenCalled();
    }
  );

  it('не начинает массовое удаление во время подтверждения сброса', async () => {
    const pending = deferred();
    mocks.confirmModal.mockReturnValueOnce(pending.promise);
    document.querySelector('#factory-reset-btn').click();
    await vi.waitFor(() => expect(mocks.confirmModal).toHaveBeenCalledOnce());
    document.querySelector('[data-danger="parties"]').click();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Другое опасное действие'), 'warning');
    expect(mocks.confirmModal).toHaveBeenCalledOnce();
    pending.resolve(false);
    expect(mocks.saveNow).not.toHaveBeenCalled();
  });

  it('удаляет пати только после сохранения и подтверждённой копии', async () => {
    await click('parties');
    expect(mocks.saveNow.mock.invocationCallOrder[0]).toBeLessThan(mocks.createBackup.mock.invocationCallOrder[0]);
    expect(mocks.createBackup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forceRenderAndPersist.mock.invocationCallOrder[0]
    );
    expect(state.parties).toEqual([]);
    expect(state.characters[0].partyIds).toEqual([]);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Удалено'), 'success');
  });

  it('предупреждает, что копия персонажей не содержит отдельное хранилище ОС', async () => {
    await click('characters');
    const text = mocks.confirmModal.mock.calls[0][0].text;
    expect(text).toContain('Копия состояния не содержит контакты из хранилища ОС');
    expect(text).toContain('входы GameCenter');
    expect(text).toContain('восстановить их из этой копии нельзя');
  });

  it.each([new Error('private error'), true])('не заявляет успех при неподтверждённом удалении входа', async result => {
    mocks.isTauri.mockReturnValue(true);
    if (result instanceof Error) mocks.forgetAccount.mockRejectedValue(result);
    else mocks.forgetAccount.mockResolvedValue(result);
    await click('characters');
    expect(mocks.forgetAccount).toHaveBeenCalledWith('c');
    expect(state.characters).toEqual([]);
    expect(mocks.forceRenderAndPersist).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('не подтверждено'), 'warning', 60000);
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('private error');
  });

  it('предупреждает и останавливает запись и восстановление при частичном результате', async () => {
    mocks.forceRenderAndPersist.mockRejectedValue(new Error('private content'));
    const events = [];
    const listener = event => events.push(event.detail);
    window.addEventListener('tf-storage-uncertain', listener);
    try {
      await click('parties');
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('может быть частичным'), 'error', 60000);
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('private content');
      expect(events).toEqual([{ source: 'state' }]);
      const storage = await import('../js/core/storage.js');
      await expect(storage.persist()).rejects.toThrow('Запись остановлена');
      await expect(storage.restoreStoredBackup('backup')).rejects.toThrow('Запись остановлена');
    } finally {
      window.removeEventListener('tf-storage-uncertain', listener);
    }
  });

  it('не начинает изменение данных, если запись уже заблокирована', async () => {
    const storage = await import('../js/core/storage.js');
    storage.haltAfterPartialStateChange();
    await click('parties');
    expect(state.parties).toHaveLength(1);
    expect(mocks.forceRenderAndPersist).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('сохранение недоступно'), 'error', 60000);
  });
});
