// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindInitialCloudPanel } from '../js/modules/cloudSync/ui/initialCloudPanel.js';
import { bindCloudReviewPanel } from '../js/modules/cloudSync/ui/cloudReviewPanel.js';

const html = readFileSync('index.html', 'utf8');
const byId = id => document.getElementById(id);
const click = id => byId(id).click();
const set = (id, value) => {
  byId(id).value = value;
};
const change = (id, value) => {
  set(id, value);
  byId(id).dispatchEvent(new Event('change', { bubbles: true }));
};
const pin = { versionId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) };
function review(provider = 'yandex') {
  return {
    status: 'ready_for_review',
    provider,
    checkedAt: '2026-10-30T10:00:00.000Z',
    localSavedAt: null,
    versions: [{ pin, modifiedAt: null, observedHead: true }],
    compare: () => ({
      pin,
      cloudModifiedAt: null,
      cloudRecord: () => ({ fields: { notes: 'Тестовая запись' } }),
      differences: {
        entries: [
          {
            section: 'characters',
            kind: 'only_cloud',
            type: 'character',
            id: '22222222-2222-4222-8222-222222222222',
            label: 'Тест',
            changes: []
          }
        ],
        uncomparedSettings: []
      }
    })
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(extra = {}) {
  const commit = vi.fn(async () => ({ status: 'applied', backup: 'state.backup-apply.json' }));
  const stage = vi.fn(() => ({ commit, cancel: vi.fn() }));
  const reviewPanel = bindCloudReviewPanel({
    desktop: extra.desktop !== false,
    stage,
    confirm: () => true,
    loadNative: async () => ({ invoke: vi.fn() })
  });
  const confirmBackup = vi.fn(async () => ({
    status: 'prepared',
    backup: 'state.backup-test.json',
    pairingCode: 'TEST-PAIRING-CODE'
  }));
  const cancel = vi.fn();
  const begin = vi.fn(async () => ({
    status: 'prepared',
    generatedBackupSecret: 'TFB1-saved-secret',
    confirmBackup,
    cancel
  }));
  const resume = vi.fn(async () => ({
    status: 'prepared',
    backup: 'state.backup-resume.json',
    pairingCode: 'TEST-PAIRING-CODE'
  }));
  const makeSetup = vi.fn(() => ({ begin, resume }));
  const recoveryCancel = vi.fn();
  const connect = vi.fn(async () => ({ status: 'connected', backup: 'state.backup-recovery.json', review: review() }));
  const recoveryBegin = vi.fn(async () => ({
    status: 'ready_for_confirmation',
    backup: 'state.backup-recovery.json',
    review: review(),
    cancel: recoveryCancel,
    connect
  }));
  const makeRecovery = vi.fn(() => ({ begin: recoveryBegin }));
  const send = vi.fn(async () => ({ status: 'sent_verified' }));
  const readCode = vi.fn(async () => ({ status: 'ready', pairingCode: 'TEST-PAIRING-CODE' }));
  const inspectSend = vi.fn(async () => ({ status: 'local_send_ready' }));
  const confirm = vi.fn(() => true);
  const invoke = vi.fn();
  bindInitialCloudPanel({
    desktop: extra.desktop !== false,
    prepareData: vi.fn(async () => true),
    loadNative: async () => ({ invoke }),
    makeSetup,
    makeRecovery,
    send,
    readCode,
    inspectSend,
    confirm,
    reviewPanel,
    ...extra
  });
  return {
    commit,
    stage,
    begin,
    resume,
    makeSetup,
    confirmBackup,
    cancel,
    makeRecovery,
    recoveryBegin,
    recoveryCancel,
    connect,
    send,
    readCode,
    inspectSend,
    confirm,
    invoke,
    reviewPanel
  };
}
function prepareInput() {
  set('cloud-setup-main', 'a strong passphrase');
  set('cloud-setup-main-repeat', 'a strong passphrase');
  byId('cloud-setup-new-approve').checked = true;
}
function recoveryInput() {
  set('cloud-recovery-code', 'TEST-PAIRING-CODE');
  set('cloud-recovery-secret', 'my secret value');
  byId('cloud-recovery-approve').checked = true;
}

beforeEach(() => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('экспериментальный первый снимок и восстановление в настройках', () => {
  it('браузер показывает отключённые действия, не загружая native', () => {
    const loadNative = vi.fn();
    setup({ desktop: false, loadNative });
    expect(byId('cloud-registration-panel').open).toBe(false);
    expect(byId('cloud-setup-create').disabled).toBe(true);
    expect(byId('cloud-recovery-check').disabled).toBe(true);
    expect(byId('cloud-setup-send-root').disabled).toBe(true);
    expect(byId('cloud-setup-status').textContent).toContain('только в настольном приложении');
    click('cloud-setup-create');
    expect(loadNative).not.toHaveBeenCalled();
  });

  it('требует отдельного подтверждения нового набора и двойного ввода, не сохраняя секреты в статусе', async () => {
    const f = setup();
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    prepareInput();
    byId('cloud-setup-new-approve').checked = false;
    click('cloud-setup-create');
    expect(f.begin).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(byId('cloud-setup-create').disabled).toBe(false));
    byId('cloud-setup-new-approve').checked = true;
    set('cloud-setup-main-repeat', 'different');
    click('cloud-setup-create');
    expect(f.begin).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(byId('cloud-setup-create').disabled).toBe(false));
    prepareInput();
    click('cloud-setup-create');
    await vi.waitFor(() => expect(byId('cloud-setup-confirm').hidden).toBe(false));
    expect(f.begin).toHaveBeenCalledWith({
      primary: { kind: 'password', secret: 'a strong passphrase' },
      backup: { kind: 'generated' },
      newDatasetConfirmed: true
    });
    expect(byId('cloud-setup-main').value).toBe('');
    expect(byId('cloud-setup-main-repeat').value).toBe('');
    expect(byId('cloud-setup-generated').type).toBe('password');
    click('cloud-setup-reveal');
    expect(byId('cloud-setup-generated').type).toBe('text');
    click('cloud-setup-confirm-button');
    expect(f.confirmBackup).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(byId('cloud-setup-confirm-button').disabled).toBe(false));
    byId('cloud-setup-saved').checked = true;
    set('cloud-setup-backup-confirm', 'TFB1-saved-secret');
    click('cloud-setup-confirm-button');
    await vi.waitFor(() => expect(byId('cloud-setup-code-label').hidden).toBe(false));
    expect(f.confirmBackup).toHaveBeenCalledWith({ secret: 'TFB1-saved-secret', savedSeparately: true });
    expect(byId('cloud-setup-generated').value).toBe('');
    expect(byId('cloud-setup-backup-confirm').value).toBe('');
    expect(byId('cloud-setup-status').textContent).not.toContain('secret');
    expect(byId('cloud-setup-code').value).toBe('TEST-PAIRING-CODE');
    expect(f.send).not.toHaveBeenCalled();
    expect(storage).toHaveBeenCalledOnce();
    const savedLog = storage.mock.calls[0][1];
    expect(savedLog).not.toContain('secret');
    expect(savedLog).not.toContain('passphrase');
    expect(savedLog).not.toContain('PAIRING');
    expect(JSON.parse(savedLog)[0]).toEqual(
      expect.objectContaining({ provider: 'yandex', action: 'prepare', outcome: 'success' })
    );
  });

  it('ошибка повторного ввода остаётся исправимой, отмена освобождает операцию', async () => {
    const f = setup();
    f.confirmBackup.mockResolvedValueOnce({ status: 'invalid_backup' });
    prepareInput();
    click('cloud-setup-create');
    await vi.waitFor(() => expect(byId('cloud-setup-confirm').hidden).toBe(false));
    byId('cloud-setup-saved').checked = true;
    set('cloud-setup-backup-confirm', 'wrong');
    click('cloud-setup-confirm-button');
    await vi.waitFor(() => expect(byId('cloud-setup-status').textContent).toContain('не совпал'));
    expect(byId('cloud-setup-confirm').hidden).toBe(false);
    expect(byId('cloud-setup-backup-confirm').value).toBe('');
    click('cloud-setup-cancel');
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(byId('cloud-setup-confirm').hidden).toBe(true);
    expect(byId('cloud-setup-generated').value).toBe('');
  });

  it('при смене диска отменяет подготовленный результат и не показывает чужой код', async () => {
    const wait = deferred();
    const cancel = vi.fn();
    const makeSetup = vi.fn(() => ({ begin: () => wait.promise }));
    setup({ makeSetup });
    prepareInput();
    click('cloud-setup-create');
    await vi.waitFor(() => expect(makeSetup).toHaveBeenCalledOnce());
    change('cloud-registration-provider', 'google');
    wait.resolve({ status: 'prepared', cancel, generatedBackupSecret: 'do-not-show' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(byId('cloud-setup-confirm').hidden).toBe(true);
    expect(byId('cloud-setup-generated').value).toBe('');
    expect(byId('cloud-setup-code-label').hidden).toBe(true);
  });

  it('при смене диска во время неверного подтверждения освобождает подготовку', async () => {
    const f = setup();
    const wait = deferred();
    f.confirmBackup.mockReturnValueOnce(wait.promise);
    prepareInput();
    click('cloud-setup-create');
    await vi.waitFor(() => expect(byId('cloud-setup-confirm').hidden).toBe(false));
    byId('cloud-setup-saved').checked = true;
    set('cloud-setup-backup-confirm', 'wrong');
    click('cloud-setup-confirm-button');
    await vi.waitFor(() => expect(f.confirmBackup).toHaveBeenCalledOnce());
    change('cloud-registration-provider', 'google');
    wait.resolve({ status: 'invalid_backup' });
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(byId('cloud-setup-confirm').hidden).toBe(true);
    expect(byId('cloud-setup-create').disabled).toBe(false);
  });

  it('показывает сравнение без применения до подключения, затем разрешает выборочное применение', async () => {
    const f = setup();
    recoveryInput();
    click('cloud-recovery-check');
    await vi.waitFor(() => expect(byId('cloud-recovery-connect').hidden).toBe(false));
    expect(f.recoveryBegin).toHaveBeenCalledWith({
      pairingCode: 'TEST-PAIRING-CODE',
      independentPinConfirmed: true,
      role: 'main',
      secret: 'my secret value'
    });
    expect(byId('cloud-recovery-secret').value).toBe('');
    expect(byId('cloud-review-result').hidden).toBe(false);
    byId('cloud-recovery-reviewed').checked = true;
    click('cloud-recovery-connect');
    await vi.waitFor(() => expect(byId('cloud-setup-status').textContent).toContain('Сначала выберите версию'));
    expect(f.connect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(byId('cloud-recovery-connect').disabled).toBe(false));
    change('cloud-review-version', '0');
    click('cloud-review-select-all');
    expect(byId('cloud-review-apply').disabled).toBe(true);
    click('cloud-review-apply');
    expect(f.stage).not.toHaveBeenCalled();
    f.confirm.mockReturnValueOnce(false);
    click('cloud-recovery-connect');
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.connect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(byId('cloud-recovery-connect').disabled).toBe(false));
    click('cloud-recovery-connect');
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledWith({ confirmed: true }));
    await vi.waitFor(() => expect(byId('cloud-setup-status').textContent).toContain('Подключение восстановлено'));
    expect(byId('cloud-review-apply').disabled).toBe(false);
    expect(byId('cloud-review-version').value).toBe('');
    change('cloud-review-version', '0');
    click('cloud-review-select-all');
    click('cloud-review-apply');
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalledWith({ confirmed: true }));
  });

  it('отмена восстановления очищает предварительные различия и секрет', async () => {
    const f = setup();
    recoveryInput();
    click('cloud-recovery-check');
    await vi.waitFor(() => expect(byId('cloud-recovery-connect').hidden).toBe(false));
    click('cloud-recovery-cancel');
    expect(f.recoveryCancel).toHaveBeenCalledOnce();
    expect(byId('cloud-review-result').hidden).toBe(true);
    expect(byId('cloud-recovery-secret').value).toBe('');
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('отправляет только первый снимок после подтверждения и не повторяет её при неопределённости', async () => {
    const f = setup();
    f.confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(byId('cloud-setup-send-root').disabled).toBe(false));
    f.send.mockResolvedValueOnce({ status: 'verification_pending' });
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(byId('cloud-setup-status').textContent).toContain('Повторный запрос создания не выполняется')
    );
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ provider: 'yandex', confirmed: true }));
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('отдельно спрашивает о более раннем снимке и не выдаёт текущие изменения за отправленные', async () => {
    const f = setup();
    f.send.mockResolvedValueOnce({ status: 'prepared_snapshot_outdated' }).mockResolvedValueOnce({
      status: 'sent_earlier_verified'
    });
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.confirm).toHaveBeenCalledTimes(2);
    expect(f.confirm.mock.calls[1][0]).toContain('Текущие изменения при этом не будут отправлены');
    expect(f.send.mock.calls[1][0]).toMatchObject({ allowEarlierSnapshot: true, provider: 'yandex' });
    expect(byId('cloud-setup-status').textContent).toContain('Текущие изменения ещё не отправлены');
  });

  it('отказ от более раннего снимка не выполняет второй запрос', async () => {
    const f = setup();
    f.confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);
    f.send.mockResolvedValueOnce({ status: 'prepared_snapshot_outdated' });
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(2));
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('может показать ранее созданный код и продолжить настройку без отправки', async () => {
    const f = setup();
    click('cloud-setup-show-code');
    await vi.waitFor(() => expect(byId('cloud-setup-code-label').hidden).toBe(false));
    expect(f.readCode).toHaveBeenCalledOnce();
    click('cloud-setup-resume');
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalledWith({ resumeConfirmed: true, backupKeySaved: true }));
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe('автоматическая подготовка местных данных перед новым набором', () => {
  it('сначала сохраняет и подготавливает ID, затем начинает ключи', async () => {
    const prepareData = vi.fn(async () => true);
    const f = setup({ prepareData });
    prepareInput();
    click('cloud-setup-create');
    await vi.waitFor(() => expect(f.begin).toHaveBeenCalledOnce());
    expect(prepareData).toHaveBeenCalledOnce();
    expect(prepareData.mock.invocationCallOrder[0]).toBeLessThan(f.begin.mock.invocationCallOrder[0]);
  });
  it.each([false, 'throw'])('ошибка подготовки %s не запускает новый набор и не отправляет файл', async outcome => {
    const f = setup({
      prepareData: vi.fn(async () => {
        if (outcome === 'throw') throw new Error('PRIVATE_DISK_ERROR');
        return false;
      })
    });
    prepareInput();
    click('cloud-setup-create');
    await vi.waitFor(() => expect(byId('cloud-setup-create').disabled).toBe(false));
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('PRIVATE_DISK_ERROR');
  });
});

describe('привязки разных дисков не выдаются друг за друга', () => {
  it.each([
    'binding_missing_or_blocked',
    'binding_missing',
    'binding_blocked',
    'binding_unavailable',
    'credential_missing',
    'credential_blocked',
    'credential_unavailable',
    'login_required',
    'account_unavailable'
  ])('показывает фиксированный %s для выбранного Google, а не общую ошибку', async value => {
    const f = setup();
    change('cloud-registration-provider', 'google');
    f.readCode.mockResolvedValueOnce({ status: value });
    click('cloud-setup-show-code');
    await vi.waitFor(() => expect(byId('cloud-setup-show-code').disabled).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Google Диск');
    expect(byId('cloud-setup-status').textContent).toContain('Код: setup/' + value);
    expect(byId('cloud-setup-code-label').hidden).toBe(true);
    f.send.mockResolvedValueOnce({ status: value });
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(byId('cloud-setup-send-root').disabled).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Код: setup/' + value);
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.recoveryBegin).not.toHaveBeenCalled();
  });

  it('при переключении Яндекс → Google скрывает код и старое успешное сообщение без native/сети', async () => {
    const f = setup();
    click('cloud-setup-show-code');
    await vi.waitFor(() => expect(byId('cloud-setup-code-label').hidden).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Яндекс Диск');
    change('cloud-registration-provider', 'google');
    expect(byId('cloud-setup-code-label').hidden).toBe(true);
    expect(byId('cloud-setup-code').value).toBe('');
    expect(byId('cloud-setup-status').textContent).toContain('Выбран Google Диск');
    expect(byId('cloud-setup-status').textContent).not.toContain('Код сверки показан');
    expect(f.readCode).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.begin).not.toHaveBeenCalled();
  });

  it.each(['ready', 'binding_missing_or_blocked'])(
    'поздний код/отказ %s прежнего диска не превращается в ошибку нового диска',
    async value => {
      const wait = deferred();
      const readCode = vi.fn(() => wait.promise);
      setup({ readCode });
      click('cloud-setup-show-code');
      await vi.waitFor(() => expect(readCode).toHaveBeenCalledOnce());
      change('cloud-registration-provider', 'google');
      wait.resolve({ status: value, pairingCode: 'FAKE_PRIVATE_OLD_CODE' });
      await vi.waitFor(() => expect(byId('cloud-setup-show-code').disabled).toBe(false));
      expect(byId('cloud-setup-status').textContent).toContain('Выбран Google Диск');
      expect(byId('cloud-setup-status').textContent).not.toContain('Операция не завершена');
      expect(byId('cloud-setup-code').value).toBe('');
    }
  );

  it('поздний результат отправки Яндекса не сообщает об успехе/ошибке Google, но журнал сохраняет Яндекс', async () => {
    const wait = deferred();
    const send = vi.fn(() => wait.promise);
    setup({ send });
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    change('cloud-registration-provider', 'google');
    wait.resolve({ status: 'sent_verified' });
    await vi.waitFor(() => expect(byId('cloud-setup-send-root').disabled).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Выбран Google Диск');
    const logs = JSON.parse(localStorage.getItem('tf_cloud_activity_v1'));
    expect(logs[0]).toMatchObject({ provider: 'yandex', action: 'send', outcome: 'success' });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(['FAKE_PRIVATE_STATUS', 'toString', '__proto__'])(
    'не выводит неизвестный код %s или унаследованные свойства',
    async value => {
      const f = setup();
      f.readCode.mockResolvedValueOnce({ status: value });
      click('cloud-setup-show-code');
      await vi.waitFor(() => expect(byId('cloud-setup-show-code').disabled).toBe(false));
      expect(byId('cloud-setup-status').textContent).toContain('Операция не завершена');
      expect(byId('cloud-setup-status').textContent).not.toContain(value);
      expect(byId('cloud-setup-status').textContent).not.toContain('native code');
    }
  );
});

it.each(['prepared_snapshot_outdated', 'throw'])(
  'поздний %s при отправке прежнего диска не открывает подтверждение и не меняет статус нового',
  async value => {
    let finish;
    const send = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          finish =
            value === 'throw' ? () => reject(new Error('FAKE_PRIVATE_FAILURE')) : () => resolve({ status: value });
        })
    );
    const f = setup({ send });
    click('cloud-setup-send-root');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    change('cloud-registration-provider', 'google');
    finish();
    await vi.waitFor(() => expect(byId('cloud-setup-send-root').disabled).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Выбран Google Диск');
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE');
  }
);

describe('проверка готовности не является отправкой', () => {
  it.each([
    'local_send_ready',
    'login_required',
    'probe_credential_read_unavailable',
    'probe_credential_record_invalid',
    'deferred',
    'journal_uncertain'
  ])('показывает точный %s без отправки, ключей, подтверждений и журнала отправок', async value => {
    const f = setup();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    f.inspectSend.mockResolvedValueOnce({ status: value });
    click('cloud-setup-inspect-send');
    await vi.waitFor(() => expect(f.inspectSend).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(byId('cloud-setup-inspect-send').disabled).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Яндекс Диск');
    expect(byId('cloud-setup-status').textContent).toContain('Код: setup/' + value);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.begin).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it('поздняя диагностика Яндекса не подменяет Google', async () => {
    const f = setup();
    const wait = deferred();
    f.inspectSend.mockReturnValueOnce(wait.promise);
    click('cloud-setup-inspect-send');
    await vi.waitFor(() => expect(f.inspectSend).toHaveBeenCalledOnce());
    change('cloud-registration-provider', 'google');
    wait.resolve({ status: 'login_required' });
    await vi.waitFor(() => expect(byId('cloud-setup-inspect-send').disabled).toBe(false));
    expect(byId('cloud-setup-status').textContent).toContain('Выбран Google Диск');
    expect(byId('cloud-setup-status').textContent).not.toContain('login_required');
  });
});
