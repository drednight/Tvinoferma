import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';

const STORAGE_KEY = 'tvinoferma_state_v1';
const clientIds = {
  google: '123456789-fake_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
const mainSecret = 'Синтетический основной пароль 123!';
const customBackup = 'Синтетический запасной ключ 987!';
const digest = raw => createHash('sha256').update(raw).digest('hex');

// IPC и диски намеренно синтетические. Не подтверждает Windows, безопасность
// хранилища, подлинный API или устойчивость к отключению питания.
function fakeNative(generateSyncId, fault = null) {
  const accounts = Object.fromEntries(
    ['google', 'yandex'].map(provider => [
      provider,
      { slotId: generateSyncId(webcrypto), clientId: clientIds[provider], accountKey: 'FAKE_PRIVATE_ACCOUNT' }
    ])
  );
  let key = null;
  const pins = { google: null, yandex: null };
  const queues = { google: null, yandex: null };
  let failed = false;
  const invoke = vi.fn(async (command, input) => {
    if (command === 'cloud_credential_binding_read') {
      return { status: 'ready', ...accounts[input.provider] };
    }
    if (command === 'cloud_key_state_read') {
      return key ? { status: 'ready', slotId: key.slotId, record: key.record } : { status: 'empty' };
    }
    if (command === 'cloud_key_state_install') {
      if (key) return { status: 'occupied' };
      key = { slotId: input.slotId, record: input.record };
      if (fault === 'key' && !failed) {
        failed = true;
        throw new Error('PRIVATE lost key response');
      }
      return { status: 'installed' };
    }
    if (command === 'cloud_dataset_binding_read') {
      return pins[input.provider] ? { status: 'ready', record: pins[input.provider] } : { status: 'empty' };
    }
    if (command === 'cloud_dataset_binding_install') {
      if (pins[input.provider]) return { status: 'occupied' };
      if (!key) return { status: 'blocked' };
      pins[input.provider] = input.record;
      if (fault === 'binding' && !failed) {
        failed = true;
        throw new Error('PRIVATE lost binding response');
      }
      return { status: 'installed' };
    }
    if (command === 'cloud_outbox_read') {
      return queues[input.provider] ? { status: 'ready', ...queues[input.provider] } : { status: 'empty' };
    }
    if (command === 'cloud_outbox_compare_exchange') {
      const previous = queues[input.provider];
      const next = input.args;
      if (!previous) return { status: 'blocked' };
      if (next.expectedRevisionId !== previous.revisionId || next.expectedSha256 !== previous.sha256)
        return { status: 'mismatch' };
      const { slotId, datasetId, deviceId, revisionId, record } = next;
      queues[input.provider] = { slotId, datasetId, deviceId, revisionId, record, sha256: digest(record) };
      return { status: 'swapped' };
    }
    if (command === 'cloud_outbox_install_initial') {
      const other = input.provider === 'google' ? 'yandex' : 'google';
      const storedKey = key && JSON.parse(key.record);
      if (
        queues[other] ||
        pins[other] ||
        pins[input.provider] ||
        !storedKey ||
        input.guard.accountSlotId !== accounts[input.provider].slotId ||
        input.guard.keySlotId !== storedKey.slotId ||
        input.guard.bundleId !== storedKey.bundleId ||
        input.guard.fingerprint !== storedKey.fingerprint ||
        input.args.datasetId !== storedKey.datasetId
      )
        return { status: 'blocked' };
      if (queues[input.provider]) return { status: 'occupied' };
      queues[input.provider] = { ...input.args, sha256: digest(input.args.record) };
      if (fault === 'queue' && !failed) {
        failed = true;
        throw new Error('PRIVATE lost queue response');
      }
      return { status: 'installed' };
    }
    throw new Error('Unexpected fake IPC');
  });
  return { invoke, accounts, key: () => key, pin: provider => pins[provider], queue: provider => queues[provider] };
}

async function fixture(fault = null) {
  vi.resetModules();
  localStorage.clear();
  const { state, normalizeState } = await import('../js/core/state.js');
  const storage = await import('../js/core/storage.js');
  const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
  const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
  const { createInitialCloudSetup, readLocalCloudPairingCode } =
    await import('../js/modules/cloudSync/initialCloudSetup.js');
  const { parsePairingCode } = await import('../js/modules/cloudSync/pairingCode.js');
  const { sendInitialCloudRoot } = await import('../js/modules/cloudSync/sendInitialCloudRoot.js');
  const { createCloudRecovery } = await import('../js/modules/cloudSync/recoverCloudConnection.js');
  Object.assign(
    state,
    normalizeState({
      schemaVersion: 10,
      characters: [
        {
          id: 'hero',
          nick: 'ЛИЧНЫЙ ПЕРСОНАЖ',
          notes: 'ЛИЧНАЯ ЗАМЕТКА',
          contacts: { password: 'PRIVATE_PASSWORD' },
          launch: { gcPath: '/private/path' }
        }
      ],
      plannerEntries: [{ id: 'task', title: 'ЛИЧНАЯ ЗАДАЧА', date: '2026-10-30' }],
      settings: { security: { useVault: false } }
    })
  );
  const { ui, ...snapshot } = state;
  Object.assign(state, planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot);
  await storage.saveNow();
  const fake = fakeNative(generateSyncId, fault);
  const setup = provider => createInitialCloudSetup({ provider, invoke: fake.invoke, cryptoSource: webcrypto });
  return {
    state,
    storage,
    fake,
    setup,
    parsePairingCode,
    sendInitialCloudRoot,
    createCloudRecovery,
    readLocalCloudPairingCode,
    oldRaw: localStorage.getItem(STORAGE_KEY)
  };
}
async function restarted(fake, provider) {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  vi.resetModules();
  const { state, normalizeState } = await import('../js/core/state.js');
  Object.assign(state, normalizeState(saved));
  const { createInitialCloudSetup, readLocalCloudPairingCode } =
    await import('../js/modules/cloudSync/initialCloudSetup.js');
  return {
    setup: createInitialCloudSetup({ provider, invoke: fake.invoke, cryptoSource: webcrypto }),
    readLocalCloudPairingCode,
    ...(await import('../js/modules/cloudSync/pairingCode.js'))
  };
}
const begin = setup =>
  setup.begin({
    primary: { kind: 'password', secret: mainSecret },
    backup: { kind: 'generated' },
    newDatasetConfirmed: true
  });

function fakeSendSession(f, provider) {
  const parts = f.fake.pin(provider).split('|');
  let stored = null;
  let allowVerify = true;
  const session = {
    generateFileId: vi.fn(async () => ({ status: 'generated', fileId: 'FAKE_FILE_ID' })),
    upload: vi.fn(async value => {
      stored = structuredClone(value);
      return { status: 'accepted' };
    }),
    verify: vi.fn(async value =>
      allowVerify && JSON.stringify(value) === JSON.stringify(stored)
        ? { status: 'verified' }
        : { status: 'unavailable' }
    ),
    dispose: vi.fn()
  };
  return {
    session,
    setVerify(value) {
      allowVerify = value;
    },
    stored: () => stored,
    openSession: vi.fn(async () => ({
      status: 'opened',
      datasetId: parts[5],
      keyPin: { bundleId: parts[6], sha256: parts[7] },
      rootPin: { versionId: parts[8], sha256: parts[9] },
      session
    }))
  };
}

async function syntheticSource(provider) {
  const source = await fixture();
  const pending = await begin(source.setup(provider));
  const secret = pending.generatedBackupSecret;
  const done = await pending.confirmBackup({ secret, savedSeparately: true });
  const network = fakeSendSession(source, provider);
  expect(
    await source.sendInitialCloudRoot({
      provider,
      invoke: source.fake.invoke,
      confirmed: true,
      cryptoSource: webcrypto,
      openSession: network.openSession
    })
  ).toEqual({ status: 'sent_verified' });
  return { secret, code: done.pairingCode, envelope: network.stored().envelope };
}
function fakeRecoverySession(envelope) {
  let visible = true;
  const sessions = [];
  return {
    hide() {
      visible = false;
    },
    sessions,
    openSession: vi.fn(async () => {
      const session = {
        read: vi.fn(async versionId =>
          visible && versionId === envelope.versionId
            ? { status: 'found', envelope: structuredClone(envelope) }
            : { status: 'not_found' }
        ),
        listWithDates: vi.fn(async () => ({
          status: 'listed',
          versions: visible ? [{ versionId: envelope.versionId, modifiedAt: '2026-10-29T12:00:00Z' }] : []
        })),
        dispose: vi.fn()
      };
      sessions.push(session);
      return { status: 'opened', session };
    })
  };
}

beforeEach(() => vi.restoreAllMocks());

describe.each(['google', 'yandex'])('%s: первичная локальная настройка через fake IPC', provider => {
  it('требует точную копию и повторный ввод запасного ключа, готовит корень и код без сети', async () => {
    const f = await fixture();
    const setup = f.setup(provider);
    const pending = await begin(setup);
    expect(pending.status).toBe('prepared');
    expect(pending.generatedBackupSecret).toMatch(/^TFB1-/);
    expect(f.fake.key()).toBeNull();
    expect(f.fake.queue(provider)).toBeNull();
    expect(
      Object.keys(localStorage).some(
        name => name.startsWith('tvinoferma_backup_') && localStorage.getItem(name) === f.oldRaw
      )
    ).toBe(true);
    expect(await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: false })).toEqual({
      status: 'confirmation_required'
    });
    expect(await pending.confirmBackup({ secret: 'wrong-secret', savedSeparately: true })).toEqual({
      status: 'invalid_backup'
    });
    expect(f.fake.key()).toBeNull();
    const done = await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true });
    expect(done).toMatchObject({ status: 'prepared', resumed: false });
    expect(localStorage.getItem(done.backup)).toBe(f.oldRaw);
    expect(f.fake.key()).not.toBeNull();
    expect(f.fake.pin(provider)).not.toBeNull();
    expect(f.fake.queue(provider)).not.toBeNull();
    const descriptor = f.parsePairingCode(done.pairingCode);
    const pinParts = f.fake.pin(provider).split('|');
    expect(descriptor.datasetId).toBe(pinParts[5]);
    expect(descriptor.keyPin).toEqual({ bundleId: pinParts[6], sha256: pinParts[7] });
    expect(descriptor.rootPin).toEqual({ versionId: pinParts[8], sha256: pinParts[9] });
    expect(pinParts[10]).toBe(provider === 'google' ? 'root' : '-');
    expect(await f.readLocalCloudPairingCode({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })).toEqual({
      status: 'ready',
      pairingCode: done.pairingCode
    });
    const journal = JSON.stringify(f.fake.queue(provider));
    for (const value of [
      'ЛИЧНЫЙ ПЕРСОНАЖ',
      'ЛИЧНАЯ ЗАМЕТКА',
      'ЛИЧНАЯ ЗАДАЧА',
      'PRIVATE_PASSWORD',
      mainSecret,
      pending.generatedBackupSecret
    ]) {
      expect(journal).not.toContain(value);
    }
    expect(f.fake.invoke.mock.calls.some(([command]) => command === 'cloud_disk_request')).toBe(false);
    expect((await begin(f.setup(provider))).status).toBe('dataset_binding_present');
  }, 30_000);

  it('отмена и изменение данных до подтверждения не устанавливают ключ, очередь или привязку', async () => {
    const f = await fixture();
    const first = await begin(f.setup(provider));
    expect(first.cancel()).toEqual({ status: 'cancelled' });
    expect(f.fake.key()).toBeNull();
    const second = await begin(f.setup(provider));
    f.state.characters[0].notes = 'НЕСОХРАНЁННАЯ ПРАВКА';
    expect(await second.confirmBackup({ secret: second.generatedBackupSecret, savedSeparately: true })).toEqual({
      status: 'state_changed'
    });
    expect(f.fake.key()).toBeNull();
    expect(f.fake.pin(provider)).toBeNull();
    expect(f.fake.queue(provider)).toBeNull();
  }, 30_000);

  it('после потерянного ответа на очередь использует тот же корень после перезапуска, не создавая второго', async () => {
    const f = await fixture('queue');
    const setup = f.setup(provider);
    const pending = await begin(setup);
    expect(await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true })).toEqual({
      status: 'setup_uncertain'
    });
    const before = f.fake.queue(provider);
    expect(before).not.toBeNull();
    expect(f.fake.pin(provider)).toBeNull();
    expect(await setup.resume({ resumeConfirmed: true, backupKeySaved: true })).toEqual({
      status: 'busy_or_restart_required'
    });
    const next = await restarted(f.fake, provider);
    const resumed = await next.setup.resume({ resumeConfirmed: true, backupKeySaved: true });
    expect(resumed).toMatchObject({ status: 'prepared', resumed: true });
    expect(f.fake.queue(provider)).toEqual(before);
    const descriptor = next.parsePairingCode(resumed.pairingCode);
    const pinParts = f.fake.pin(provider).split('|');
    expect(descriptor.rootPin).toEqual({ versionId: pinParts[8], sha256: pinParts[9] });
    expect(f.fake.invoke.mock.calls.filter(([command]) => command === 'cloud_outbox_install_initial')).toHaveLength(1);
  }, 30_000);

  it('после потерянного ответа на pin повторно показывает уже закреплённый код без записи', async () => {
    const f = await fixture('binding');
    const pending = await begin(f.setup(provider));
    expect(await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true })).toEqual({
      status: 'setup_uncertain'
    });
    expect(f.fake.pin(provider)).not.toBeNull();
    const next = await restarted(f.fake, provider);
    const code = await next.readLocalCloudPairingCode({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto });
    expect(code.status).toBe('ready');
    expect(next.parsePairingCode(code.pairingCode).rootPin.versionId).toBe(f.fake.pin(provider).split('|')[8]);
    expect(f.fake.invoke.mock.calls.filter(([command]) => command === 'cloud_dataset_binding_install')).toHaveLength(1);
  }, 30_000);

  it('отправляет только совпадающий сохранённый корень и подтверждает точную сверку', async () => {
    const f = await fixture();
    const pending = await begin(f.setup(provider));
    const prepared = await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true });
    expect(prepared.status).toBe('prepared');
    const network = fakeSendSession(f, provider);
    const opts = {
      provider,
      invoke: f.fake.invoke,
      confirmed: true,
      cryptoSource: webcrypto,
      openSession: network.openSession
    };
    expect(await f.sendInitialCloudRoot(opts)).toEqual({ status: 'sent_verified' });
    expect(network.session.upload).toHaveBeenCalledTimes(1);
    expect(network.session.verify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(network.stored())).not.toContain('ЛИЧНАЯ ЗАМЕТКА');
    expect(JSON.stringify(network.stored())).not.toContain('PRIVATE_PASSWORD');
    expect(await f.sendInitialCloudRoot(opts)).toEqual({ status: 'already_confirmed' });
    expect(network.session.upload).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('при изменении локального снимка не отправляет устаревшую первую версию', async () => {
    const f = await fixture();
    const pending = await begin(f.setup(provider));
    expect((await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true })).status).toBe(
      'prepared'
    );
    const network = fakeSendSession(f, provider);
    const opts = {
      provider,
      invoke: f.fake.invoke,
      confirmed: true,
      cryptoSource: webcrypto,
      openSession: network.openSession
    };
    f.state.characters[0].notes = 'После подготовки';
    expect(await f.sendInitialCloudRoot(opts)).toEqual({ status: 'state_changed_or_unsaved' });
    await f.storage.saveNow();
    expect(await f.sendInitialCloudRoot(opts)).toEqual({ status: 'prepared_snapshot_outdated' });
    expect(network.openSession).not.toHaveBeenCalled();
    expect(network.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('сверяет потерянный ответ без повторной отправки, даже если данные позже изменились', async () => {
    const f = await fixture();
    const pending = await begin(f.setup(provider));
    expect((await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true })).status).toBe(
      'prepared'
    );
    const network = fakeSendSession(f, provider);
    network.setVerify(false);
    const opts = {
      provider,
      invoke: f.fake.invoke,
      confirmed: true,
      cryptoSource: webcrypto,
      openSession: network.openSession
    };
    expect(await f.sendInitialCloudRoot(opts)).toEqual({ status: 'verification_pending' });
    f.state.characters[0].notes = 'Другая правка';
    f.state.settings.cloudSyncPendingApply = { version: 999, events: [] };
    network.setVerify(true);
    expect(await f.sendInitialCloudRoot(opts)).toEqual({ status: 'sent_verified' });
    expect(network.session.upload).toHaveBeenCalledTimes(1);
    expect(network.session.verify).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('позволяет собственный запасной ключ, не показывая пароль или ключ в журнале', async () => {
    const f = await fixture();
    const pending = await f.setup(provider).begin({
      primary: { kind: 'password', secret: mainSecret },
      backup: { kind: 'custom', secret: customBackup },
      newDatasetConfirmed: true
    });
    expect(pending.status).toBe('prepared');
    expect(pending.generatedBackupSecret).toBeNull();
    const done = await pending.confirmBackup({ secret: customBackup, savedSeparately: true });
    expect(done.status).toBe('prepared');
    expect(JSON.stringify(f.fake.queue(provider))).not.toContain(customBackup);
  }, 30_000);
});

describe.each(['google', 'yandex'])('%s: восстановление и сравнение на втором fake ПК', provider => {
  it('проверяет независимый код и пароль, сравнивает до установки и применяет выбор с backup', async () => {
    const source = await syntheticSource(provider);
    const target = await fixture();
    target.state.characters = [];
    await target.storage.saveNow();
    const before = localStorage.getItem(STORAGE_KEY);
    const cloud = fakeRecoverySession(source.envelope);
    const recovery = target.createCloudRecovery({
      provider,
      invoke: target.fake.invoke,
      cryptoSource: webcrypto,
      openSession: cloud.openSession
    });
    const attempt = await recovery.begin({
      pairingCode: source.code,
      independentPinConfirmed: true,
      role: 'backup',
      secret: source.secret
    });
    expect(attempt.status).toBe('ready_for_confirmation');
    expect(target.fake.key()).toBeNull();
    expect(target.fake.pin(provider)).toBeNull();
    expect(localStorage.getItem(attempt.backup)).toBe(before);
    expect(attempt.review.versions).toHaveLength(1);
    const selected = attempt.review.versions[0].pin;
    const comparison = attempt.review.compare(selected);
    expect(
      comparison.differences.entries.some(entry => entry.kind === 'only_cloud' && entry.section === 'characters')
    ).toBe(true);
    const connected = await attempt.connect({ confirmed: true });
    expect(connected.status).toBe('connected');
    expect(target.fake.key()).not.toBeNull();
    expect(target.fake.pin(provider)).not.toBeNull();
    expect(target.fake.queue(provider)).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(cloud.sessions).toHaveLength(2);
    expect(cloud.sessions.every(session => session.dispose.mock.calls.length === 1)).toBe(true);
    const entry = connected.review
      .compare(selected)
      .differences.entries.find(value => value.kind === 'only_cloud' && value.section === 'characters');
    const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
    const apply = stageReviewedCloudApply({
      review: connected.review,
      pin: selected,
      selectedRecords: [{ section: 'characters', id: entry.id }],
      cryptoSource: webcrypto
    });
    const applied = await apply.commit({ confirmed: true });
    expect(applied.status).toBe('applied');
    expect(localStorage.getItem(applied.backup)).toBe(before);
    expect(target.state.characters.some(character => character.nick === 'ЛИЧНЫЙ ПЕРСОНАЖ')).toBe(true);
    expect(target.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(target.fake.invoke.mock.calls.some(([command]) => command === 'cloud_disk_network')).toBe(false);
  }, 30_000);

  it('не устанавливает ключ при неверном секрете или изменении облака после просмотра', async () => {
    const source = await syntheticSource(provider);
    const target = await fixture();
    const cloud = fakeRecoverySession(source.envelope);
    const recovery = target.createCloudRecovery({
      provider,
      invoke: target.fake.invoke,
      cryptoSource: webcrypto,
      openSession: cloud.openSession
    });
    expect(
      await recovery.begin({
        pairingCode: source.code,
        independentPinConfirmed: true,
        role: 'main',
        secret: 'wrong-secret'
      })
    ).toEqual({ status: 'invalid_secret_or_file' });
    expect(target.fake.key()).toBeNull();
    const attempt = await recovery.begin({
      pairingCode: source.code,
      independentPinConfirmed: true,
      role: 'backup',
      secret: source.secret
    });
    expect(attempt.status).toBe('ready_for_confirmation');
    cloud.hide();
    expect(await attempt.connect({ confirmed: true })).toEqual({ status: 'cloud_changed' });
    expect(target.fake.key()).toBeNull();
    expect(target.fake.pin(provider)).toBeNull();
    expect(target.fake.queue(provider)).toBeNull();
  }, 30_000);

  it('после неизвестной установки очереди продолжает с уже сохранённым ключом без пароля и не создаёт вторую', async () => {
    const source = await syntheticSource(provider);
    const target = await fixture('queue');
    const cloud = fakeRecoverySession(source.envelope);
    const options = { provider, invoke: target.fake.invoke, cryptoSource: webcrypto, openSession: cloud.openSession };
    const attempt = await target.createCloudRecovery(options).begin({
      pairingCode: source.code,
      independentPinConfirmed: true,
      role: 'backup',
      secret: source.secret
    });
    expect((await attempt.connect({ confirmed: true })).status).toBe('setup_uncertain');
    expect(target.fake.key()).not.toBeNull();
    const queue = target.fake.queue(provider);
    expect(queue).not.toBeNull();
    expect(target.fake.pin(provider)).toBeNull();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { createCloudRecovery } = await import('../js/modules/cloudSync/recoverCloudConnection.js');
    const retry = await createCloudRecovery(options).begin({
      pairingCode: source.code,
      independentPinConfirmed: true,
      role: 'existing',
      secret: ''
    });
    expect(retry.status).toBe('ready_for_confirmation');
    expect((await retry.connect({ confirmed: true })).status).toBe('connected');
    expect(target.fake.queue(provider)).toEqual(queue);
    expect(
      target.fake.invoke.mock.calls.filter(([command]) => command === 'cloud_outbox_install_initial')
    ).toHaveLength(1);
  }, 30_000);
});
