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
  let loseNextCompare = false;
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
      if (loseNextCompare) {
        loseNextCompare = false;
        throw new Error('PRIVATE lost queue compare response');
      }
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
  return {
    invoke,
    accounts,
    key: () => key,
    pin: provider => pins[provider],
    queue: provider => queues[provider],
    loseNextCompare: () => (loseNextCompare = true)
  };
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
    expect(await f.sendInitialCloudRoot({ ...opts, allowEarlierSnapshot: true })).toEqual({
      status: 'sent_earlier_verified'
    });
    expect(network.session.upload).toHaveBeenCalledTimes(1);
    const { queueConnectedSavedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    expect(
      await queueConnectedSavedSnapshot({
        provider,
        invoke: f.fake.invoke,
        cryptoSource: webcrypto,
        prepareIdentities: true
      })
    ).toEqual({ status: 'queued' });
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

// Второй synthetic transport хранит все версии по отдельности и умеет
// моделировать расхождение ветвей и потерю ответа. Это не настоящий Drive API.
function fakeHistorySession(f, provider, initialEnvelope) {
  const parts = f.fake.pin(provider).split('|');
  const versions = new Map([[initialEnvelope.versionId, structuredClone(initialEnvelope)]]);
  let file = 0;
  let verified = true;
  let afterList = null;
  let lose = false;
  const session = {
    generateFileId: vi.fn(async () => ({ status: 'generated', fileId: `SYNTHETIC_FILE_${++file}` })),
    upload: vi.fn(async ({ envelope }) => {
      versions.set(envelope.versionId, structuredClone(envelope));
      if (lose) {
        lose = false;
        throw new Error('PRIVATE lost network response');
      }
      return { status: 'accepted' };
    }),
    verify: vi.fn(async ({ envelope }) => ({
      status:
        verified && JSON.stringify(versions.get(envelope.versionId)) === JSON.stringify(envelope)
          ? 'verified'
          : 'unavailable'
    })),
    listWithDates: vi.fn(async () => {
      if (afterList) {
        const fn = afterList;
        afterList = null;
        await fn();
      }
      return {
        status: 'listed',
        versions: [...versions.keys()].map(versionId => ({ versionId, modifiedAt: '2026-10-29T12:00:00Z' }))
      };
    }),
    read: vi.fn(async versionId =>
      versions.has(versionId)
        ? { status: 'found', envelope: structuredClone(versions.get(versionId)) }
        : { status: 'not_found' }
    ),
    dispose: vi.fn()
  };
  return {
    versions,
    session,
    openSession: vi.fn(async () => ({
      status: 'opened',
      datasetId: parts[5],
      keyPin: { bundleId: parts[6], sha256: parts[7] },
      rootPin: { versionId: parts[8], sha256: parts[9] },
      session
    })),
    setVerify: value => (verified = value),
    loseNextUpload: () => (lose = true),
    onList: fn => (afterList = fn)
  };
}

async function publicationFixture(provider, options = {}) {
  const f = await fixture();
  if (options.prepare) await options.prepare(f);
  const setup = options.settingsSelections
    ? (await import('../js/modules/cloudSync/initialCloudSetup.js')).createInitialCloudSetup({
        provider,
        invoke: f.fake.invoke,
        cryptoSource: webcrypto,
        settingsSelections: options.settingsSelections
      })
    : f.setup(provider);
  const pending = await begin(setup);
  await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true });
  const initial = fakeSendSession(f, provider);
  expect(
    await f.sendInitialCloudRoot({
      provider,
      invoke: f.fake.invoke,
      confirmed: true,
      cryptoSource: webcrypto,
      openSession: initial.openSession,
      ...(options.settingsSelections ? { settingsSelections: options.settingsSelections } : {})
    })
  ).toEqual({ status: 'sent_verified' });
  const cloud = fakeHistorySession(f, provider, initial.stored().envelope);
  const publication = await import('../js/modules/cloudSync/connectedPublication.js');
  const local = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
  return {
    ...f,
    cloud,
    initialEnvelope: initial.stored().envelope,
    queue: () => publication.queueConnectedSavedSnapshot({ ...local, prepareIdentities: true }),
    send: () => publication.sendConnectedQueuedSnapshot({ ...local, openSession: cloud.openSession })
  };
}

describe.each(['google', 'yandex'])('%s: последующие версии через fake IPC и диск', provider => {
  it('ставит сохранение офлайн, после перезапуска отправляет и проверяет шифрованный снимок', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'НОВАЯ ЛИЧНАЯ ЗАМЕТКА';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(f.cloud.openSession).not.toHaveBeenCalled();
    const storedQueue = JSON.stringify(f.fake.queue(provider));
    for (const secret of ['НОВАЯ ЛИЧНАЯ ЗАМЕТКА', 'PRIVATE_PASSWORD', 'FAKE_PRIVATE_ACCOUNT'])
      expect(storedQueue).not.toContain(secret);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const publication = await import('../js/modules/cloudSync/connectedPublication.js');
    const options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
    expect(await publication.queueConnectedSavedSnapshot({ ...options, prepareIdentities: true })).toEqual({
      status: 'unchanged'
    });
    expect(await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).toEqual({
      status: 'sent_verified'
    });
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    const newest = [...f.cloud.versions.values()].find(value => value.versionId !== f.initialEnvelope.versionId);
    expect(JSON.stringify(newest)).not.toContain('НОВАЯ ЛИЧНАЯ ЗАМЕТКА');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = await parseKeyStateRecord(f.fake.key().record, webcrypto);
    const payload = await decryptSnapshot({
      envelope: newest,
      recoveryKey: key.state.dataKey,
      expectedDatasetId: key.state.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('НОВАЯ ЛИЧНАЯ ЗАМЕТКА');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_PASSWORD');
    expect(await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).toEqual({
      status: 'idle'
    });
  }, 30_000);

  it('назначает новым записям sync-ID только после backup сохранённого файла', async () => {
    const f = await publicationFixture(provider);
    const newCharacter = structuredClone(f.state.characters[0]);
    newCharacter.id = 'another';
    newCharacter.nick = 'НОВЫЙ ПЕРСОНАЖ';
    delete newCharacter.syncId;
    f.state.characters.push(newCharacter);
    await f.storage.saveNow();
    const before = localStorage.getItem(STORAGE_KEY);
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(f.state.characters[1].syncId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      Object.keys(localStorage).some(
        key => key.startsWith('tvinoferma_backup_') && localStorage.getItem(key) === before
      )
    ).toBe(true);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('останавливает несохранённые правки, удаление записи и отметку частичного применения', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'не сохранено';
    expect(await f.queue()).toEqual({ status: 'state_changed_or_unsaved' });
    f.state.characters[0].notes = 'ЛИЧНАЯ ЗАМЕТКА';
    f.state.characters = [];
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'deletions_need_review' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    f.state.settings.cloudSyncPendingApply = { version: 999, events: [] };
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'provenance_review_required' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('не публикует поверх чужой головы и не выбирает победителя при разошедшихся ветвях', async () => {
    const f = await publicationFixture(provider);
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const { sealHistoryVersion, historyEnvelopePin } = await import('../js/modules/cloudSync/history.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const rootPin = await historyEnvelopePin({
      envelope: f.initialEnvelope,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const payload = await decryptSnapshot({
      envelope: f.initialEnvelope,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    async function foreign() {
      return sealHistoryVersion({
        publicSnapshot: payload.publicSnapshot,
        parent: rootPin,
        recoveryKey: key.dataKey,
        datasetId: key.datasetId,
        versionId: generateSyncId(webcrypto),
        keyBundle: key.bundle,
        keyPin: key.pin,
        cryptoSource: webcrypto
      });
    }
    f.state.characters[0].notes = 'локальная ветвь';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    const first = await foreign();
    f.cloud.versions.set(first.pin.versionId, first.envelope);
    expect(await f.send()).toEqual({ status: 'remote_changes_require_review' });
    const second = await foreign();
    f.cloud.versions.set(second.pin.versionId, second.envelope);
    expect(await f.send()).toEqual({ status: 'remote_branches_require_review' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('при потерянном ответе только сверяет прошлую попытку и не повторяет её после сохранения', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'первая правка';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.loseNextUpload();
    f.cloud.setVerify(false);
    expect(await f.send()).toEqual({ status: 'verification_pending' });
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    f.state.characters[0].notes = 'вторая правка';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.setVerify(true);
    expect(await f.send()).toEqual({ status: 'verified_previous_attempt' });
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('может сверить неизвестную попытку после локального удаления, не отправляя это удаление', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'версия перед удалением';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.loseNextUpload();
    f.cloud.setVerify(false);
    expect((await f.send()).status).toBe('verification_pending');
    f.state.characters = [];
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('deletions_need_review');
    f.cloud.setVerify(true);
    expect((await f.send()).status).toBe('verified_previous_attempt');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    expect((await f.queue()).status).toBe('deletions_need_review');
  }, 30_000);

  it('отмена при чтении облака не начинает запись подготовленной версии', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'очередь перед отменой';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const controller = new AbortController();
    f.cloud.onList(() => controller.abort());
    const { sendConnectedQueuedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    const result = await sendConnectedQueuedSnapshot({
      provider,
      invoke: f.fake.invoke,
      cryptoSource: webcrypto,
      openSession: f.cloud.openSession,
      signal: controller.signal
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('не отправляет очередь, если локальные данные изменились во время проверки диска', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'сохранено до проверки';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.onList(async () => {
      f.state.characters[0].notes = 'изменено во время проверки';
      await f.storage.saveNow();
    });
    expect(await f.send()).toEqual({ status: 'state_changed_or_unsaved' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect((await f.queue()).status).toBe('coalesced');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);
});

async function recoveredFixture(provider, applyAll = true) {
  const source = await syntheticSource(provider);
  const target = await fixture();
  target.state.characters = [];
  target.state.plannerEntries = [];
  await target.storage.saveNow();
  const recoveryCloud = fakeRecoverySession(source.envelope);
  const recovery = target.createCloudRecovery({
    provider,
    invoke: target.fake.invoke,
    cryptoSource: webcrypto,
    openSession: recoveryCloud.openSession
  });
  const pending = await recovery.begin({
    pairingCode: source.code,
    independentPinConfirmed: true,
    role: 'backup',
    secret: source.secret
  });
  expect(pending.status).toBe('ready_for_confirmation');
  const connected = await pending.connect({ confirmed: true });
  expect(connected.status).toBe('connected');
  const pin = connected.review.versions[0].pin;
  const differences = connected.review.compare(pin).differences.entries;
  const records = differences
    .filter(entry => entry.kind === 'only_cloud' || entry.kind === 'changed')
    .map(entry => ({ section: entry.section, id: entry.id }));
  expect(records.length).toBeGreaterThan(1);
  const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
  const selected = applyAll ? records : records.slice(0, 1);
  expect(
    (
      await stageReviewedCloudApply({ review: connected.review, pin, selectedRecords: selected }).commit({
        confirmed: true
      })
    ).status
  ).toBe('applied');
  const cloud = fakeHistorySession(target, provider, source.envelope);
  const options = { provider, invoke: target.fake.invoke, cryptoSource: webcrypto };
  const reconciliation = await import('../js/modules/cloudSync/reconcileExactCloudBase.js');
  const publication = await import('../js/modules/cloudSync/connectedPublication.js');
  return {
    ...target,
    cloud,
    pin,
    options,
    reconcile: () =>
      reconciliation.reconcileExactCloudBase({ ...options, pin, confirmed: true, openSession: cloud.openSession }),
    queue: () => publication.queueConnectedSavedSnapshot({ ...options, prepareIdentities: true }),
    send: () => publication.sendConnectedQueuedSnapshot({ ...options, openSession: cloud.openSession })
  };
}

describe.each(['google', 'yandex'])('%s: принятие полностью совпавшей базы на втором fake ПК', provider => {
  it('после полного применения, повторной проверки и backup разрешает новую зашифрованную версию', async () => {
    const f = await recoveredFixture(provider);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect((await f.queue()).status).toBe('no_local_lineage');
    const before = localStorage.getItem(STORAGE_KEY);
    const reconciled = await f.reconcile();
    expect(reconciled.status).toBe('reconciled');
    expect(localStorage.getItem(reconciled.backup)).toBe(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(f.state.settings.cloudSyncAcceptedBase).toMatchObject({ provider, pin: f.pin });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    f.state.characters[0].notes = 'ИЗМЕНЕНО НА ВТОРОМ ПК';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    const newest = [...f.cloud.versions.values()].find(envelope => envelope.versionId !== f.pin.versionId);
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const payload = await decryptSnapshot({
      envelope: newest,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.parent).toEqual(f.pin);
    expect(payload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('ИЗМЕНЕНО НА ВТОРОМ ПК');
    expect(JSON.stringify(newest)).not.toContain('ИЗМЕНЕНО НА ВТОРОМ ПК');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_PASSWORD');
    // Несколько последующих подтверждений сжимают квитанции, но не теряют принятую базу.
    for (let i = 1; i <= 3; i++) {
      f.state.characters[0].notes = `ДОПОЛНИТЕЛЬНАЯ ПРАВКА ${i}`;
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      expect((await f.send()).status).toBe('sent_verified');
    }
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('не снимает marker при неполном выборе и не отправляет на диск', async () => {
    const f = await recoveredFixture(provider, false);
    const before = localStorage.getItem(STORAGE_KEY);
    expect(await f.reconcile()).toEqual({ status: 'not_exact' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.state.settings.cloudSyncAcceptedBase).toBeUndefined();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect((await f.queue()).status).toBe('no_local_lineage');
  }, 30_000);

  it('не принимает источник из другой ветви даже при совпадении текущего набора', async () => {
    const f = await recoveredFixture(provider);
    const { appendPendingSelectiveApply } = await import('../js/modules/cloudSync/pendingSelectiveApply.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const datasetId = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state.datasetId;
    f.state.settings = appendPendingSelectiveApply(f.state.settings, {
      provider,
      datasetId,
      pin: { versionId: generateSyncId(webcrypto), sha256: 'a'.repeat(64) },
      records: [],
      settings: [],
      financeSettings: false
    });
    await f.storage.saveNow();
    const before = localStorage.getItem(STORAGE_KEY);
    expect(await f.reconcile()).toEqual({ status: 'unresolved_sources' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(f.state.settings.cloudSyncPendingApply.events).toHaveLength(2);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('потеря ответа очереди не снимает marker; после перезапуска используется тот же anchor', async () => {
    const f = await recoveredFixture(provider);
    const before = localStorage.getItem(STORAGE_KEY);
    f.fake.loseNextCompare();
    expect(await f.reconcile()).toEqual({ status: 'journal_uncertain' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    const queueAfter = structuredClone(f.fake.queue(provider));
    const saved = JSON.parse(before);
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { queueConnectedSavedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    expect(await queueConnectedSavedSnapshot({ ...f.options, prepareIdentities: true })).toEqual({
      status: 'provenance_review_required'
    });
    const { reconcileExactCloudBase } = await import('../js/modules/cloudSync/reconcileExactCloudBase.js');
    const again = await reconcileExactCloudBase({
      ...f.options,
      pin: f.pin,
      confirmed: true,
      openSession: f.cloud.openSession
    });
    expect(again.status).toBe('reconciled');
    expect(f.fake.queue(provider)).toEqual(queueAfter); // существующий anchor не пересоздаётся
    expect(state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(state.settings.cloudSyncAcceptedBase).toBeTruthy();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('после неполной записи очереди не отправляет даже при ручном удалении marker', async () => {
    const f = await recoveredFixture(provider);
    f.fake.loseNextCompare();
    expect(await f.reconcile()).toEqual({ status: 'journal_uncertain' });
    delete f.state.settings.cloudSyncPendingApply;
    await f.storage.saveNow();
    expect(f.state.settings.cloudSyncAcceptedBase).toBeUndefined();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { queueConnectedSavedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    expect(await queueConnectedSavedSnapshot({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })).toEqual({
      status: 'accepted_base_mismatch'
    });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('если другая версия появилась во время согласования, не снимает marker', async () => {
    const f = await recoveredFixture(provider);
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const { sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const rootEnvelope = f.cloud.versions.get(f.pin.versionId);
    const payload = await decryptSnapshot({
      envelope: rootEnvelope,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const foreign = await sealHistoryVersion({
      publicSnapshot: payload.publicSnapshot,
      parent: f.pin,
      recoveryKey: key.dataKey,
      datasetId: key.datasetId,
      versionId: generateSyncId(webcrypto),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource: webcrypto
    });
    const originalList = f.cloud.session.listWithDates.getMockImplementation();
    let calls = 0;
    f.cloud.session.listWithDates.mockImplementation(async () => {
      if (++calls === 2) f.cloud.versions.set(foreign.pin.versionId, foreign.envelope);
      return originalList();
    });
    expect(await f.reconcile()).toEqual({ status: 'cloud_changed_after_queue' });
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.state.settings.cloudSyncAcceptedBase).toBeUndefined();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('если state меняется после установки основы в очередь, сохраняет marker и не публикует', async () => {
    const f = await recoveredFixture(provider);
    const originalList = f.cloud.session.listWithDates.getMockImplementation();
    let calls = 0;
    f.cloud.session.listWithDates.mockImplementation(async () => {
      calls++;
      if (calls === 2) {
        f.state.characters[0].notes = 'новая правка во время согласования';
        await f.storage.saveNow();
      }
      return originalList();
    });
    expect(await f.reconcile()).toEqual({ status: 'state_changed_after_queue' });
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.state.settings.cloudSyncAcceptedBase).toBeUndefined();
    expect((await f.queue()).status).toBe('provenance_review_required');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('не публикует, если локальная отметка принятой основы потеряна или подменена', async () => {
    const f = await recoveredFixture(provider);
    expect((await f.reconcile()).status).toBe('reconciled');
    delete f.state.settings.cloudSyncAcceptedBase;
    f.state.characters[0].notes = 'локальная правка';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'accepted_base_mismatch' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);
});

// Проверка чередования версий: сеть и два IPC-хранилища по-прежнему поддельные.
async function incomingVersion(f, provider, parent, note) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
  const { sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const old = await decryptSnapshot({
    envelope: f.cloud.versions.get(parent.versionId),
    recoveryKey: key.dataKey,
    expectedDatasetId: key.datasetId,
    cryptoSource: webcrypto
  });
  const snapshot = structuredClone(old.publicSnapshot);
  snapshot.sections.characters.records[0].fields.notes = note;
  const next = await sealHistoryVersion({
    publicSnapshot: snapshot,
    parent,
    recoveryKey: key.dataKey,
    datasetId: key.datasetId,
    versionId: generateSyncId(webcrypto),
    keyBundle: key.bundle,
    keyPin: key.pin,
    cryptoSource: webcrypto
  });
  f.cloud.versions.set(next.pin.versionId, next.envelope);
  await applyObservedVersion(f, provider, next.pin);
  return next.pin;
}

async function applyObservedVersion(f, provider, pin) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
  const { prepareCloudReview } = await import('../js/modules/cloudSync/cloudReview.js');
  const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
  const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
  const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const binding = parseDatasetBindingRecord(f.fake.pin(provider)).binding;
  const review = await prepareCloudReview({
    provider,
    session: f.cloud.session,
    datasetId: key.datasetId,
    dataKey: key.dataKey,
    rootPin: binding.rootPin,
    knownPins: [binding.rootPin],
    localSnapshot: buildPublicSnapshot(currentCloudStateSnapshot()),
    localSavedAt: null,
    cryptoSource: webcrypto
  });
  expect(review.status).toBe('ready_for_review');
  const records = review
    .compare(pin)
    .differences.entries.filter(entry => entry.kind === 'changed' || entry.kind === 'only_cloud')
    .map(entry => ({ section: entry.section, id: entry.id }));
  expect(records.length).toBeGreaterThan(0);
  expect(
    (await stageReviewedCloudApply({ review, pin, selectedRecords: records }).commit({ confirmed: true })).status
  ).toBe('applied');
}

async function reconcilePin(f, provider, pin) {
  const { reconcileExactCloudBase } = await import('../js/modules/cloudSync/reconcileExactCloudBase.js');
  return reconcileExactCloudBase({
    provider,
    invoke: f.fake.invoke,
    cryptoSource: webcrypto,
    pin,
    confirmed: true,
    openSession: f.cloud.openSession
  });
}

describe.each(['google', 'yandex'])('%s: поочерёдные версии после полного совпадения', provider => {
  it('снимает marker при возврате к уже подтверждённой локальной голове без подмены очереди', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'НЕОПУБЛИКОВАННАЯ ПРАВКА';
    await f.storage.saveNow();
    await applyObservedVersion(f, provider, root);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    const before = structuredClone(f.fake.queue(provider));
    const result = await reconcilePin(f, provider, root);
    expect(result.status).toBe('reconciled');
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(f.state.settings.cloudSyncAcceptedBase).toBeUndefined();
    f.state.characters[0].notes = 'НОВАЯ ПРАВКА';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
  }, 30_000);

  it('сохраняет локальные квитанции и дважды переносит подтверждённую основу на потомка', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const remote1 = await incomingVersion(f, provider, root, 'ПЕРВАЯ ПРАВКА ДРУГОГО ПК');
    const backup1 = localStorage.getItem(STORAGE_KEY);
    const first = await reconcilePin(f, provider, remote1);
    expect(first.status).toBe('reconciled');
    expect(localStorage.getItem(first.backup)).toBe(backup1);
    expect(f.state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(f.state.settings.cloudSyncAcceptedBase.pin).toEqual(remote1);
    f.state.characters[0].notes = 'ОТВЕТ ПЕРВОГО ПК';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    const firstOwn = [...f.cloud.versions.values()].at(-1);
    for (let i = 0; i < 3; i++) {
      f.state.characters[0].notes = `ДОПОЛНИТЕЛЬНАЯ ПРАВКА ${i}`;
      await f.storage.saveNow();
      expect(await f.queue()).toEqual({ status: 'queued' });
      expect(await f.send()).toEqual({ status: 'sent_verified' });
    }
    const { openConnectedPublicationContext } = await import('../js/modules/cloudSync/connectedPublication.js');
    const context = await openConnectedPublicationContext({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto });
    expect(await context.queue(f.cloud.session).compactConfirmed()).toEqual({ status: 'compacted', count: 1 });
    expect(await context.queue(f.cloud.session).compactConfirmed()).toEqual({ status: 'idle' });
    expect((await context.queue(f.cloud.session).inspectLinearHead(context.pins)).status).toBe('ready');
    const own = [...f.cloud.versions.values()].at(-1);
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const { historyEnvelopePin } = await import('../js/modules/cloudSync/history.js');
    const ownPin = await historyEnvelopePin({
      envelope: own,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const ownPayload = await decryptSnapshot({
      envelope: firstOwn,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(ownPayload.parent).toEqual(remote1);
    const oldAnchor = f.state.settings.cloudSyncAcceptedBase.anchorId;
    const remote2 = await incomingVersion(f, provider, ownPin, 'ВТОРАЯ ПРАВКА ДРУГОГО ПК');
    const second = await reconcilePin(f, provider, remote2);
    expect(second.status).toBe('reconciled');
    expect(f.state.settings.cloudSyncAcceptedBase.pin).toEqual(remote2);
    expect(f.state.settings.cloudSyncAcceptedBase.anchorId).not.toBe(oldAnchor);
    const afterRebase = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(afterRebase));
    const storage = await import('../js/core/storage.js');
    const publication = await import('../js/modules/cloudSync/connectedPublication.js');
    state.characters[0].notes = 'ВТОРОЙ ОТВЕТ ПЕРВОГО ПК';
    await storage.saveNow();
    const options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
    expect(await publication.queueConnectedSavedSnapshot(options)).toEqual({ status: 'queued' });
    expect(await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).toEqual({
      status: 'sent_verified'
    });
    const last = [...f.cloud.versions.values()].at(-1);
    const lastPayload = await decryptSnapshot({
      envelope: last,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(lastPayload.parent).toEqual(remote2);
    expect(lastPayload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('ВТОРОЙ ОТВЕТ ПЕРВОГО ПК');
    expect(JSON.stringify(f.fake.queue(provider))).not.toContain('ВТОРОЙ ОТВЕТ ПЕРВОГО ПК');
  }, 30_000);

  it('не принимает ветвь, из которой исчезла ранее подтверждённая локальная версия', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ПОДТВЕРЖДЁННАЯ ПРАВКА';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    const ownId = [...f.cloud.versions.keys()].find(versionId => versionId !== root.versionId);
    f.cloud.versions.delete(ownId); // диск вернул неполный список
    const remote = await incomingVersion(f, provider, root, 'ЧУЖАЯ ВЕТВЬ');
    const before = structuredClone(f.fake.queue(provider));
    expect(await reconcilePin(f, provider, remote)).toEqual({ status: 'local_lineage_not_ancestor' });
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('не меняет очередь при повреждённой отметке ранее принятой основы', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const { historyEnvelopePin } = await import('../js/modules/cloudSync/history.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const first = await incomingVersion(f, provider, root, 'ПЕРВОЕ ВХОДЯЩЕЕ');
    expect((await reconcilePin(f, provider, first)).status).toBe('reconciled');
    f.state.characters[0].notes = 'ПЕРВЫЙ ОТВЕТ';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const own = await historyEnvelopePin({
      envelope: [...f.cloud.versions.values()].at(-1),
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const second = await incomingVersion(f, provider, own, 'ВТОРОЕ ВХОДЯЩЕЕ');
    f.state.settings.cloudSyncAcceptedBase.anchorId = generateSyncId(webcrypto);
    await f.storage.saveNow();
    const before = structuredClone(f.fake.queue(provider));
    expect(await reconcilePin(f, provider, second)).toEqual({ status: 'accepted_base_mismatch' });
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
  }, 30_000);

  it('после потери ответа при повторном согласовании сохраняет прежнюю отметку и возобновляется с тем же anchor', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { historyEnvelopePin } = await import('../js/modules/cloudSync/history.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const first = await incomingVersion(f, provider, root, 'ПЕРВОЕ ВХОДЯЩЕЕ');
    expect((await reconcilePin(f, provider, first)).status).toBe('reconciled');
    f.state.characters[0].notes = 'ПЕРВЫЙ ОТВЕТ';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const own = await historyEnvelopePin({
      envelope: [...f.cloud.versions.values()].at(-1),
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const second = await incomingVersion(f, provider, own, 'ВТОРОЕ ВХОДЯЩЕЕ');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const oldToken = structuredClone(saved.settings.cloudSyncAcceptedBase);
    f.fake.loseNextCompare();
    expect(await reconcilePin(f, provider, second)).toEqual({ status: 'journal_uncertain' });
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.state.settings.cloudSyncAcceptedBase).toEqual(oldToken);
    const queueAfter = structuredClone(f.fake.queue(provider));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const storage = await import('../js/core/storage.js');
    const { queueConnectedSavedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    delete state.settings.cloudSyncPendingApply;
    await storage.saveNow();
    expect(await queueConnectedSavedSnapshot({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })).toEqual({
      status: 'accepted_base_mismatch'
    });
    Object.assign(state, normalizeState(saved));
    await storage.saveNow();
    expect(await queueConnectedSavedSnapshot({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })).toEqual({
      status: 'provenance_review_required'
    });
    expect((await reconcilePin(f, provider, second)).status).toBe('reconciled');
    expect(f.fake.queue(provider)).toEqual(queueAfter);
    expect(state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(state.settings.cloudSyncAcceptedBase.pin).toEqual(second);
    expect(state.settings.cloudSyncAcceptedBase.anchorId).not.toBe(oldToken.anchorId);
  }, 30_000);

  it('не снимает marker, если очередь изменена другим участником после принятия основы', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const { sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
    const { openConnectedPublicationContext } = await import('../js/modules/cloudSync/connectedPublication.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const remote = await incomingVersion(f, provider, root, 'ВХОДЯЩАЯ ПРАВКА');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const remotePayload = await decryptSnapshot({
      envelope: f.cloud.versions.get(remote.versionId),
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const another = await sealHistoryVersion({
      publicSnapshot: remotePayload.publicSnapshot,
      parent: remote,
      recoveryKey: key.dataKey,
      datasetId: key.datasetId,
      versionId: generateSyncId(webcrypto),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource: webcrypto
    });
    const context = await openConnectedPublicationContext({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto });
    const originalList = f.cloud.session.listWithDates.getMockImplementation();
    let reads = 0;
    f.cloud.session.listWithDates.mockImplementation(async () => {
      if (++reads === 2)
        expect(await context.queue(f.cloud.session).enqueue(another.envelope)).toEqual({ status: 'queued' });
      return originalList();
    });
    expect(await reconcilePin(f, provider, remote)).toEqual({ status: 'queue_changed' });
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.state.settings.cloudSyncAcceptedBase).toBeUndefined();
    expect(await f.queue()).toEqual({ status: 'provenance_review_required' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it.each(['cloud', 'state'])(
    'не заменяет прежнюю отметку при изменении %s после переноса подтверждённой очереди',
    async changed => {
      const f = await publicationFixture(provider);
      const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
      const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
      const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
      const { historyEnvelopePin, sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
      const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
      const first = await incomingVersion(f, provider, root, 'ПЕРВОЕ ВХОДЯЩЕЕ');
      expect((await reconcilePin(f, provider, first)).status).toBe('reconciled');
      const previousBase = structuredClone(f.state.settings.cloudSyncAcceptedBase);
      f.state.characters[0].notes = 'ПОДТВЕРЖДЁННЫЙ ЛОКАЛЬНЫЙ ОТВЕТ';
      await f.storage.saveNow();
      expect(await f.queue()).toEqual({ status: 'queued' });
      expect(await f.send()).toEqual({ status: 'sent_verified' });
      const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
      const own = await historyEnvelopePin({
        envelope: [...f.cloud.versions.values()].at(-1),
        expectedDatasetId: key.datasetId,
        cryptoSource: webcrypto
      });
      const second = await incomingVersion(f, provider, own, 'ВТОРОЕ ВХОДЯЩЕЕ');
      const payload = await decryptSnapshot({
        envelope: f.cloud.versions.get(second.versionId),
        recoveryKey: key.dataKey,
        expectedDatasetId: key.datasetId,
        cryptoSource: webcrypto
      });
      const later = await sealHistoryVersion({
        publicSnapshot: payload.publicSnapshot,
        parent: second,
        recoveryKey: key.dataKey,
        datasetId: key.datasetId,
        versionId: generateSyncId(webcrypto),
        keyBundle: key.bundle,
        keyPin: key.pin,
        cryptoSource: webcrypto
      });
      const originalList = f.cloud.session.listWithDates.getMockImplementation();
      let reads = 0;
      f.cloud.session.listWithDates.mockImplementation(async () => {
        if (++reads === 2) {
          if (changed === 'cloud') f.cloud.versions.set(later.pin.versionId, later.envelope);
          else {
            f.state.characters[0].notes = 'ИЗМЕНЕНИЕ ПОСЛЕ ЗАПИСИ ОЧЕРЕДИ';
            await f.storage.saveNow();
          }
        }
        return originalList();
      });
      const before = structuredClone(f.fake.queue(provider));
      expect(await reconcilePin(f, provider, second)).toEqual({ status: `${changed}_changed_after_queue` });
      expect(f.fake.queue(provider)).not.toEqual(before);
      expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
      expect(f.state.settings.cloudSyncAcceptedBase).toEqual(previousBase);
      expect(await f.queue()).toEqual({ status: 'provenance_review_required' });
      // Даже ошибочное ручное удаление marker не связывает старую отметку с новой очередью.
      delete f.state.settings.cloudSyncPendingApply;
      await f.storage.saveNow();
      expect(await f.queue()).toEqual({ status: 'accepted_base_mismatch' });
      expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    },
    30_000
  );

  it.each([
    ['prepared', 'not_sent', 'deferred'],
    ['attempting', 'unknown', 'verification_pending']
  ])(
    'сохраняет очередь %s при попытке принятия потомка',
    async (phase, uploadStatus, firstOutcome) => {
      const f = await publicationFixture(provider);
      const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
      const { openConnectedPublicationContext } = await import('../js/modules/cloudSync/connectedPublication.js');
      const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
      f.state.characters[0].notes = 'НЕОТПРАВЛЕННАЯ ПРАВКА';
      await f.storage.saveNow();
      expect(await f.queue()).toEqual({ status: 'queued' });
      // prepared означает точно не начатую запись, attempting — неизвестный исход.
      // В обоих случаях повторное принятие другой основы не должно терять запись.
      f.cloud.session.upload.mockResolvedValueOnce({ status: uploadStatus });
      expect(await f.send()).toEqual({ status: firstOutcome });
      const context = await openConnectedPublicationContext({
        provider,
        invoke: f.fake.invoke,
        cryptoSource: webcrypto
      });
      const head = await context.queue(f.cloud.session).inspectLinearHead(context.pins);
      expect(head.nextPhase).toBe(phase);
      const stored = structuredClone(f.fake.queue(provider));
      const remote = await incomingVersion(f, provider, root, 'ЧУЖАЯ ПРАВКА');
      expect(await reconcilePin(f, provider, remote)).toEqual({ status: 'queue_not_empty' });
      expect(f.fake.queue(provider)).toEqual(stored);
      expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
      expect(await f.send()).toEqual({
        status: phase === 'attempting' ? 'verification_pending' : 'provenance_review_required'
      });
      expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
      expect(f.fake.queue(provider)).toEqual(stored);
    },
    30_000
  );

  it('не уничтожает неотправленную локальную версию при попытке принятия потомка', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'НЕОТПРАВЛЕННАЯ ПРАВКА';
    await f.storage.saveNow();
    expect(await f.queue()).toEqual({ status: 'queued' });
    const stored = structuredClone(f.fake.queue(provider));
    const remote = await incomingVersion(f, provider, root, 'ЧУЖАЯ ПРАВКА');
    expect(await reconcilePin(f, provider, remote)).toEqual({ status: 'queue_not_empty' });
    expect(f.fake.queue(provider)).toEqual(stored);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(await f.send()).toEqual({ status: 'provenance_review_required' });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);
});

// Narrow merge: all providers here are synthetic, and the saved marker is not
// an atomic transaction with the native outbox or proof of complete cloud listing.
async function mergeIncoming(f, provider, parent, mutate) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
  const { sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const old = await decryptSnapshot({
    envelope: f.cloud.versions.get(parent.versionId),
    recoveryKey: key.dataKey,
    expectedDatasetId: key.datasetId,
    cryptoSource: webcrypto
  });
  const snapshot = structuredClone(old.publicSnapshot);
  mutate(snapshot);
  const next = await sealHistoryVersion({
    publicSnapshot: snapshot,
    parent,
    recoveryKey: key.dataKey,
    datasetId: key.datasetId,
    versionId: generateSyncId(webcrypto),
    keyBundle: key.bundle,
    keyPin: key.pin,
    cryptoSource: webcrypto
  });
  f.cloud.versions.set(next.pin.versionId, next.envelope);
  return next.pin;
}
async function mergePin(f, provider, pin, extra = {}) {
  const { reconcileConservativeMerge } = await import('../js/modules/cloudSync/reconcileConservativeMerge.js');
  return reconcileConservativeMerge({
    provider,
    invoke: f.fake.invoke,
    cryptoSource: webcrypto,
    pin,
    confirmed: true,
    openSession: f.cloud.openSession,
    ...extra
  });
}

async function inspectMergeQueue(f, provider) {
  const { openConnectedPublicationContext } = await import('../js/modules/cloudSync/connectedPublication.js');
  const context = await openConnectedPublicationContext({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto });
  return context.queue(f.cloud.session).inspectLinearHead(context.pins);
}
async function fakeQueueKey(f, provider) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state.dataKey;
  const saved = f.fake.queue(provider);
  const material = await webcrypto.subtle.importKey('raw', Buffer.from(key.slice(4), 'base64url'), 'HKDF', false, [
    'deriveBits'
  ]);
  const bits = await webcrypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('tvinoferma-durable-outbox-key-v1'),
      info: new TextEncoder().encode(JSON.stringify([saved.datasetId, saved.deviceId, saved.slotId]))
    },
    material,
    256
  );
  return `TF1-${Buffer.from(bits).toString('base64url')}`;
}
async function decodeFakeQueue(f, provider) {
  const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
  const saved = f.fake.queue(provider);
  return decryptSnapshot({
    envelope: JSON.parse(saved.record),
    recoveryKey: await fakeQueueKey(f, provider),
    expectedDatasetId: saved.datasetId,
    cryptoSource: webcrypto
  });
}
async function corruptFakeQueue(f, provider, mutate) {
  const { encryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
  const saved = f.fake.queue(provider);
  const plain = await decodeFakeQueue(f, provider);
  await mutate(plain);
  const encrypted = await encryptSnapshot({
    snapshot: plain,
    recoveryKey: await fakeQueueKey(f, provider),
    datasetId: saved.datasetId,
    versionId: saved.revisionId,
    cryptoSource: webcrypto
  });
  saved.record = JSON.stringify(encrypted);
  saved.sha256 = digest(saved.record);
}

describe.each(['google', 'yandex'])('%s: безопасное объединение существующих записей через fake IPC', provider => {
  it('сохраняет независимые локальные и облачные поля, резервные копии и затем отправляет объединённый потомок', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'НЕОТПРАВЛЕННАЯ ЛОКАЛЬНАЯ ЗАМЕТКА';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, snapshot => {
      snapshot.sections.characters.records[0].fields.level = 20;
    });
    const before = localStorage.getItem(STORAGE_KEY);
    const result = await mergePin(f, provider, remote);
    expect(result.status).toBe('merged');
    expect(result.newerHeadObserved).toBe(false);
    expect(f.state.characters[0]).toMatchObject({ notes: 'НЕОТПРАВЛЕННАЯ ЛОКАЛЬНАЯ ЗАМЕТКА', level: 20 });
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(f.state.characters[0].launch.gcPath).toBe('/private/path');
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.state.settings.cloudSyncAcceptedBase.pin).toEqual(remote);
    const backups = Object.keys(localStorage).filter(key => key.startsWith('tvinoferma_backup_'));
    expect(backups.some(key => localStorage.getItem(key) === before)).toBe(true);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect(await f.queue()).toEqual({ status: 'queued' });
    expect(await f.send()).toEqual({ status: 'sent_verified' });
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const sent = [...f.cloud.versions.values()].at(-1);
    const decoded = await decryptSnapshot({
      envelope: sent,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(decoded.parent).toEqual(remote);
    expect(decoded.publicSnapshot.sections.characters.records[0].fields).toMatchObject({
      notes: 'НЕОТПРАВЛЕННАЯ ЛОКАЛЬНАЯ ЗАМЕТКА',
      level: 20
    });
    for (const secret of ['PRIVATE_PASSWORD', 'НЕОТПРАВЛЕННАЯ ЛОКАЛЬНАЯ ЗАМЕТКА', '/private/path']) {
      expect(JSON.stringify(sent)).not.toContain(secret);
      expect(JSON.stringify(f.fake.queue(provider))).not.toContain(secret);
    }
    expect(JSON.stringify(decoded)).not.toContain('PRIVATE_PASSWORD');
  }, 30_000);

  it('сквозным сценарием объединяет существующие пати, марафон, задачу, финансы и выбранные настройки', async () => {
    const selections = ['appearance', 'planner'];
    const f = await publicationFixture(provider, {
      settingsSelections: selections,
      prepare: async f => {
        const { normalizeState } = await import('../js/core/state.js');
        const { createMarathon } = await import('../js/modules/marathons/model.js');
        const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
        const { ui, ...raw } = structuredClone({ ...f.state, ui: null });
        raw.parties = [{ id: 'party', name: 'Пати', order: 1 }];
        raw.characters[0].partyIds = ['party'];
        raw.characters[0].mainPartyId = 'party';
        raw.marathons = [
          createMarathon({
            id: 'marathon',
            title: 'Марафон',
            startDate: '2026-10-01',
            endDate: '2026-10-31',
            participantIds: ['hero'],
            lastSync: { at: '2026-10-02', errors: [{ error: 'PRIVATE_STATUS' }], changes: [] }
          })
        ];
        raw.finance = {
          operations: [
            { id: 'cash', date: '2026-10-30', kind: 'in', amount: 5, currency: 'coins', counterparty: 'Исходный' }
          ]
        };
        const { ui: ignored, ...normalized } = normalizeState(raw);
        Object.assign(f.state, planSyncIdentities({ snapshot: normalized, cryptoSource: webcrypto }).snapshot);
        await f.storage.saveNow();
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const lastSync = structuredClone(f.state.marathons[0].lastSync);
    f.state.characters[0].notes = 'МЕСТНАЯ ЗАМЕТКА';
    f.state.parties[0].color = '#abcdef';
    f.state.marathons[0].description = 'МЕСТНОЕ ОПИСАНИЕ';
    f.state.plannerEntries[0].priority = 'high';
    f.state.finance.operations[0].counterparty = 'МЕСТНЫЙ КОНТРАГЕНТ';
    f.state.settings.ui.plannerView = 'month';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, snapshot => {
      snapshot.sections.characters.records[0].fields.level = 42;
      snapshot.sections.parties.records[0].fields.name = 'Облачное имя';
      snapshot.sections.marathons.records.find(row => row.type === 'marathon').fields.title = 'Облачный марафон';
      snapshot.sections.planner.records[0].fields.status = 'done';
      snapshot.sections.finance.records.find(row => row.type === 'financeOperation').fields.note =
        'ОБЛАЧНАЯ ФИНАНСОВАЯ ЗАМЕТКА';
      snapshot.sections.finance.settings.opening.coins = 500;
      snapshot.sections.preferences.values.appearance.theme = 'light';
    });
    const merged = await mergePin(f, provider, remote, { settingsSelections: selections });
    expect(merged.status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'МЕСТНАЯ ЗАМЕТКА', level: 42 });
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(f.state.parties[0]).toMatchObject({ name: 'Облачное имя', color: '#abcdef' });
    expect(f.state.marathons[0]).toMatchObject({ title: 'Облачный марафон', description: 'МЕСТНОЕ ОПИСАНИЕ' });
    expect(f.state.marathons[0].lastSync).toEqual(lastSync);
    expect(f.state.plannerEntries[0]).toMatchObject({ priority: 'high', status: 'done' });
    expect(f.state.finance.operations[0]).toMatchObject({
      counterparty: 'МЕСТНЫЙ КОНТРАГЕНТ',
      note: 'ОБЛАЧНАЯ ФИНАНСОВАЯ ЗАМЕТКА'
    });
    expect(f.state.finance.settings.opening.coins).toBe(500);
    expect(f.state.settings.ui).toMatchObject({ theme: 'light', plannerView: 'month' });
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect(JSON.stringify(f.fake.queue(provider))).not.toContain('МЕСТНЫЙ КОНТРАГЕНТ');
    expect(JSON.stringify([...f.cloud.versions.values()])).not.toContain('PRIVATE_PASSWORD');
  }, 30_000);

  it('обновляет шаблон и добавляет вложенные элементы, сохраняя местные ID', async () => {
    const f = await publicationFixture(provider, {
      prepare: async f => {
        const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
        f.state.marathonTemplates.push({
          id: 'template',
          name: 'Старое имя',
          tasks: [
            {
              id: 'local-task',
              title: 'Исходное',
              rewards: [{ id: 'local-reward', threshold: 1, rewardText: 'Награда' }]
            }
          ],
          bonuses: [{ id: 'local-bonus', needTasks: 1, text: 'Бонус' }]
        });
        const { ui, ...snapshot } = f.state;
        Object.assign(f.state, planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot);
        await f.storage.saveNow();
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'НЕЗАВИСИМО ЛОКАЛЬНО';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      const template = s.sections.marathons.records.find(row => row.type === 'marathonTemplate');
      template.fields.name = 'Новое имя';
      const newTask = structuredClone(template.fields.tasks[0]);
      newTask.title = 'Новое задание';
      template.fields.tasks.push(newTask);
      template.fields.bonuses.push({ needTasks: 2, text: 'Новый бонус' });
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    const result = f.state.marathonTemplates[0];
    expect(result.name).toBe('Новое имя');
    expect(result.tasks[0].id).toBe('local-task');
    expect(result.tasks[0].rewards[0].id).toBe('local-reward');
    expect(result.bonuses[0].id).toBe('local-bonus');
    expect(result.tasks[1].title).toBe('Новое задание');
    expect(result.tasks[1].id).not.toBe('local-task');
    expect(result.bonuses[1].text).toBe('Новый бонус');
    expect(f.state.characters[0].notes).toBe('НЕЗАВИСИМО ЛОКАЛЬНО');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('передаёт новый шаблон и связанный с ним марафон с местными идентификаторами', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
    const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
    const { createMarathon } = await import('../js/modules/marathons/model.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const { ui, ...baseState } = f.state;
    const remoteState = structuredClone(baseState);
    remoteState.marathonTemplates.push({
      id: 'remote-template',
      name: 'Шаблон с облака',
      tasks: [{ id: 'rt', title: 'Задание', rewards: [{ id: 'rr', threshold: 1, rewardText: 'Награда' }] }],
      bonuses: []
    });
    remoteState.marathons.push(
      createMarathon({
        id: 'remote-marathon',
        title: 'Марафон из шаблона',
        source: { type: 'template', templateId: 'remote-template' },
        startDate: '2026-10-01',
        endDate: '2026-10-31'
      })
    );
    const planned = planSyncIdentities({ snapshot: remoteState, cryptoSource: webcrypto }).snapshot;
    const remoteSnapshot = buildPublicSnapshot(planned, { settingsSelections: [] });
    const template = remoteSnapshot.sections.marathons.records.find(row => row.type === 'marathonTemplate');
    const marathon = remoteSnapshot.sections.marathons.records.find(row => row.type === 'marathon');
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ ЗАМЕТКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.marathons.records.push(structuredClone(template), structuredClone(marathon));
      s.sections.marathons.order.templates.push(template.id);
      s.sections.marathons.order.marathons.push(marathon.id);
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    const applied = f.state.marathonTemplates.find(row => row.name === 'Шаблон с облака');
    expect(applied.tasks[0].rewards[0].rewardText).toBe('Награда');
    expect(f.state.marathons[0].source.templateId).toBe(applied.id);
    expect(f.state.characters[0].notes).toBe('ЛОКАЛЬНАЯ ЗАМЕТКА');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('передаёт новые записи истории монет и характеристик, добавленные сверху', async () => {
    const f = await publicationFixture(provider, {
      prepare: async f => {
        const { applyCoinBalance } = await import('../js/core/coins.js');
        const { rememberStatsBefore } = await import('../js/modules/characters/statsHistory.js');
        const character = f.state.characters[0];
        applyCoinBalance(character, 100, { now: '2026-10-01T00:00:00.000Z' });
        const previous = structuredClone(character.stats);
        character.stats.strength = 1;
        rememberStatsBefore(character, previous, '2026-10-01T00:00:00.000Z');
        await f.storage.saveNow();
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'НЕЗАВИСИМАЯ МЕСТНАЯ ЗАМЕТКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      const fields = s.sections.characters.records[0].fields;
      fields.coinHistory.unshift({
        id: 'cloud-entry',
        date: '2026-10-02T00:00:00.000Z',
        delta: 100,
        balanceAfter: 200,
        note: 'Изменение'
      });
      fields.ancientCoins = 200;
      fields.lastCoinUpdate = '2026-10-02T00:00:00.000Z';
      fields.statsHistory.unshift({ at: '2026-10-02T00:00:00.000Z', stats: structuredClone(fields.stats) });
      fields.stats.strength = 2;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({
      notes: 'НЕЗАВИСИМАЯ МЕСТНАЯ ЗАМЕТКА',
      ancientCoins: 200,
      stats: { strength: 2 }
    });
    expect(f.state.characters[0].coinHistory).toHaveLength(2);
    expect(f.state.characters[0].statsHistory).toHaveLength(2);
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('сквозным сценарием сохраняет независимые правки разных заданий и наград марафона', async () => {
    const f = await publicationFixture(provider, {
      prepare: async f => {
        const { createMarathon } = await import('../js/modules/marathons/model.js');
        const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
        f.state.marathons = [
          createMarathon({
            id: 'marathon',
            title: 'Марафон',
            startDate: '2026-10-01',
            endDate: '2026-10-31',
            tasks: [
              { id: 'a', title: 'Первое', rewards: [{ id: 'ra', threshold: 1, rewardText: 'Старое' }] },
              { id: 'b', title: 'Второе', rewards: [{ id: 'rb', threshold: 1, rewardText: 'Сундук' }] }
            ]
          })
        ];
        const { ui, ...snapshot } = f.state;
        Object.assign(f.state, planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot);
        await f.storage.saveNow();
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.marathons[0].tasks[0].targetChecks = 3;
    f.state.marathons[0].tasks[0].rewards[0].rewardCoins = 10;
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      const tasks = s.sections.marathons.records.find(row => row.type === 'marathon').fields.tasks;
      tasks[1].title = 'Новое облачное название';
      tasks[1].rewards[0].rewardText = 'Новая облачная награда';
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.marathons[0].tasks[0].targetChecks).toBe(3);
    expect(f.state.marathons[0].tasks[0].rewards[0].rewardCoins).toBe(10);
    expect(f.state.marathons[0].tasks[1].title).toBe('Новое облачное название');
    expect(f.state.marathons[0].tasks[1].rewards[0].rewardText).toBe('Новая облачная награда');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('объединяет данные прогресса сайта с местными правками и публикует их в зашифрованном потомке', async () => {
    const f = await publicationFixture(provider, {
      prepare: async f => {
        f.state.characters[0].marathonData = {
          lastSyncDate: '2026-10-29',
          quests: [{ title: 'Задание сайта', description: 'Проверка', completed: 0, total: 2, percentage: 0 }],
          summary: { completed: 0, total: 2, percentage: 0 }
        };
        await f.storage.saveNow();
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ДРУГАЯ МЕСТНАЯ ПРАВКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      const progress = s.sections.characters.records[0].fields.marathonData;
      progress.lastSyncDate = '2026-10-30';
      progress.quests[0].completed = 1;
      progress.quests[0].percentage = 50;
      progress.summary.completed = 1;
      progress.summary.percentage = 50;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.characters[0].notes).toBe('ДРУГАЯ МЕСТНАЯ ПРАВКА');
    expect(f.state.characters[0].marathonData.quests[0].completed).toBe(1);
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const sent = [...f.cloud.versions.values()].at(-1);
    const payload = await decryptSnapshot({
      envelope: sent,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.publicSnapshot.sections.characters.records[0].fields.marathonData.summary.percentage).toBe(50);
    expect(payload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('ДРУГАЯ МЕСТНАЯ ПРАВКА');
    expect(JSON.stringify(sent)).not.toContain('ДРУГАЯ МЕСТНАЯ ПРАВКА');
  }, 30_000);

  it('конфликт одного поля не меняет state, очередь и не создаёт marker', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'ОБЛАЧНАЯ';
    });
    const before = localStorage.getItem(STORAGE_KEY);
    const queue = structuredClone(f.fake.queue(provider));
    expect(await mergePin(f, provider, remote)).toMatchObject({ status: 'conflicts', conflictCount: 1 });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it.each(['cloud', 'local'])(
    'разрешает конфликт по явному выбору %s и сохраняет независимые правки',
    async side => {
      const f = await publicationFixture(provider);
      const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
      const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
      f.state.characters[0].notes = 'КОНФЛИКТ ЛОКАЛЬНЫЙ';
      f.state.characters[0].level = 32;
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      const remote = await mergeIncoming(f, provider, root, s => {
        s.sections.characters.records[0].fields.notes = 'КОНФЛИКТ ОБЛАЧНЫЙ';
        s.sections.characters.records[0].fields.favorite = true;
      });
      const pending = await mergePin(f, provider, remote);
      expect(pending).toMatchObject({
        status: 'conflicts',
        conflictCount: 1,
        reviewHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      });
      expect(JSON.stringify(pending)).not.toContain('КОНФЛИКТ ЛОКАЛЬНЫЙ');
      expect(JSON.stringify(pending)).not.toContain('КОНФЛИКТ ОБЛАЧНЫЙ');
      const resolution = {
        reviewHash: pending.reviewHash,
        cloudRecords: side === 'cloud' ? [{ section: 'characters', id: f.state.characters[0].syncId }] : [],
        cloudSettings: [],
        cloudFinanceSettings: false
      };
      const outcome = await mergePin(f, provider, remote, { resolution });
      expect(outcome.status).toBe('merged');
      expect(f.state.characters[0]).toMatchObject({
        notes: side === 'cloud' ? 'КОНФЛИКТ ОБЛАЧНЫЙ' : 'КОНФЛИКТ ЛОКАЛЬНЫЙ',
        level: 32,
        favorite: true
      });
      expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
      expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
      expect((await inspectMergeQueue(f, provider)).retainedIntents).toHaveLength(1);
      expect((await f.queue()).status).toBe('queued');
      expect((await f.send()).status).toBe('sent_verified');
    },
    30_000
  );

  it('выбирает источник отдельно для двух конфликтующих персонажей и финансовых настроек', async () => {
    const f = await publicationFixture(provider, {
      prepare: async f => {
        const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
        const second = structuredClone(f.state.characters[0]);
        second.id = 'second';
        second.nick = 'Второй персонаж';
        delete second.syncId;
        f.state.characters.push(second);
        const { ui, ...snapshot } = f.state;
        Object.assign(f.state, planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot);
        await f.storage.saveNow();
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ПЕРВОЕ МЕСТНОЕ';
    f.state.characters[1].notes = 'ВТОРОЕ МЕСТНОЕ';
    f.state.characters[1].level = 23;
    f.state.finance.settings.goldRate = 2;
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'ПЕРВОЕ ОБЛАЧНОЕ';
      s.sections.characters.records[1].fields.notes = 'ВТОРОЕ ОБЛАЧНОЕ';
      s.sections.characters.records[0].fields.favorite = true;
      s.sections.finance.settings.goldRate = 3;
    });
    const pending = await mergePin(f, provider, remote);
    expect(pending).toMatchObject({ status: 'conflicts', conflictCount: 3 });
    const resolution = {
      reviewHash: pending.reviewHash,
      cloudRecords: [{ section: 'characters', id: f.state.characters[0].syncId }],
      cloudSettings: [],
      cloudFinanceSettings: true
    };
    expect((await mergePin(f, provider, remote, { resolution })).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'ПЕРВОЕ ОБЛАЧНОЕ', favorite: true });
    expect(f.state.characters[1]).toMatchObject({ notes: 'ВТОРОЕ МЕСТНОЕ', level: 23 });
    expect(f.state.finance.settings.goldRate).toBe(3);
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('не применяет выбор конфликтов после изменения локального состояния или очереди', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СНАЧАЛА ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'ОБЛАЧНАЯ';
    });
    const pending = await mergePin(f, provider, remote);
    expect(pending.status).toBe('conflicts');
    const resolution = {
      reviewHash: pending.reviewHash,
      cloudRecords: [{ section: 'characters', id: f.state.characters[0].syncId }],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    f.state.characters[0].notes = 'УЖЕ ДРУГАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const queueBefore = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote, { resolution })).status).toBe('conflicts_changed');
    expect(f.state.characters[0].notes).toBe('УЖЕ ДРУГАЯ ЛОКАЛЬНАЯ');
    expect(f.fake.queue(provider)).toEqual(queueBefore);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    const refreshed = await mergePin(f, provider, remote);
    expect(refreshed.status).toBe('conflicts');
    expect((await f.queue()).status).toBe('queued');
    expect(
      (await mergePin(f, provider, remote, { resolution: { ...resolution, reviewHash: refreshed.reviewHash } })).status
    ).toBe('conflicts_changed');
  }, 30_000);

  it('не разрешает старый конфликт при новой облачной голове или при чужом выборе записи', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'МЕСТНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'ОБЛАЧНАЯ';
    });
    const pending = await mergePin(f, provider, remote);
    const resolution = {
      reviewHash: pending.reviewHash,
      cloudRecords: [{ section: 'characters', id: generateSyncId(webcrypto) }],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    const before = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote, { resolution })).status).toBe('conflicts_changed');
    expect(f.fake.queue(provider)).toEqual(before);
    const child = await mergeIncoming(f, provider, remote, s => {
      s.sections.characters.records[0].fields.favorite = true;
    });
    expect((await mergePin(f, provider, remote, { resolution: { ...resolution, cloudRecords: [] } })).status).toBe(
      'not_unique_head'
    );
    expect(child.versionId).not.toBe(remote.versionId);
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30_000);

  it('подмена сохранённого выбора конфликта после потери ответа не позволяет продолжить', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'МЕСТНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'ОБЛАЧНАЯ';
    });
    const pending = await mergePin(f, provider, remote);
    const resolution = {
      reviewHash: pending.reviewHash,
      cloudRecords: [],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, remote, { resolution })).status).toBe('journal_uncertain');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    state.settings.cloudSyncPendingMerge.resolution.cloudRecords = [
      { section: 'characters', id: state.characters[0].syncId }
    ];
    const { saveNow } = await import('../js/core/storage.js');
    await saveNow();
    const before = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote)).status).toBe('merge_intent_mismatch');
    expect(f.fake.queue(provider)).toEqual(before);
    expect(state.characters[0].notes).toBe('МЕСТНАЯ');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('после потери ответа продолжает решение конфликта с прежним выбором, а не меняет его', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СОХРАНИТЬ В МЕСТНОМ ВАРИАНТЕ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'НЕ ВЫБИРАТЬ ОБЛАЧНОЕ';
    });
    const pending = await mergePin(f, provider, remote);
    const resolution = {
      reviewHash: pending.reviewHash,
      cloudRecords: [],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, remote, { resolution })).status).toBe('journal_uncertain');
    expect(f.state.settings.cloudSyncPendingMerge).toMatchObject({ version: 2, resolution });
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    expect(
      (
        await mergePin(f, provider, remote, {
          resolution: { ...resolution, cloudRecords: [{ section: 'characters', id: state.characters[0].syncId }] }
        })
      ).status
    ).toBe('merge_intent_mismatch');
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(state.characters[0].notes).toBe('СОХРАНИТЬ В МЕСТНОМ ВАРИАНТЕ');
    expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30_000);

  it('сохраняет старое зашифрованное намерение очереди до подтверждения нового потомка', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'В ОЧЕРЕДИ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const prior = await inspectMergeQueue(f, provider);
    const oldIntent = (await decodeFakeQueue(f, provider)).entries.at(-1);
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 30;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    const retained = await decodeFakeQueue(f, provider);
    expect(retained.version).toBe(5);
    expect(retained.entries[0].retainedPending).toEqual([oldIntent]);
    let head = await inspectMergeQueue(f, provider);
    expect(head.retainedPendingPin).toEqual(prior.nextPin);
    expect(head.retainedPendingPhase).toBe('queued');
    expect(f.state.characters[0]).toMatchObject({ notes: 'В ОЧЕРЕДИ', level: 30 });
    expect(JSON.stringify(f.fake.queue(provider))).not.toContain('В ОЧЕРЕДИ');
    expect((await f.queue()).status).toBe('queued');
    head = await inspectMergeQueue(f, provider);
    expect(head.retainedPendingPin).toEqual(prior.nextPin);
    expect((await f.send()).status).toBe('sent_verified');
    head = await inspectMergeQueue(f, provider);
    expect(head.retainedPendingPin).toBeNull();
    expect((await decodeFakeQueue(f, provider)).version).toBe(4);
    expect(head.confirmedPin).not.toEqual(remote);
  }, 30_000);

  it('переносит несколько ещё не отправленных намерений через последовательные облачные изменения', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ПЕРВАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const firstIntent = (await decodeFakeQueue(f, provider)).entries.at(-1);
    const first = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 40;
    });
    expect((await mergePin(f, provider, first)).status).toBe('merged');
    expect((await f.queue()).status).toBe('queued');
    const secondIntent = (await decodeFakeQueue(f, provider)).entries.at(-1);
    const newer = await mergeIncoming(f, provider, first, s => {
      s.sections.characters.records[0].fields.favorite = true;
    });
    const merged = await mergePin(f, provider, newer);
    expect(merged.status).toBe('merged');
    const retained = await decodeFakeQueue(f, provider);
    expect(retained.version).toBe(5);
    expect(retained.entries[0].retainedPending).toEqual([firstIntent, secondIntent]);
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toHaveLength(2);
    expect(f.state.characters[0]).toMatchObject({ notes: 'ПЕРВАЯ ЛОКАЛЬНАЯ', level: 40, favorite: true });
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
    expect((await decodeFakeQueue(f, provider)).version).toBe(4);
  }, 30_000);

  it('не меняет очередь и состояние, если не удалось создать копию перед объединением', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СОХРАНИТЬ ЛОКАЛЬНО';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 29;
    });
    const beforeState = localStorage.getItem(STORAGE_KEY);
    const beforeQueue = structuredClone(f.fake.queue(provider));
    const set = Storage.prototype.setItem;
    const failBackup = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (String(key).startsWith('tvinoferma_backup_')) throw new Error('PRIVATE backup failure');
      return set.call(this, key, value);
    });
    try {
      const result = await mergePin(f, provider, remote);
      expect(result.status).toBe('backup_unconfirmed_restart');
      expect(localStorage.getItem(STORAGE_KEY)).toBe(beforeState);
      expect(f.fake.queue(provider)).toEqual(beforeQueue);
      expect(f.state.characters[0].notes).toBe('СОХРАНИТЬ ЛОКАЛЬНО');
      expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
      expect(f.cloud.session.upload).not.toHaveBeenCalled();
    } finally {
      failBackup.mockRestore();
    }
  }, 30_000);

  it('после объединения сохраняет последующие локальные правки и исходное намерение до подтверждения', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СТАРАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const original = (await decodeFakeQueue(f, provider)).entries.at(-1);
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 41;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    f.state.characters[0].notes = 'НОВАЯ ЛОКАЛЬНАЯ ПОСЛЕ ОБЪЕДИНЕНИЯ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    expect((await decodeFakeQueue(f, provider)).entries[0].retainedPending).toEqual([original]);
    expect((await f.send()).status).toBe('sent_verified');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const sent = [...f.cloud.versions.values()].at(-1);
    const payload = await decryptSnapshot({
      envelope: sent,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.parent).toEqual(remote);
    expect(payload.publicSnapshot.sections.characters.records[0].fields).toMatchObject({
      notes: 'НОВАЯ ЛОКАЛЬНАЯ ПОСЛЕ ОБЪЕДИНЕНИЯ',
      level: 41
    });
    expect((await decodeFakeQueue(f, provider)).version).toBe(4);
  }, 30_000);

  it('после перезапуска читает очередь v5 и отправляет объединённые данные, не теряя прежнюю запись', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СОХРАНИТЬ ПОСЛЕ ПЕРЕЗАПУСКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const original = (await decodeFakeQueue(f, provider)).entries.at(-1);
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 44;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect((await decodeFakeQueue(f, provider)).entries[0].retainedPending).toEqual([original]);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { queueConnectedSavedSnapshot, sendConnectedQueuedSnapshot } =
      await import('../js/modules/cloudSync/connectedPublication.js');
    expect(
      (
        await queueConnectedSavedSnapshot({
          provider,
          invoke: f.fake.invoke,
          prepareIdentities: true,
          cryptoSource: webcrypto
        })
      ).status
    ).toBe('queued');
    expect(
      (
        await sendConnectedQueuedSnapshot({
          provider,
          invoke: f.fake.invoke,
          openSession: f.cloud.openSession,
          cryptoSource: webcrypto
        })
      ).status
    ).toBe('sent_verified');
    expect(state.characters[0]).toMatchObject({ notes: 'СОХРАНИТЬ ПОСЛЕ ПЕРЕЗАПУСКА', level: 44 });
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const payload = await decryptSnapshot({
      envelope: [...f.cloud.versions.values()].at(-1),
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.parent).toEqual(remote);
    expect(payload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('СОХРАНИТЬ ПОСЛЕ ПЕРЕЗАПУСКА');
    expect((await decodeFakeQueue(f, provider)).version).toBe(4);
  }, 30_000);

  it('останавливается на 16 сохранённых намерениях, не уничтожая ни одно и не меняя state', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    let parent = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    for (let index = 0; index < 16; index++) {
      f.state.characters[0].notes = `ЛОКАЛЬНАЯ ${index}`;
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      const next = await mergeIncoming(f, provider, parent, s => {
        s.sections.characters.records[0].fields.level = 20 + index;
      });
      expect((await mergePin(f, provider, next)).status).toBe('merged');
      parent = next;
    }
    const retained = (await decodeFakeQueue(f, provider)).entries[0].retainedPending;
    expect(retained).toHaveLength(16);
    f.state.characters[0].notes = 'СЕМНАДЦАТАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const next = await mergeIncoming(f, provider, parent, s => {
      s.sections.characters.records[0].fields.level = 50;
    });
    const queue = structuredClone(f.fake.queue(provider));
    const before = localStorage.getItem(STORAGE_KEY);
    expect((await mergePin(f, provider, next)).status).toBe('retained_intent_limit');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect((await decodeFakeQueue(f, provider)).entries[0].retainedPending).toEqual(retained);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 120_000);

  it('подтверждает прежнее намерение новым зашифрованным потомком даже при полном совпадении результата', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ОДИНАКОВОЕ ИЗМЕНЕНИЕ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'ОДИНАКОВОЕ ИЗМЕНЕНИЕ';
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toHaveLength(1);
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
  }, 30_000);

  it('сохраняет подготовленное, но не начатое намерение и его адрес до подтверждённой новой отправки', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ПОДГОТОВЛЕННАЯ ПРАВКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    expect((await f.send()).status).toBe('deferred');
    const prior = await inspectMergeQueue(f, provider);
    const oldIntent = (await decodeFakeQueue(f, provider)).entries.at(-1);
    expect(prior.nextPhase).toBe('prepared');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 28;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    const after = await inspectMergeQueue(f, provider);
    expect(after.retainedPendingPin).toEqual(prior.nextPin);
    expect(after.retainedPendingPhase).toBe('prepared');
    expect((await decodeFakeQueue(f, provider)).entries[0].retainedPending).toEqual([oldIntent]);
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await inspectMergeQueue(f, provider)).retainedPendingPin).toBeNull();
  }, 30_000);

  it('не переносит уже начатую попытку с неизвестным исходом', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'НАЧАТАЯ ПОПЫТКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.loseNextUpload();
    f.cloud.setVerify(false);
    expect((await f.send()).status).toBe('verification_pending');
    expect((await inspectMergeQueue(f, provider)).nextPhase).toBe('attempting');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 29;
    });
    const queue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote)).status).toBe('queue_not_empty');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('не переносит устаревшее намерение, пока оно не соответствует текущему сохранению', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СТАРАЯ В ОЧЕРЕДИ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.state.characters[0].notes = 'НОВАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 31;
    });
    const queue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote)).status).toBe('queue_snapshot_mismatch');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect((await f.queue()).status).toBe('coalesced');
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'НОВАЯ ЛОКАЛЬНАЯ', level: 31 });
  }, 30_000);

  it('при потере ответа сохраняет старое шифрованное намерение и повторяет только после перезапуска', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЗАЩИЩЁННАЯ ОЧЕРЕДЬ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const prior = await inspectMergeQueue(f, provider);
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 32;
    });
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, remote)).status).toBe('journal_uncertain');
    expect(f.state.settings.cloudSyncPendingMerge).toMatchObject({ pendingPin: prior.nextPin, pendingPhase: 'queued' });
    const after = structuredClone(f.fake.queue(provider));
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    expect((await inspectMergeQueue(f, provider)).retainedPendingPin).toEqual(prior.nextPin);
    const { cancelPendingConservativeMerge } = await import('../js/modules/cloudSync/reconcileConservativeMerge.js');
    expect(
      (
        await cancelPendingConservativeMerge({
          provider,
          invoke: f.fake.invoke,
          cryptoSource: webcrypto,
          confirmed: true
        })
      ).status
    ).toBe('already_anchored');
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.fake.queue(provider)).toEqual(after);
    expect(state.characters[0]).toMatchObject({ notes: 'ЗАЩИЩЁННАЯ ОЧЕРЕДЬ', level: 32 });
  }, 30_000);

  it('не убирает прежнее намерение при неподтверждённом чтении новой отправки', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ ОЧЕРЕДЬ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const prior = await inspectMergeQueue(f, provider);
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 34;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect((await f.queue()).status).toBe('queued');
    f.cloud.loseNextUpload();
    f.cloud.setVerify(false);
    expect((await f.send()).status).toBe('verification_pending');
    const uncertain = await inspectMergeQueue(f, provider);
    expect(uncertain.nextPhase).toBe('attempting');
    expect(uncertain.retainedPendingPin).toEqual(prior.nextPin);
    expect((await decodeFakeQueue(f, provider)).version).toBe(5);
    f.cloud.setVerify(true);
    expect((await f.send()).status).toBe('verified_previous_attempt');
    expect((await inspectMergeQueue(f, provider)).retainedPendingPin).toBeNull();
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('после неизвестного ответа подтверждения не повторяет новую отправку и не теряет состояние', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СОХРАНЁННАЯ ПРАВКА';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 35;
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect((await f.queue()).status).toBe('queued');
    const verify = f.cloud.session.verify.getMockImplementation();
    f.cloud.session.verify.mockImplementationOnce(async value => {
      const answer = await verify(value);
      f.fake.loseNextCompare();
      return answer;
    });
    expect((await f.send()).status).toBe('journal_uncertain');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { sendConnectedQueuedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    expect(
      (
        await sendConnectedQueuedSnapshot({
          provider,
          invoke: f.fake.invoke,
          cryptoSource: webcrypto,
          openSession: f.cloud.openSession
        })
      ).status
    ).toBe('idle');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    expect(state.characters[0]).toMatchObject({ notes: 'СОХРАНЁННАЯ ПРАВКА', level: 35 });
  }, 30_000);

  it.each(['missing', 'attempting', 'duplicate', 'ciphertext', 'wrong_parent'])(
    'повреждение сохранённого намерения %s закрывает очередь без отправки',
    async fault => {
      const f = await publicationFixture(provider);
      const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
      const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
      f.state.characters[0].notes = 'ЗАЩИЩЁННЫЙ ЛОКАЛЬНЫЙ ТЕКСТ';
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      const remote = await mergeIncoming(f, provider, root, s => {
        s.sections.characters.records[0].fields.level = 33;
      });
      expect((await mergePin(f, provider, remote)).status).toBe('merged');
      const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
      const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
      const { sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
      const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
      const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
      const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
      await corruptFakeQueue(f, provider, async queue => {
        const adopted = queue.entries[0];
        if (fault === 'missing') delete adopted.retainedPending;
        if (fault === 'attempting') {
          adopted.retainedPending[0].phase = 'attempting';
          adopted.retainedPending[0].attemptId = generateSyncId(webcrypto);
        }
        if (fault === 'duplicate') adopted.retainedPending[0].envelope = structuredClone(adopted.envelope);
        if (fault === 'ciphertext') {
          const text = adopted.retainedPending[0].envelope.ciphertext;
          adopted.retainedPending[0].envelope.ciphertext = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
        }
        if (fault === 'wrong_parent') {
          const sealed = await sealHistoryVersion({
            publicSnapshot: buildPublicSnapshot(currentCloudStateSnapshot()),
            parent: { versionId: generateSyncId(webcrypto), sha256: 'e'.repeat(64) },
            recoveryKey: key.dataKey,
            datasetId: key.datasetId,
            versionId: generateSyncId(webcrypto),
            keyBundle: key.bundle,
            keyPin: key.pin,
            cryptoSource: webcrypto
          });
          adopted.retainedPending[0].envelope = sealed.envelope;
        }
      });
      const queueBefore = structuredClone(f.fake.queue(provider));
      expect((await inspectMergeQueue(f, provider)).status).toBe('journal_blocked');
      expect((await f.queue()).status).toBe('journal_blocked');
      expect(f.fake.queue(provider)).toEqual(queueBefore);
      expect(f.cloud.session.upload).not.toHaveBeenCalled();
    },
    30_000
  );

  it('сквозное объединение добавленных записей сохраняет локальную очередь и их связи', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'МЕСТНЫЙ ТЕКСТ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      const added = structuredClone(s.sections.characters.records[0]);
      added.id = generateSyncId(webcrypto);
      added.fields.nick = 'Новый персонаж';
      s.sections.characters.records.push(added);
      s.sections.characters.order.active.push(added.id);
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.characters.map(row => row.nick)).toEqual(['ЛИЧНЫЙ ПЕРСОНАЖ', 'Новый персонаж']);
    expect(f.state.characters[0].notes).toBe('МЕСТНЫЙ ТЕКСТ');
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(f.state.characters[1].contacts.password).not.toBe('PRIVATE_PASSWORD');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const stored = [...f.cloud.versions.values()].at(-1);
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const payload = await decryptSnapshot({
      envelope: stored,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.publicSnapshot.sections.characters.records.map(row => row.fields.nick)).toEqual([
      'ЛИЧНЫЙ ПЕРСОНАЖ',
      'Новый персонаж'
    ]);
    expect(payload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('МЕСТНЫЙ ТЕКСТ');
  }, 30_000);

  it('после автономного добавления персонажей на обоих ПК сохраняет обе записи и отправляет результат', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const local = structuredClone(f.state.characters[0]);
    local.id = 'LOCAL_NEW_CHARACTER';
    local.nick = 'Добавлен на этом ПК';
    delete local.syncId;
    f.state.characters.push(local);
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const localId = f.state.characters[1].syncId;
    const remote = await mergeIncoming(f, provider, root, s => {
      const added = structuredClone(s.sections.characters.records[0]);
      added.id = generateSyncId(webcrypto);
      added.fields.nick = 'Добавлен на другом ПК';
      s.sections.characters.records.push(added);
      s.sections.characters.order.active.push(added.id);
    });
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.characters.map(row => row.nick)).toEqual([
      'ЛИЧНЫЙ ПЕРСОНАЖ',
      'Добавлен на этом ПК',
      'Добавлен на другом ПК'
    ]);
    expect(f.state.characters[1].syncId).toBe(localId);
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(f.state.characters[2].contacts.password).not.toBe('PRIVATE_PASSWORD');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const payload = await decryptSnapshot({
      envelope: [...f.cloud.versions.values()].at(-1),
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(payload.publicSnapshot.sections.characters.records.map(row => row.fields.nick)).toEqual([
      'ЛИЧНЫЙ ПЕРСОНАЖ',
      'Добавлен на этом ПК',
      'Добавлен на другом ПК'
    ]);
    expect(payload.parent).toEqual(remote);
  }, 30_000);

  it('блокирует исчезновение и возвращение добавленной записи в промежуточной истории', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'МЕСТНАЯ';
    await f.storage.saveNow();
    let added;
    const first = await mergeIncoming(f, provider, root, s => {
      added = structuredClone(s.sections.characters.records[0]);
      added.id = generateSyncId(webcrypto);
      added.fields.nick = 'Вернувшийся';
      s.sections.characters.records.push(structuredClone(added));
      s.sections.characters.order.active.push(added.id);
    });
    const missing = await mergeIncoming(f, provider, first, s => {
      s.sections.characters.records.pop();
      s.sections.characters.order.active.pop();
    });
    const restored = await mergeIncoming(f, provider, missing, s => {
      s.sections.characters.records.push(structuredClone(added));
      s.sections.characters.order.active.push(added.id);
    });
    const queue = structuredClone(f.fake.queue(provider));
    const result = await mergePin(f, provider, restored);
    expect(result.status).toBe('deletions_unsupported');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.characters).toHaveLength(1);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30_000);

  it('не переносит основу по неподтверждённому или скопированному доказательству без сохранённой отметки', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { prepareCloudReview } = await import('../js/modules/cloudSync/cloudReview.js');
    const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
    const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
    const { openConnectedPublicationContext } = await import('../js/modules/cloudSync/connectedPublication.js');
    const { authorizeSavedConservativeMerge } =
      await import('../js/modules/cloudSync/conservativeMergeAuthorization.js');
    const binding = parseDatasetBindingRecord(f.fake.pin(provider)).binding;
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    f.state.characters[0].notes = 'МЕСТНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, binding.rootPin, s => {
      s.sections.characters.records[0].fields.level = 36;
    });
    const review = await prepareCloudReview({
      provider,
      session: f.cloud.session,
      datasetId: key.datasetId,
      dataKey: key.dataKey,
      rootPin: binding.rootPin,
      knownPins: [binding.rootPin],
      localSnapshot: buildPublicSnapshot(currentCloudStateSnapshot()),
      localSavedAt: null,
      cryptoSource: webcrypto
    });
    const proof = review.prepareConservativeAdoption(remote, binding.rootPin, f.state.settings);
    expect(proof.status).toBe('ready_for_adoption');
    expect(await authorizeSavedConservativeMerge({ proof, cryptoSource: webcrypto })).toBeNull();
    const context = await openConnectedPublicationContext({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto });
    const queue = context.queue(f.cloud.session);
    const before = structuredClone(f.fake.queue(provider));
    await expect(queue.adoptReviewedBase({ ...context.pins, proof })).rejects.toThrow();
    await expect(
      queue.adoptReviewedBase({ ...context.pins, proof, authorization: { proof, marker: {} } })
    ).rejects.toThrow();
    await expect(
      queue.adoptReviewedBase({ ...context.pins, proof: { ...proof }, authorization: {} })
    ).rejects.toThrow();
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30_000);

  it('изменённый хеш сохранённого намерения не позволяет продолжить или отправить', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 37;
    });
    const rejectCompare = async (command, args) =>
      command === 'cloud_outbox_compare_exchange' ? { status: 'mismatch' } : f.fake.invoke(command, args);
    expect((await mergePin(f, provider, remote, { invoke: rejectCompare })).status).toBe('changed');
    f.state.settings.cloudSyncPendingMerge.localHash = 'e'.repeat(64);
    await f.storage.saveNow();
    const queue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote)).status).toBe('merge_intent_mismatch');
    expect((await f.queue()).status).toBe('provenance_review_required');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('до изменения очереди позволяет безопасно отменить намерение с сохранением локальных правок', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ ПРАВКА';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 11;
    });
    const queue = structuredClone(f.fake.queue(provider));
    const rejectCompare = async (command, args) =>
      command === 'cloud_outbox_compare_exchange' ? { status: 'mismatch' } : f.fake.invoke(command, args);
    expect(await mergePin(f, provider, remote, { invoke: rejectCompare })).toEqual({ status: 'changed' });
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.settings.cloudSyncPendingMerge).toBeTruthy();
    const { cancelPendingConservativeMerge } = await import('../js/modules/cloudSync/reconcileConservativeMerge.js');
    const cancel = await cancelPendingConservativeMerge({
      provider,
      invoke: f.fake.invoke,
      cryptoSource: webcrypto,
      confirmed: true
    });
    expect(cancel.status).toBe('merge_cancelled');
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.state.characters[0].notes).toBe('ЛОКАЛЬНАЯ ПРАВКА');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('не разрешает отмену после изменения очереди и восстанавливает по исходной основе', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 21;
    });
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, remote)).status).toBe('journal_uncertain');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const queue = structuredClone(f.fake.queue(provider));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { cancelPendingConservativeMerge } = await import('../js/modules/cloudSync/reconcileConservativeMerge.js');
    expect(
      await cancelPendingConservativeMerge({
        provider,
        invoke: f.fake.invoke,
        cryptoSource: webcrypto,
        confirmed: true
      })
    ).toEqual({ status: 'already_anchored' });
    expect(state.settings.cloudSyncPendingMerge).toBeTruthy();
    expect(f.fake.queue(provider)).toEqual(queue);
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(state.characters[0].level).toBe(21);
  }, 30_000);

  it('сохраняет marker при локальной гонке после переноса и возобновляет только исходный снимок', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ИСХОДНАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 22;
    });
    const list = f.cloud.session.listWithDates.getMockImplementation();
    let calls = 0;
    f.cloud.session.listWithDates.mockImplementation(async () => {
      if (++calls === 2) {
        f.state.characters[0].notes = 'ИЗМЕНЕНИЕ ВО ВРЕМЯ ОБЪЕДИНЕНИЯ';
        await f.storage.saveNow();
      }
      return list();
    });
    expect(await mergePin(f, provider, remote)).toEqual({ status: 'state_changed_after_checkpoint' });
    expect(f.state.settings.cloudSyncPendingMerge).toBeTruthy();
    expect((await f.queue()).status).toBe('provenance_review_required');
    expect((await mergePin(f, provider, remote)).status).toBe('merge_intent_mismatch');
    f.state.characters[0].notes = 'ИСХОДНАЯ ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    expect((await mergePin(f, provider, remote)).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'ИСХОДНАЯ ЛОКАЛЬНАЯ', level: 22 });
  }, 30_000);

  it('завершает начатую версию, если новый потомок появился при повторном чтении, но не отправляет поверх него', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 23;
    });
    const newer = await mergeIncoming(f, provider, remote, s => {
      s.sections.characters.records[0].fields.favorite = true;
    });
    const envelope = f.cloud.versions.get(newer.versionId);
    f.cloud.versions.delete(newer.versionId);
    const list = f.cloud.session.listWithDates.getMockImplementation();
    let calls = 0;
    f.cloud.session.listWithDates.mockImplementation(async () => {
      if (++calls === 2) f.cloud.versions.set(newer.versionId, envelope);
      return list();
    });
    const first = await mergePin(f, provider, remote);
    expect(first).toMatchObject({ status: 'merged', newerHeadObserved: true });
    expect(f.state.characters[0]).toMatchObject({ notes: 'ЛОКАЛЬНАЯ', level: 23, favorite: false });
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect((await mergePin(f, provider, newer)).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'ЛОКАЛЬНАЯ', level: 23, favorite: true });
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('не объединяет ветви или исчезновение поля в промежуточной версии', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const first = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 12;
    });
    const other = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.favorite = true;
    });
    const queue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, first)).status).toBe('not_unique_head');
    f.cloud.versions.delete(other.versionId);
    // Add and then remove a real dictionary value in the verified lineage.
    const added = await mergeIncoming(f, provider, first, s => {
      s.sections.finance.settings.monthAdjust['2026-10'] = { coins: 4 };
    });
    const removed = await mergeIncoming(f, provider, added, s => {
      delete s.sections.finance.settings.monthAdjust['2026-10'];
    });
    expect((await mergePin(f, provider, removed)).status).toBe('transition_unsupported');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30_000);

  it('возобновляет после потери ответа CAS и не отправляет, пока marker не снят guarded-записью', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'ЛОКАЛЬНАЯ ДО ПРЕРЫВАНИЯ';
    await f.storage.saveNow();
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 25;
    });
    f.fake.loseNextCompare();
    expect(await mergePin(f, provider, remote)).toEqual({ status: 'journal_uncertain' });
    const pending = f.state.settings.cloudSyncPendingMerge;
    expect(pending).toMatchObject({ basePin: root, targetPin: remote, provider });
    expect(JSON.stringify(pending)).not.toContain('ЛОКАЛЬНАЯ ДО ПРЕРЫВАНИЯ');
    const queueAfter = structuredClone(f.fake.queue(provider));
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { queueConnectedSavedSnapshot } = await import('../js/modules/cloudSync/connectedPublication.js');
    expect(await queueConnectedSavedSnapshot({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })).toEqual({
      status: 'provenance_review_required'
    });
    const again = await mergePin(f, provider, remote);
    expect(again.status).toBe('merged');
    expect(f.fake.queue(provider)).toEqual(queueAfter);
    expect(state.characters[0]).toMatchObject({ notes: 'ЛОКАЛЬНАЯ ДО ПРЕРЫВАНИЯ', level: 25 });
    expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(state.settings.cloudSyncAcceptedBase.pin).toEqual(remote);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);
});

// Outgoing planner tombstones: still fake native CAS and fake providers.
async function plannerDeletionFixture(provider) {
  const f = await publicationFixture(provider, {
    prepare: async f => {
      f.state.plannerEntries[0].title = 'ПОДТВЕРЖДАЕМАЯ ЗАДАЧА';
      await f.storage.saveNow();
    }
  });
  const removed = f.state.plannerEntries.pop();
  await f.storage.saveNow();
  const { stagePlannerDeletionPublication } = await import('../js/modules/cloudSync/plannerDeletionPublication.js');
  return {
    ...f,
    removed,
    stageDeletion: () => stagePlannerDeletionPublication({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })
  };
}

describe.each(['google', 'yandex'])('%s: подтверждённые исходящие удаления календаря', provider => {
  it('после явного подтверждения отправляет отметку и сохраняет её в следующих версиях', async () => {
    const f = await plannerDeletionFixture(provider);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect((await f.queue()).status).toBe('deletions_need_review');
    const staged = await f.stageDeletion();
    expect(staged.status).toBe('deletion_review');
    expect(staged.records()).toEqual([{ id: f.removed.syncId, label: 'ПОДТВЕРЖДАЕМАЯ ЗАДАЧА' }]);
    const previous = structuredClone(f.fake.queue(provider));
    expect(await staged.commit({ confirmed: false })).toEqual({ status: 'confirmation_required' });
    expect(f.fake.queue(provider)).toEqual(previous);
    expect((await staged.commit({ confirmed: true })).status).toBe('queued');
    expect(await staged.commit({ confirmed: true })).toEqual({ status: 'closed' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect(JSON.stringify(f.fake.queue(provider))).not.toContain(f.removed.syncId);
    expect((await f.queue()).status).toBe('unchanged');
    expect((await f.send()).status).toBe('sent_verified');
    f.state.characters[0].notes = 'После удаления';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const { verifyHistory } = await import('../js/modules/cloudSync/history.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const rootPin = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const history = await verifyHistory({
      envelopes: [...f.cloud.versions.values()],
      expectedDatasetId: key.datasetId,
      recoveryKey: key.dataKey,
      root: rootPin,
      knownPins: [rootPin],
      cryptoSource: webcrypto
    });
    const head = history.observedHeads()[0];
    expect(history.plannerTombstones(head)).toEqual([f.removed.syncId]);
    expect(history.publicSnapshot(head).sections.characters.records[0].fields.notes).toBe('После удаления');
  }, 30_000);

  it('после отмены и местной правки не подтверждает устаревший список', async () => {
    const f = await plannerDeletionFixture(provider);
    const cancelled = await f.stageDeletion();
    cancelled.cancel();
    expect(await cancelled.commit({ confirmed: true })).toEqual({ status: 'closed' });
    const stage = await f.stageDeletion();
    const previous = structuredClone(f.fake.queue(provider));
    f.state.characters[0].notes = 'Изменилось после просмотра';
    await f.storage.saveNow();
    expect(await stage.commit({ confirmed: true })).toEqual({ status: 'state_changed_or_unsaved' });
    expect(f.fake.queue(provider)).toEqual(previous);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('не отправляет удаление поверх правки с другого ПК', async () => {
    const f = await plannerDeletionFixture(provider);
    const staged = await f.stageDeletion();
    expect((await staged.commit({ confirmed: true })).status).toBe('queued');
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const rootPin = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    await mergeIncoming(f, provider, rootPin, snapshot => {
      snapshot.sections.planner.records[0].fields.title = 'Правка другого ПК';
    });
    expect((await f.send()).status).toBe('remote_changes_require_review');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('при потере ответа CAS не повторяет подтверждение неизвестного результата', async () => {
    const f = await plannerDeletionFixture(provider);
    const staged = await f.stageDeletion();
    f.fake.loseNextCompare();
    expect((await staged.commit({ confirmed: true })).status).toBe('journal_uncertain');
    const after = structuredClone(f.fake.queue(provider));
    expect(await staged.commit({ confirmed: true })).toEqual({ status: 'closed' });
    expect(f.fake.queue(provider)).toEqual(after);
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);
});

describe.each(['google', 'yandex'])('%s: приём подтверждённого удаления на втором fake ПК', provider => {
  it('после просмотра сохраняет backup местной правки, применяет выбранную метку и продолжает линию', async () => {
    const f = await recoveredFixture(provider);
    expect((await f.reconcile()).status).toBe('reconciled');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const { sealHistoryChildWithPlannerTombstones } = await import('../js/modules/cloudSync/history.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const payload = await decryptSnapshot({
      envelope: f.cloud.versions.get(f.pin.versionId),
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    const parent = payload.publicSnapshot;
    const next = structuredClone(parent);
    const taskId = next.sections.planner.records[0].id;
    next.sections.planner.records = [];
    next.sections.planner.order = [];
    const removed = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: next,
      parent: f.pin,
      parentSnapshot: parent,
      previousTombstones: [],
      deletedIds: [taskId],
      confirmedDeletion: true,
      recoveryKey: key.dataKey,
      datasetId: key.datasetId,
      versionId: generateSyncId(webcrypto),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource: webcrypto
    });
    f.cloud.versions.set(removed.pin.versionId, removed.envelope);
    f.state.plannerEntries[0].title = 'МЕСТНАЯ НЕОТПРАВЛЕННАЯ ПРАВКА';
    await f.storage.saveNow();
    const raw = localStorage.getItem(STORAGE_KEY);
    const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
    const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
    const { prepareCloudReview } = await import('../js/modules/cloudSync/cloudReview.js');
    const review = await prepareCloudReview({
      provider,
      session: f.cloud.session,
      datasetId: key.datasetId,
      dataKey: key.dataKey,
      rootPin: f.pin,
      knownPins: [f.pin],
      localSnapshot: buildPublicSnapshot(currentCloudStateSnapshot()),
      localSavedAt: null,
      cryptoSource: webcrypto
    });
    expect(review.compare(removed.pin).differences.entries).toContainEqual(
      expect.objectContaining({ id: taskId, kind: 'marked_cloud_deletion', deletionSelectable: true })
    );
    expect(review.compare(removed.pin).localRecord('planner', taskId).fields.title).toBe(
      'МЕСТНАЯ НЕОТПРАВЛЕННАЯ ПРАВКА'
    );
    const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
    const stage = stageReviewedCloudApply({
      review,
      pin: removed.pin,
      selectedRecords: [],
      selectedPlannerDeletions: [taskId],
      cryptoSource: webcrypto
    });
    expect((await stage.commit({ confirmed: false })).status).toBe('confirmation_required');
    expect(f.state.plannerEntries).toHaveLength(1);
    const applied = await stage.commit({ confirmed: true });
    expect(applied.status).toBe('applied');
    expect(localStorage.getItem(applied.backup)).toBe(raw);
    expect(f.state.plannerEntries).toHaveLength(0);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect((await f.queue()).status).toBe('provenance_review_required');
    const { reconcileExactCloudBase } = await import('../js/modules/cloudSync/reconcileExactCloudBase.js');
    expect(
      (
        await reconcileExactCloudBase({
          ...f.options,
          pin: removed.pin,
          confirmed: true,
          openSession: f.cloud.openSession
        })
      ).status
    ).toBe('reconciled');
    expect(f.state.settings.cloudSyncPendingApply).toBeUndefined();
    f.state.characters[0].notes = 'ПРОДОЛЖЕНИЕ НА ВТОРОМ ПК';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect(f.state.characters[0].contacts.password).not.toBeUndefined();
  }, 30_000);
});

async function incomingPlannerDeletionForMerge(f, provider, parentPin) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
  const { sealHistoryChildWithPlannerTombstones } = await import('../js/modules/cloudSync/history.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const payload = await decryptSnapshot({
    envelope: f.cloud.versions.get(parentPin.versionId),
    recoveryKey: key.dataKey,
    expectedDatasetId: key.datasetId,
    cryptoSource: webcrypto
  });
  const next = structuredClone(payload.publicSnapshot);
  const id = next.sections.planner.records[0].id;
  next.sections.planner.records = next.sections.planner.records.filter(row => row.id !== id);
  next.sections.planner.order = next.sections.planner.order.filter(value => value !== id);
  const sealed = await sealHistoryChildWithPlannerTombstones({
    publicSnapshot: next,
    parent: parentPin,
    parentSnapshot: payload.publicSnapshot,
    previousTombstones: [],
    deletedIds: [id],
    confirmedDeletion: true,
    recoveryKey: key.dataKey,
    datasetId: key.datasetId,
    versionId: generateSyncId(webcrypto),
    keyBundle: key.bundle,
    keyPin: key.pin,
    cryptoSource: webcrypto
  });
  f.cloud.versions.set(sealed.pin.versionId, sealed.envelope);
  return { pin: sealed.pin, id };
}

describe.each(['google', 'yandex'])('%s: v3-удаление против местного намерения очереди', provider => {
  it('сохраняет намерение, требует выбор удаления, объединяет заметку и подтверждает потомка', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'СОХРАНИТЬ НЕЗАВИСИМУЮ ЗАМЕТКУ';
    f.state.plannerEntries[0].title = 'МЕСТНАЯ ПРАВКА УДАЛЯЕМОЙ ЗАДАЧИ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await incomingPlannerDeletionForMerge(f, provider, root);
    const raw = localStorage.getItem(STORAGE_KEY);
    const queueBefore = structuredClone(f.fake.queue(provider));
    const conflict = await mergePin(f, provider, remote.pin);
    expect(conflict).toMatchObject({
      status: 'conflicts',
      conflicts: [{ id: remote.id, reason: 'cloud-planner-deletion' }]
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(f.fake.queue(provider)).toEqual(queueBefore);
    const choice = {
      reviewHash: conflict.reviewHash,
      cloudRecords: [],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    expect((await mergePin(f, provider, remote.pin, { resolution: choice })).status).toBe('deletion_not_accepted');
    expect(f.state.plannerEntries).toHaveLength(1);
    choice.cloudRecords = [{ section: 'planner', id: remote.id }];
    expect((await mergePin(f, provider, remote.pin, { resolution: choice })).status).toBe('merged');
    expect(f.state.plannerEntries).toHaveLength(0);
    expect(f.state.characters[0].notes).toBe('СОХРАНИТЬ НЕЗАВИСИМУЮ ЗАМЕТКУ');
    expect(
      Object.keys(localStorage).some(key => key.startsWith('tvinoferma_backup_') && localStorage.getItem(key) === raw)
    ).toBe(true);
    const { openConnectedPublicationContext } = await import('../js/modules/cloudSync/connectedPublication.js');
    const context = await openConnectedPublicationContext({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto });
    const head = await context.queue(f.cloud.session).inspectLinearHead(context.pins);
    expect(head.retainedIntents).toHaveLength(1);
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const after = await (
      await openConnectedPublicationContext({ provider, invoke: f.fake.invoke, cryptoSource: webcrypto })
    )
      .queue(f.cloud.session)
      .inspectLinearHead(context.pins);
    expect(after.retainedIntents).toHaveLength(0);
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
  }, 30_000);
});

async function selectivelyAppliedQueuedDeletion(provider) {
  const f = await publicationFixture(provider);
  const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
  const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
  f.state.characters[0].notes = 'НЕЗАВИСИМОЕ СОХРАНЕНИЕ ДО ВЫБОРА';
  f.state.plannerEntries[0].title = 'ПРЕЖНЯЯ МЕСТНАЯ ЗАДАЧА';
  await f.storage.saveNow();
  expect((await f.queue()).status).toBe('queued');
  const remote = await incomingPlannerDeletionForMerge(f, provider, root);
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { prepareCloudReview } = await import('../js/modules/cloudSync/cloudReview.js');
  const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
  const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
  const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const review = await prepareCloudReview({
    provider,
    session: f.cloud.session,
    datasetId: key.datasetId,
    dataKey: key.dataKey,
    rootPin: root,
    knownPins: [root],
    localSnapshot: buildPublicSnapshot(currentCloudStateSnapshot()),
    localSavedAt: null,
    cryptoSource: webcrypto
  });
  expect(
    (
      await stageReviewedCloudApply({
        review,
        pin: remote.pin,
        selectedRecords: [],
        selectedPlannerDeletions: [remote.id],
        cryptoSource: webcrypto
      }).commit({ confirmed: true })
    ).status
  ).toBe('applied');
  return { ...f, remote };
}

describe.each(['google', 'yandex'])('%s: согласование после выборочного удаления с прежней очередью', provider => {
  it('проверяет точную проекцию удаления, сохраняет старое намерение и снимает обе отметки', async () => {
    const f = await selectivelyAppliedQueuedDeletion(provider);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect((await mergePin(f, provider, f.remote.pin)).status).toBe('merged');
    expect(f.state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.state.plannerEntries).toHaveLength(0);
    expect(f.state.characters[0].notes).toBe('НЕЗАВИСИМОЕ СОХРАНЕНИЕ ДО ВЫБОРА');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
  }, 30_000);

  it('не принимает дополнительную правку после удаления за прежний подтверждённый выбор', async () => {
    const f = await selectivelyAppliedQueuedDeletion(provider);
    f.state.characters[0].notes = 'ДРУГАЯ ПРАВКА ПОСЛЕ ВЫБОРА';
    await f.storage.saveNow();
    const before = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, f.remote.pin)).status).toBe('unresolved_sources');
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingApply).toBeTruthy();
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30_000);

  it('после неизвестного CAS восстанавливает v3-намерение с тем же retained снимком', async () => {
    const f = await selectivelyAppliedQueuedDeletion(provider);
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, f.remote.pin)).status).toBe('journal_uncertain');
    expect(f.state.settings.cloudSyncPendingMerge.version).toBe(3);
    const marker = structuredClone(f.state.settings.cloudSyncPendingMerge);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const restarted = { ...f, state };
    expect((await mergePin(restarted, provider, f.remote.pin)).status).toBe('merged');
    expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(state.settings.cloudSyncAcceptedBase.pin).toEqual(marker.targetPin);
    const publication = await import('../js/modules/cloudSync/connectedPublication.js');
    const options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
    expect((await publication.queueConnectedSavedSnapshot(options)).status).toBe('queued');
    expect(
      (await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).status
    ).toBe('sent_verified');
    expect(state.characters[0].notes).toBe('НЕЗАВИСИМОЕ СОХРАНЕНИЕ ДО ВЫБОРА');
  }, 30_000);
});

describe.each(['google', 'yandex'])('%s: защита восстановления v3-отметки после удаления', provider => {
  it('не снимает источники и не меняет retained очередь при подмене хеша или состава применения', async () => {
    const f = await selectivelyAppliedQueuedDeletion(provider);
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, f.remote.pin)).status).toBe('journal_uncertain');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const queue = structuredClone(f.fake.queue(provider));
    const changes = [
      snapshot => {
        snapshot.settings.cloudSyncPendingMerge.appliedIntentHash = '0'.repeat(64);
      },
      snapshot => {
        snapshot.settings.cloudSyncPendingApply.events[0].pin = snapshot.settings.cloudSyncPendingMerge.basePin;
      },
      snapshot => {
        snapshot.settings.cloudSyncPendingApply.events[0].settings = ['appearance'];
      },
      snapshot => {
        snapshot.settings.cloudSyncPendingApply.events[0].financeSettings = true;
      },
      snapshot => {
        snapshot.settings.cloudSyncPendingApply.events[0].records[0].section = 'characters';
      }
    ];
    for (const change of changes) {
      const snapshot = structuredClone(saved);
      change(snapshot);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      vi.resetModules();
      const { state, normalizeState } = await import('../js/core/state.js');
      Object.assign(state, normalizeState(snapshot));
      const result = await mergePin({ ...f, state }, provider, f.remote.pin);
      expect(['merge_intent_mismatch', 'unresolved_sources']).toContain(result.status);
      expect(f.fake.queue(provider)).toEqual(queue);
      expect(state.settings.cloudSyncPendingApply).toBeTruthy();
      expect(state.settings.cloudSyncPendingMerge).toBeTruthy();
      expect(f.cloud.session.upload).not.toHaveBeenCalled();
    }
  }, 30_000);
});

async function valuePublicationFixture(provider, extraPrepare) {
  return publicationFixture(provider, {
    settingsSelections: ['navigation'],
    prepare: async f => {
      const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
      const { createMarathon, createTask } = await import('../js/modules/marathons/model.js');
      f.state.characters[0].tags = ['Старый тег'];
      f.state.plannerEntries.push({
        id: 'repeat-task',
        title: 'Повтор',
        date: '2026-10-30',
        recurrence: 'daily',
        statusByDate: { '2026-10-29': 'done', '2026-10-30': 'done' }
      });
      f.state.marathonTemplates.push({
        id: 'value-template',
        name: 'Шаблон',
        tasks: [
          {
            id: 'template-task-0',
            title: 'Первое',
            rewards: [{ id: 'template-reward-0', threshold: 1, rewardText: 'Первая награда' }]
          },
          {
            id: 'template-task-1',
            title: 'Второе',
            rewards: [{ id: 'template-reward-1', threshold: 1, rewardText: 'Вторая награда' }]
          }
        ],
        bonuses: [{ id: 'template-bonus', needTasks: 1, text: 'Бонус' }]
      });
      f.state.marathons.push(
        createMarathon({
          id: 'instance',
          title: 'Уже созданный марафон',
          source: { type: 'template', templateId: 'value-template' },
          startDate: '2026-10-01',
          endDate: '2026-10-31',
          tasks: [createTask({ id: 'instance-task', title: 'Неизменное задание' })]
        })
      );
      if (extraPrepare) await extraPrepare(f);
      const { ui, ...raw } = f.state;
      const { normalizeState } = await import('../js/core/state.js');
      const { ui: ignored, ...normalized } = normalizeState(raw);
      Object.assign(f.state, planSyncIdentities({ snapshot: normalized, cryptoSource: webcrypto }).snapshot);
      await f.storage.saveNow();
    }
  });
}

describe.each(['google', 'yandex'])('%s: сквозное согласование копируемых значений', provider => {
  it('передаёт изменения прежних значений шаблона, очистку тегов, отметку повтора и навигацию, удерживая очередь', async () => {
    const f = await valuePublicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const instance = structuredClone(f.state.marathons[0]);
    f.state.characters[0].notes = 'НЕОТПРАВЛЕННАЯ НЕЗАВИСИМАЯ ЗАМЕТКА';
    f.state.marathonTemplates[0].name = 'Местное имя';
    f.state.plannerEntries[0].title = 'Местное название';
    f.state.plannerEntries[0].statusByDate['2026-10-30'] = 'doing';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const pending = await inspectMergeQueue(f, provider);
    const remote = await mergeIncoming(f, provider, root, s => {
      const fields = s.sections.marathons.records.find(row => row.type === 'marathonTemplate').fields;
      fields.tasks[1].rewards[0].rewardText = 'ИЗМЕНЁННАЯ ПРЕЖНЯЯ НАГРАДА';
      fields.bonuses = [];
      s.sections.characters.records[0].fields.tags = [];
      delete s.sections.planner.records[0].fields.statusByDate['2026-10-29'];
      const nav = s.sections.preferences.values.navigation;
      [nav.order[1], nav.order[2]] = [nav.order[2], nav.order[1]];
      nav.hidden = ['finance'];
    });
    expect((await mergePin(f, provider, remote, { settingsSelections: ['navigation'] })).status).toBe('merged');
    expect(f.state.marathonTemplates[0]).toMatchObject({ name: 'Местное имя', bonuses: [] });
    expect(f.state.marathonTemplates[0].tasks[0].id).toBe('template-task-0');
    expect(f.state.marathonTemplates[0].tasks[1].id).not.toBe('template-task-1');
    expect(f.state.marathonTemplates[0].tasks[1].rewards[0].rewardText).toBe('ИЗМЕНЁННАЯ ПРЕЖНЯЯ НАГРАДА');
    expect(f.state.characters[0]).toMatchObject({ tags: [], notes: 'НЕОТПРАВЛЕННАЯ НЕЗАВИСИМАЯ ЗАМЕТКА' });
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(f.state.plannerEntries[0].statusByDate).toEqual({ '2026-10-30': 'doing' });
    expect(f.state.settings.ui.sections.hidden).toEqual(['finance']);
    expect(f.state.marathons[0]).toEqual(instance);
    expect((await inspectMergeQueue(f, provider)).retainedPendingPin).toEqual(pending.nextPin);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const sent = [...f.cloud.versions.values()].at(-1);
    const decoded = await decryptSnapshot({
      envelope: sent,
      recoveryKey: key.dataKey,
      expectedDatasetId: key.datasetId,
      cryptoSource: webcrypto
    });
    expect(decoded.parent).toEqual(remote);
    expect(
      decoded.publicSnapshot.sections.marathons.records.find(row => row.type === 'marathonTemplate').fields.bonuses
    ).toEqual([]);
    expect(JSON.stringify(decoded)).not.toContain('PRIVATE_PASSWORD');
    for (const text of ['ИЗМЕНЁННАЯ ПРЕЖНЯЯ НАГРАДА', 'НЕОТПРАВЛЕННАЯ НЕЗАВИСИМАЯ ЗАМЕТКА', 'PRIVATE_PASSWORD']) {
      expect(JSON.stringify(sent)).not.toContain(text);
      expect(JSON.stringify(f.fake.queue(provider))).not.toContain(text);
    }
  }, 30_000);

  it.each([true, false])(
    'после потери CAS и перезапуска сохраняет выбор целого списка и prepared намерение: облако=%s',
    async useCloud => {
      const f = await valuePublicationFixture(provider);
      const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
      const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
      f.state.marathonTemplates[0].tasks[0].title = 'МЕСТНОЕ ЗАДАНИЕ';
      f.state.characters[0].tags.push('Местный тег');
      f.state.characters[0].notes = 'Независимая заметка';
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
      expect((await f.send()).status).toBe('deferred');
      expect((await inspectMergeQueue(f, provider)).nextPhase).toBe('prepared');
      const remote = await mergeIncoming(f, provider, root, s => {
        const t = s.sections.marathons.records.find(row => row.type === 'marathonTemplate');
        t.fields.tasks[1].title = 'ОБЛАЧНОЕ ЗАДАНИЕ';
        t.fields.bonuses = [];
        s.sections.characters.records[0].fields.tags = [];
        s.sections.characters.records[0].fields.level = 42;
      });
      const before = structuredClone(f.fake.queue(provider));
      const preview = await mergePin(f, provider, remote, { settingsSelections: ['navigation'] });
      expect(preview.status).toBe('conflicts');
      expect(preview.conflictCount).toBe(2);
      expect(f.fake.queue(provider)).toEqual(before);
      expect(f.state.marathonTemplates[0].tasks[0].title).toBe('МЕСТНОЕ ЗАДАНИЕ');
      const resolution = {
        reviewHash: preview.reviewHash,
        cloudRecords: useCloud
          ? [
              { section: 'marathons', id: f.state.marathonTemplates[0].syncId },
              { section: 'characters', id: f.state.characters[0].syncId }
            ]
          : [],
        cloudSettings: [],
        cloudFinanceSettings: false
      };
      f.fake.loseNextCompare();
      expect((await mergePin(f, provider, remote, { settingsSelections: ['navigation'], resolution })).status).toBe(
        'journal_uncertain'
      );
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      vi.resetModules();
      const { state, normalizeState } = await import('../js/core/state.js');
      Object.assign(state, normalizeState(saved));
      expect((await mergePin({ ...f, state }, provider, remote, { settingsSelections: ['navigation'] })).status).toBe(
        'merged'
      );
      expect(state.marathonTemplates[0].tasks.map(row => row.title)).toEqual(
        useCloud ? ['Первое', 'ОБЛАЧНОЕ ЗАДАНИЕ'] : ['МЕСТНОЕ ЗАДАНИЕ', 'Второе']
      );
      if (!useCloud) expect(state.marathonTemplates[0].tasks[0].id).toBe('template-task-0');
      expect(state.marathonTemplates[0].bonuses).toEqual([]);
      expect(state.characters[0]).toMatchObject({
        level: 42,
        tags: useCloud ? [] : ['Старый тег', 'Местный тег'],
        notes: 'Независимая заметка'
      });
      expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
      expect((await inspectMergeQueue(f, provider)).retainedPendingPhase).toBe('prepared');
      const publication = await import('../js/modules/cloudSync/connectedPublication.js');
      const options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
      expect((await publication.queueConnectedSavedSnapshot(options)).status).toBe('queued');
      expect(
        (await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).status
      ).toBe('sent_verified');
      expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
    },
    30_000
  );

  it('не использует прежний выбор списка после дополнительной местной правки', async () => {
    const f = await valuePublicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.marathonTemplates[0].tasks[0].title = 'Местное изменение';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.marathons.records.find(row => row.type === 'marathonTemplate').fields.tasks = [];
    });
    const preview = await mergePin(f, provider, remote, { settingsSelections: ['navigation'] });
    expect(preview.status).toBe('conflicts');
    const resolution = {
      reviewHash: preview.reviewHash,
      cloudRecords: [{ section: 'marathons', id: f.state.marathonTemplates[0].syncId }],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    f.state.marathonTemplates[0].tasks[0].title = 'УЖЕ ДРУГОЕ МЕСТНОЕ ИЗМЕНЕНИЕ';
    await f.storage.saveNow();
    const queue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote, { settingsSelections: ['navigation'], resolution })).status).toBe(
      'queue_snapshot_mismatch'
    );
    expect(f.fake.queue(provider)).toEqual(queue);
    expect((await f.queue()).status).toBe('coalesced');
    const refreshedQueue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote, { settingsSelections: ['navigation'], resolution })).status).toBe(
      'conflicts_changed'
    );
    expect(f.fake.queue(provider)).toEqual(refreshedQueue);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.state.marathonTemplates[0].tasks[0].title).toBe('УЖЕ ДРУГОЕ МЕСТНОЕ ИЗМЕНЕНИЕ');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('не сохраняет отметку и не переносит очередь при неверных значениях награды', async () => {
    const f = await valuePublicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.marathons.records.find(row => row.type === 'marathonTemplate').fields.tasks[0].rewards[0].threshold =
        0;
    });
    const queue = structuredClone(f.fake.queue(provider));
    const template = structuredClone(f.state.marathonTemplates[0]);
    expect((await mergePin(f, provider, remote, { settingsSelections: ['navigation'] })).status).toBe(
      'candidate_unrepresentable'
    );
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.marathonTemplates[0]).toEqual(template);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);
});

describe.each(['google', 'yandex'])('%s: сквозной штатный лимит истории характеристик', provider => {
  it('согласует одиннадцатый снимок и отправляет потомка без выбора по времени', async () => {
    const f = await valuePublicationFixture(provider, async f => {
      const { rememberStatsBefore } = await import('../js/modules/characters/statsHistory.js');
      const char = f.state.characters[0];
      for (let i = 1; i <= 11; i++) {
        const previous = structuredClone(char.stats);
        char.stats.strength = i;
        rememberStatsBefore(char, previous, `2026-10-${String(i).padStart(2, '0')}T00:00:00.000Z`);
      }
    });
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    f.state.characters[0].notes = 'Независимая заметка';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      const fields = s.sections.characters.records[0].fields;
      fields.statsHistory = [
        { at: '2000-01-01T00:00:00.000Z', stats: structuredClone(fields.stats) },
        ...fields.statsHistory.slice(0, 9)
      ];
      fields.stats.strength = 12;
    });
    expect((await mergePin(f, provider, remote, { settingsSelections: ['navigation'] })).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'Независимая заметка', stats: { strength: 12 } });
    expect(f.state.characters[0].statsHistory).toHaveLength(10);
    expect(f.state.characters[0].statsHistory[0]).toMatchObject({
      at: '2000-01-01T00:00:00.000Z',
      stats: { strength: 11 }
    });
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
  }, 30_000);
});

async function stageFixturePrivate(f, provider, fields = ['password'], extra = {}) {
  const { stagePrivatePublication } = await import('../js/modules/cloudSync/privateTransfer.js');
  return stagePrivatePublication({
    provider,
    invoke: f.fake.invoke,
    cryptoSource: webcrypto,
    fields,
    contactsSourceConfirmed: true,
    acknowledgePasswordRisk: true,
    ...extra
  });
}
async function fixturePrivateReview(f, provider) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
  const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
  const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
  const { prepareCloudReview } = await import('../js/modules/cloudSync/cloudReview.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
  return prepareCloudReview({
    provider,
    session: f.cloud.session,
    datasetId: key.datasetId,
    dataKey: key.dataKey,
    rootPin: root,
    knownPins: [root],
    localSnapshot: buildPublicSnapshot(currentCloudStateSnapshot()),
    localSavedAt: null,
    cryptoSource: webcrypto
  });
}
async function fixturePrivatePayload(f) {
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { decryptSnapshot } = await import('../js/modules/cloudSync/envelope.js');
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  return decryptSnapshot({
    envelope: [...f.cloud.versions.values()].at(-1),
    recoveryKey: key.dataKey,
    expectedDatasetId: key.datasetId,
    cryptoSource: webcrypto
  });
}
describe.each(['google', 'yandex'])('%s: отдельная ручная зашифрованная передача контактов', provider => {
  it('требует раздельного согласия, отправляет только выбранную категорию и не выгружает последующие местные секреты', async () => {
    const f = await publicationFixture(provider);
    const original = structuredClone(f.fake.queue(provider));
    expect((await stageFixturePrivate(f, provider, ['password'], { acknowledgePasswordRisk: false })).status).toBe(
      'private_consent_required'
    );
    expect((await stageFixturePrivate(f, provider, ['email'], { contactsSourceConfirmed: false })).status).toBe(
      'private_consent_required'
    );
    expect(f.fake.queue(provider)).toEqual(original);
    const stage = await stageFixturePrivate(f, provider);
    expect(stage.status).toBe('private_publication_review');
    expect(JSON.stringify(stage)).not.toContain('PRIVATE_PASSWORD');
    expect(stage.fields).toEqual(['password']);
    expect(stage.characterCount).toBe(1);
    expect((await stage.commit({ confirmed: false })).status).toBe('confirmation_required');
    expect(f.fake.queue(provider)).toEqual(original);
    expect((await stage.commit({ confirmed: true })).status).toBe('queued');
    expect(JSON.stringify(f.fake.queue(provider))).not.toContain('PRIVATE_PASSWORD');
    expect((await f.send()).status).toBe('sent_verified');
    const decoded = await fixturePrivatePayload(f);
    expect(decoded.version).toBe(4);
    expect(decoded.privateSnapshot.records).toEqual([
      { characterId: f.state.characters[0].syncId, fields: { password: 'PRIVATE_PASSWORD' } }
    ]);
    expect(JSON.stringify(decoded.publicSnapshot)).not.toContain('PRIVATE_PASSWORD');
    f.state.characters[0].contacts.password = 'NEW_PRIVATE_NOT_CONSENTED';
    f.state.characters[0].contacts.email = 'NEVER_OPTED_IN@example.test';
    f.state.characters[0].notes = 'Новая публичная заметка';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const child = await fixturePrivatePayload(f);
    expect(child.version).toBe(4);
    expect(child.privateSnapshot).toEqual(decoded.privateSnapshot);
    expect(JSON.stringify(child)).not.toContain('NEW_PRIVATE_NOT_CONSENTED');
    expect(JSON.stringify(child)).not.toContain('NEVER_OPTED_IN');
    const review = await fixturePrivateReview(f, provider);
    expect(review.status).toBe('ready_for_review');
    expect(JSON.stringify(review)).not.toContain('PRIVATE_PASSWORD');
  }, 30_000);

  it('сохраняет явно подготовленный секрет при обычном coalescing публичной очереди и перезапуске', async () => {
    const f = await publicationFixture(provider);
    const stage = await stageFixturePrivate(f, provider);
    expect((await stage.commit({ confirmed: true })).status).toBe('queued');
    f.state.characters[0].contacts.password = 'НЕ РАЗРЕШАЛ ПЕРЕДАВАТЬ ЭТОТ';
    f.state.characters[0].notes = 'Публичная правка после подготовки';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('coalesced');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const publication = await import('../js/modules/cloudSync/connectedPublication.js');
    expect(
      (
        await publication.sendConnectedQueuedSnapshot({
          provider,
          invoke: f.fake.invoke,
          cryptoSource: webcrypto,
          openSession: f.cloud.openSession
        })
      ).status
    ).toBe('sent_verified');
    const child = await fixturePrivatePayload(f);
    expect(child.privateSnapshot.records[0].fields.password).toBe('PRIVATE_PASSWORD');
    expect(child.publicSnapshot.sections.characters.records[0].fields.notes).toBe('Публичная правка после подготовки');
    expect(JSON.stringify(child)).not.toContain('НЕ РАЗРЕШАЛ');
  }, 30_000);

  it('добавляет другую категорию, не очищая и не обновляя ранее переданную невыбранную', async () => {
    const f = await publicationFixture(provider);
    const password = await stageFixturePrivate(f, provider);
    expect((await password.commit({ confirmed: true })).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    f.state.characters[0].contacts.password = 'НЕ ВЫБРАН ДЛЯ ОБНОВЛЕНИЯ';
    f.state.characters[0].contacts.phone = 'PRIVATE_PHONE_123';
    await f.storage.saveNow();
    const phone = await stageFixturePrivate(f, provider, ['phone'], { acknowledgePasswordRisk: false });
    expect((await phone.commit({ confirmed: true })).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await fixturePrivatePayload(f)).privateSnapshot.records[0].fields).toEqual({
      password: 'PRIVATE_PASSWORD',
      phone: 'PRIVATE_PHONE_123'
    });
  }, 30_000);

  it('показывает только закрытые различия и применяет выбранное поле с точной копией старого state', async () => {
    const f = await publicationFixture(provider);
    const transfer = await stageFixturePrivate(f, provider);
    expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    f.state.characters[0].contacts.password = 'OLD_LOCAL_PRIVATE_PASSWORD';
    f.state.characters[0].contacts.email = 'LOCAL_EMAIL_NOT_SELECTED';
    await f.storage.saveNow();
    const before = localStorage.getItem(STORAGE_KEY);
    const review = await fixturePrivateReview(f, provider);
    const pin = review.versions.find(row => row.observedHead).pin;
    const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
    const masked = review.comparePrivate(pin, currentCloudStateSnapshot(), ['password']);
    expect(masked).toMatchObject([
      { field: 'password', localPresent: true, cloudPresent: true, clears: false, selectable: true }
    ]);
    for (const raw of ['PRIVATE_PASSWORD', 'OLD_LOCAL_PRIVATE_PASSWORD', 'LOCAL_EMAIL_NOT_SELECTED'])
      expect(JSON.stringify(masked)).not.toContain(raw);
    const { stagePrivateCloudApply } = await import('../js/modules/cloudSync/privateTransfer.js');
    const options = {
      review,
      pin,
      selections: [{ characterId: f.state.characters[0].syncId, field: 'password' }],
      contactsSourceConfirmed: true,
      acknowledgePasswordRisk: true,
      independentBackupConfirmed: true
    };
    expect(() => stagePrivateCloudApply({ ...options, independentBackupConfirmed: false })).toThrow();
    expect(() => stagePrivateCloudApply({ ...options, acknowledgePasswordRisk: false })).toThrow();
    const stage = stagePrivateCloudApply(options);
    expect((await stage.commit({ confirmed: false })).status).toBe('confirmation_required');
    const applied = await stage.commit({ confirmed: true });
    expect(applied.status).toBe('applied');
    expect(localStorage.getItem(applied.backup)).toBe(before);
    expect(f.state.characters[0].contacts).toMatchObject({
      password: 'PRIVATE_PASSWORD',
      email: 'LOCAL_EMAIL_NOT_SELECTED'
    });
    expect(f.state.settings.cloudSyncPendingApply).toBeUndefined();
  }, 30_000);

  it('не передаёт секрет при изменении сохранения после просмотра или недоступном vault', async () => {
    const f = await publicationFixture(provider);
    const stage = await stageFixturePrivate(f, provider);
    f.state.characters[0].contacts.password = 'УЖЕ ДРУГОЙ СЕКРЕТ';
    await f.storage.saveNow();
    const before = structuredClone(f.fake.queue(provider));
    expect((await stage.commit({ confirmed: true })).status).toBe('state_changed_or_unsaved');
    expect(f.fake.queue(provider)).toEqual(before);
    f.state.settings.security.useVault = true;
    expect((await stageFixturePrivate(f, provider)).status).toBe('private_source_unavailable');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30_000);
});

describe.each(['google', 'yandex'])('%s: защита разных приватных намерений и vault', provider => {
  it('не переносит публичную основу поверх ещё не отправленной партии контактов', async () => {
    const f = await publicationFixture(provider);
    const { parseDatasetBindingRecord } = await import('../js/modules/cloudSync/datasetBindingRecord.js');
    const root = parseDatasetBindingRecord(f.fake.pin(provider)).binding.rootPin;
    const transfer = await stageFixturePrivate(f, provider);
    expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
    const remote = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 42;
    });
    const before = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote)).status).toBe('private_transfer_pending');
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
  }, 30_000);
  it('объединяет независимые публичные поля при неизменной секретной части, не подменяя её местными секретами', async () => {
    const f = await publicationFixture(provider);
    const transfer = await stageFixturePrivate(f, provider);
    expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const old = await fixturePrivatePayload(f);
    const head = await inspectMergeQueue(f, provider);
    const { sealHistoryChildWithPlannerTombstones } = await import('../js/modules/cloudSync/history.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    const publicSnapshot = structuredClone(old.publicSnapshot);
    publicSnapshot.sections.characters.records[0].fields.level = 42;
    const remote = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot,
      parent: head.confirmedPin,
      parentSnapshot: old.publicSnapshot,
      privateSnapshot: old.privateSnapshot,
      previousTombstones: [],
      deletedIds: [],
      confirmedDeletion: false,
      recoveryKey: key.dataKey,
      datasetId: key.datasetId,
      versionId: generateSyncId(webcrypto),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource: webcrypto
    });
    f.cloud.versions.set(remote.pin.versionId, remote.envelope);
    f.state.characters[0].notes = 'Независимая местная заметка';
    f.state.characters[0].contacts.password = 'НЕ РАЗРЕШАЛ НОВЫЙ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    expect((await mergePin(f, provider, remote.pin)).status).toBe('merged');
    expect(f.state.characters[0]).toMatchObject({ notes: 'Независимая местная заметка', level: 42 });
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await fixturePrivatePayload(f)).privateSnapshot).toEqual(old.privateSnapshot);
    expect(f.state.characters[0].contacts.password).toBe('НЕ РАЗРЕШАЛ НОВЫЙ');
  }, 30_000);
  it('не объединяет молча разные секретные версии и оставляет очередь без отметки операции', async () => {
    const f = await publicationFixture(provider);
    const transfer = await stageFixturePrivate(f, provider);
    expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const old = await fixturePrivatePayload(f);
    const head = await inspectMergeQueue(f, provider);
    const { sealHistoryChildWithPlannerTombstones } = await import('../js/modules/cloudSync/history.js');
    const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
    old.privateSnapshot.records[0].fields.password = 'ДРУГОЙ ОБЛАЧНЫЙ СЕКРЕТ';
    const remote = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: old.publicSnapshot,
      parent: head.confirmedPin,
      parentSnapshot: old.publicSnapshot,
      privateSnapshot: old.privateSnapshot,
      previousTombstones: [],
      deletedIds: [],
      confirmedDeletion: false,
      recoveryKey: key.dataKey,
      datasetId: key.datasetId,
      versionId: generateSyncId(webcrypto),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource: webcrypto
    });
    f.cloud.versions.set(remote.pin.versionId, remote.envelope);
    f.state.characters[0].notes = 'Местная правка';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const before = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote.pin)).status).toBe('private_transfer_review_required');
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
  }, 30_000);
  it('применяет в синтетический OS-vault, не кладёт контакты в state и требует независимую копию', async () => {
    const f = await publicationFixture(provider);
    const transfer = await stageFixturePrivate(f, provider);
    expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    const { __setInvoke, hydrateSecrets, contactsJson } = await import('../js/core/secrets.js');
    f.state.characters[0].contacts.password = 'VAULT_OLD_PASSWORD';
    f.state.settings.security.useVault = true;
    const records = new Map([[f.state.characters[0].id, contactsJson(f.state.characters[0].contacts)]]);
    __setInvoke(async (command, args) => {
      if (command === 'secrets_available') return true;
      if (command === 'secrets_get_many')
        return Object.fromEntries(args.keys.filter(key => records.has(key)).map(key => [key, records.get(key)]));
      if (command === 'secrets_set_many') {
        for (const [key, value] of Object.entries(args.items)) {
          if (value) records.set(key, value);
          else records.delete(key);
        }
        return null;
      }
      if (command === 'secrets_delete_many') {
        args.keys.forEach(key => records.delete(key));
        return null;
      }
      throw Error('unexpected command');
    });
    expect((await hydrateSecrets(f.state.characters, { tauri: true, requiresVault: true })).blocked).not.toBe(true);
    await f.storage.saveNow();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('VAULT_OLD_PASSWORD');
    const review = await fixturePrivateReview(f, provider);
    const pin = review.versions.find(row => row.observedHead).pin;
    const { stagePrivateCloudApply } = await import('../js/modules/cloudSync/privateTransfer.js');
    const options = {
      review,
      pin,
      selections: [{ characterId: f.state.characters[0].syncId, field: 'password' }],
      contactsSourceConfirmed: true,
      acknowledgePasswordRisk: true,
      independentBackupConfirmed: true
    };
    expect(() => stagePrivateCloudApply({ ...options, independentBackupConfirmed: false })).toThrow();
    const operation = stagePrivateCloudApply(options);
    const result = await operation.commit({ confirmed: true });
    expect(result.status).toBe('applied');
    expect(JSON.parse(records.get(f.state.characters[0].id)).password).toBe('PRIVATE_PASSWORD');
    const disk = localStorage.getItem(STORAGE_KEY);
    expect(disk).not.toContain('PRIVATE_PASSWORD');
    expect(disk).not.toContain('VAULT_OLD_PASSWORD');
    expect(JSON.parse(disk).characters[0].contacts).toBeNull();
    // Crucial limitation is explicit: the state backup contains references, not the old vault values.
    expect(localStorage.getItem(result.backup)).not.toContain('VAULT_OLD_PASSWORD');
  }, 30_000);
});

// Incoming private values already authorized on another PC are retained as
// ciphertext only. This must NEVER become permission to read local contacts.
async function incomingPrivateCarry(f, provider, mutate = () => {}) {
  const { sealHistoryChildWithPlannerTombstones } = await import('../js/modules/cloudSync/history.js');
  const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
  const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
  const old = await fixturePrivatePayload(f);
  const head = await inspectMergeQueue(f, provider);
  const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
  const publicSnapshot = structuredClone(old.publicSnapshot);
  mutate(publicSnapshot);
  const privateSnapshot = {
    schemaVersion: 1,
    records: [
      {
        characterId: f.state.characters[0].syncId,
        fields: { password: 'REMOTE_CARRY_SECRET', email: 'remote-carry@example.test' }
      }
    ]
  };
  const deletedIds = old.publicSnapshot.sections.planner.records
    .filter(row => !publicSnapshot.sections.planner.records.some(next => next.id === row.id))
    .map(row => row.id)
    .sort();
  const remote = await sealHistoryChildWithPlannerTombstones({
    publicSnapshot,
    parent: head.confirmedPin,
    parentSnapshot: old.publicSnapshot,
    privateSnapshot,
    previousTombstones: old.plannerTombstones || [],
    deletedIds,
    confirmedDeletion: deletedIds.length > 0,
    recoveryKey: key.dataKey,
    datasetId: key.datasetId,
    versionId: generateSyncId(webcrypto),
    keyBundle: key.bundle,
    keyPin: key.pin,
    cryptoSource: webcrypto
  });
  f.cloud.versions.set(remote.pin.versionId, remote.envelope);
  return { ...remote, privateSnapshot };
}
describe.each(['google', 'yandex'])(
  '%s: явное сохранение входящей зашифрованной партии без применения контактов',
  provider => {
    it.each([false, true])(
      'сохраняет входящую партию при публичном объединении (раньше была приватная часть: %s)',
      async priorPrivate => {
        const f = await publicationFixture(provider);
        if (priorPrivate) {
          const transfer = await stageFixturePrivate(f, provider);
          expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
          expect((await f.send()).status).toBe('sent_verified');
        }
        const remote = await incomingPrivateCarry(f, provider, s => {
          s.sections.characters.records[0].fields.level = 42;
        });
        f.state.characters[0].notes = 'НЕЗАВИСИМАЯ ПРАВКА';
        f.state.characters[0].contacts.password = 'LOCAL_UNAUTHORIZED_SECRET';
        await f.storage.saveNow();
        expect((await f.queue()).status).toBe('queued');
        const contacts = structuredClone(f.state.characters[0].contacts);
        const before = structuredClone(f.fake.queue(provider));
        expect((await mergePin(f, provider, remote.pin)).status).toBe('private_transfer_review_required');
        expect(f.fake.queue(provider)).toEqual(before);
        expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
        expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true })).status).toBe('merged');
        expect(f.state.characters[0]).toMatchObject({ level: 42, notes: 'НЕЗАВИСИМАЯ ПРАВКА', contacts });
        expect((await inspectMergeQueue(f, provider)).retainedIntents).toHaveLength(1);
        expect((await f.queue()).status).toBe('queued');
        expect((await f.send()).status).toBe('sent_verified');
        const payload = await fixturePrivatePayload(f);
        expect(payload.privateSnapshot).toEqual(remote.privateSnapshot);
        expect(JSON.stringify(payload)).not.toContain('LOCAL_UNAUTHORIZED_SECRET');
      },
      30000
    );
    it('возобновляет сохранённое подтверждение после потери ответа, не позволяя заменить его', async () => {
      const f = await publicationFixture(provider);
      const remote = await incomingPrivateCarry(f, provider, s => {
        s.sections.characters.records[0].fields.level = 42;
      });
      f.state.characters[0].notes = 'МЕСТНАЯ ПРАВКА';
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      f.fake.loseNextCompare();
      expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true })).status).toBe(
        'journal_uncertain'
      );
      expect(f.state.settings.cloudSyncPendingMerge).toMatchObject({
        version: 4,
        privateCarryConfirmed: true,
        resolution: null,
        appliedIntentHash: null,
        targetPin: remote.pin
      });
      expect(JSON.stringify(f.state.settings.cloudSyncPendingMerge)).not.toContain('REMOTE_CARRY_SECRET');
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      vi.resetModules();
      const { state, normalizeState } = await import('../js/core/state.js');
      Object.assign(state, normalizeState(saved));
      const before = structuredClone(f.fake.queue(provider));
      expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: false })).status).toBe(
        'merge_intent_mismatch'
      );
      expect(f.fake.queue(provider)).toEqual(before);
      expect((await mergePin(f, provider, remote.pin)).status).toBe('merged');
      expect(state.characters[0]).toMatchObject({
        level: 42,
        notes: 'МЕСТНАЯ ПРАВКА',
        contacts: { password: 'PRIVATE_PASSWORD' }
      });
      expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
    }, 30000);
    it('не заменяет отдельную неотправленную местную секретную партию даже с разрешением carry', async () => {
      const f = await publicationFixture(provider);
      const remote = await incomingPrivateCarry(f, provider);
      const transfer = await stageFixturePrivate(f, provider);
      expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
      const before = structuredClone(f.fake.queue(provider));
      expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true })).status).toBe(
        'private_transfer_pending'
      );
      expect(f.fake.queue(provider)).toEqual(before);
      expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
    }, 30000);
    it('требует отдельного выбора публичного конфликта и сохраняет оба согласованных решения', async () => {
      const f = await publicationFixture(provider);
      const remote = await incomingPrivateCarry(f, provider, s => {
        s.sections.characters.records[0].fields.notes = 'ОБЛАЧНАЯ ПРАВКА';
      });
      f.state.characters[0].notes = 'МЕСТНАЯ ПРАВКА';
      await f.storage.saveNow();
      expect((await f.queue()).status).toBe('queued');
      const found = await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true });
      expect(found.status).toBe('conflicts');
      expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
      const resolution = {
        reviewHash: found.reviewHash,
        cloudRecords: [{ section: 'characters', id: f.state.characters[0].syncId }],
        cloudSettings: [],
        cloudFinanceSettings: false
      };
      expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true, resolution })).status).toBe(
        'merged'
      );
      expect(f.state.characters[0]).toMatchObject({
        notes: 'ОБЛАЧНАЯ ПРАВКА',
        contacts: { password: 'PRIVATE_PASSWORD' }
      });
      expect((await f.queue()).status).toBe('queued');
      expect((await f.send()).status).toBe('sent_verified');
      expect((await fixturePrivatePayload(f)).privateSnapshot).toEqual(remote.privateSnapshot);
    }, 30000);
  }
);
describe.each(['google', 'yandex'])('%s: восстановление ciphertext-only и составной очереди', provider => {
  it('сохраняет prepared публичное намерение и его старый file ID до проверки потомка', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'ПУБЛИЧНОЕ НАМЕРЕНИЕ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    expect((await f.send()).status).toBe('deferred');
    expect((await inspectMergeQueue(f, provider)).nextPhase).toBe('prepared');
    const remote = await incomingPrivateCarry(f, provider, s => {
      s.sections.characters.records[0].fields.level = 42;
    });
    expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true })).status).toBe('merged');
    expect((await inspectMergeQueue(f, provider)).retainedPendingPhase).toBe('prepared');
    expect((await f.queue()).status).toBe('queued');
    expect((await f.send()).status).toBe('sent_verified');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toHaveLength(0);
    expect((await fixturePrivatePayload(f)).privateSnapshot).toEqual(remote.privateSnapshot);
  }, 30000);
  it('находит более раннее секретное намерение перед публичным хвостом и ничего не перезаписывает', async () => {
    const f = await publicationFixture(provider);
    const transfer = await stageFixturePrivate(f, provider);
    expect((await transfer.commit({ confirmed: true })).status).toBe('queued');
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    expect((await f.send()).status).toBe('deferred');
    f.state.characters[0].notes = 'ХВОСТ ПОСЛЕ СЕКРЕТОВ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const head = await inspectMergeQueue(f, provider);
    expect(head).toMatchObject({ pendingCount: 2, privateIntentPending: true });
    const remote = await incomingPrivateCarry(f, provider);
    const before = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true })).status).toBe(
      'private_transfer_pending'
    );
    expect(f.fake.queue(provider)).toEqual(before);
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30000);
  it('совмещает подтверждение carry с ранее выбранным удалением и восстанавливает оба после CAS', async () => {
    const f = await publicationFixture(provider);
    f.state.characters[0].notes = 'НЕЗАВИСИМОЕ НАМЕРЕНИЕ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await incomingPrivateCarry(f, provider, s => {
      s.sections.planner.records = [];
      s.sections.planner.order = [];
    });
    const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
    const review = await fixturePrivateReview(f, provider);
    const deletionId = f.state.plannerEntries[0].syncId;
    expect(
      (
        await stageReviewedCloudApply({
          review,
          pin: remote.pin,
          selectedRecords: [],
          selectedPlannerDeletions: [deletionId],
          cryptoSource: webcrypto
        }).commit({ confirmed: true })
      ).status
    ).toBe('applied');
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true })).status).toBe('journal_uncertain');
    expect(f.state.settings.cloudSyncPendingMerge).toMatchObject({
      version: 4,
      privateCarryConfirmed: true,
      appliedIntentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    const { cancelPendingConservativeMerge } = await import('../js/modules/cloudSync/reconcileConservativeMerge.js');
    expect(
      (
        await cancelPendingConservativeMerge({
          provider,
          invoke: f.fake.invoke,
          confirmed: true,
          cryptoSource: webcrypto
        })
      ).status
    ).toBe('already_anchored');
    expect(state.settings.cloudSyncPendingMerge).toBeTruthy();
    expect((await mergePin({ ...f, state }, provider, remote.pin)).status).toBe('merged');
    expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(state.settings.cloudSyncPendingApply).toBeUndefined();
    expect(state.plannerEntries).toHaveLength(0);
    expect(state.characters[0]).toMatchObject({
      notes: 'НЕЗАВИСИМОЕ НАМЕРЕНИЕ',
      contacts: { password: 'PRIVATE_PASSWORD' }
    });
  }, 30000);
});

// Archive moves keep identity and all links; these are synthetic transports,
// NOT a report of two real Windows installations or either provider's live API.
describe.each(['google', 'yandex'])('%s: архив персонажей через очередь и защищённое объединение', provider => {
  for (const restoring of [false, true])
    for (const side of ['local', 'cloud'])
      for (const privateCarry of [false, true]) {
        it(`${restoring ? 'восстановление' : 'архивирование'} на ${side}; приватный перенос ${privateCarry}`, async () => {
          const f = await publicationFixture(provider, {
            prepare: async f => {
              const { normalizeState } = await import('../js/core/state.js');
              const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
              const { createMarathon } = await import('../js/modules/marathons/model.js');
              const { ui, ...raw } = structuredClone({ ...f.state, ui: null });
              raw.parties = [{ id: 'party', name: 'Пати', order: 1 }];
              raw.characters[0].partyIds = ['party'];
              raw.characters[0].mainPartyId = 'party';
              raw.marathons = [
                createMarathon({
                  id: 'marathon',
                  title: 'Связанный марафон',
                  startDate: '2026-10-01',
                  endDate: '2026-10-31',
                  participantIds: ['hero']
                })
              ];
              if (restoring) {
                raw.archivedCharacters = raw.characters;
                raw.characters = [];
              }
              const { ui: ignored, ...normalized } = normalizeState(raw);
              Object.assign(f.state, planSyncIdentities({ snapshot: normalized, cryptoSource: webcrypto }).snapshot);
              await f.storage.saveNow();
            }
          });
          if (privateCarry) {
            const consent = await stageFixturePrivate(f, provider);
            expect((await consent.commit({ confirmed: true })).status).toBe('queued');
            expect(await f.send()).toEqual({ status: 'sent_verified' });
          }
          const parent = (await inspectMergeQueue(f, provider)).confirmedPin;
          if (side === 'local') {
            if (restoring) {
              f.state.characters = f.state.archivedCharacters;
              f.state.archivedCharacters = [];
            } else {
              f.state.archivedCharacters = f.state.characters;
              f.state.characters = [];
            }
          }
          const hero = [...f.state.characters, ...f.state.archivedCharacters][0];
          const id = hero.syncId;
          hero.notes = 'МЕСТНАЯ ПРАВКА ПРИ ПЕРЕМЕЩЕНИИ';
          hero.contacts.password = 'NEW_LOCAL_PASSWORD_NOT_CONSENTED';
          await f.storage.saveNow();
          expect(await f.queue()).toEqual({ status: 'queued' });
          const mutate = snapshot => {
            snapshot.sections.characters.records[0].fields.level = 42;
            if (side === 'cloud') {
              const group = snapshot.sections.characters;
              group.records[0].archived = !restoring;
              group.order = { active: restoring ? [id] : [], archived: restoring ? [] : [id] };
            }
          };
          let remote;
          if (privateCarry) {
            const { parseKeyStateRecord } = await import('../js/modules/cloudSync/keyStateRecord.js');
            const { decryptSnapshot, generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
            const { sealHistoryChildWithPlannerTombstones } = await import('../js/modules/cloudSync/history.js');
            const key = (await parseKeyStateRecord(f.fake.key().record, webcrypto)).state;
            const previous = await decryptSnapshot({
              envelope: f.cloud.versions.get(parent.versionId),
              recoveryKey: key.dataKey,
              expectedDatasetId: key.datasetId,
              cryptoSource: webcrypto
            });
            const snapshot = structuredClone(previous.publicSnapshot);
            mutate(snapshot);
            const child = await sealHistoryChildWithPlannerTombstones({
              parentSnapshot: previous.publicSnapshot,
              publicSnapshot: snapshot,
              parent,
              previousTombstones: previous.plannerTombstones || [],
              deletedIds: [],
              confirmedDeletion: false,
              privateSnapshot: previous.privateSnapshot,
              recoveryKey: key.dataKey,
              datasetId: key.datasetId,
              versionId: generateSyncId(webcrypto),
              keyBundle: key.bundle,
              keyPin: key.pin,
              cryptoSource: webcrypto
            });
            f.cloud.versions.set(child.pin.versionId, child.envelope);
            remote = child.pin;
          } else remote = await mergeIncoming(f, provider, parent, mutate);
          const before = localStorage.getItem(STORAGE_KEY);
          const result = await mergePin(f, provider, remote);
          expect(result.status).toBe('merged');
          const current = restoring ? f.state.characters : f.state.archivedCharacters;
          expect(current).toHaveLength(1);
          expect(current[0]).toMatchObject({
            id: 'hero',
            syncId: id,
            level: 42,
            notes: 'МЕСТНАЯ ПРАВКА ПРИ ПЕРЕМЕЩЕНИИ',
            contacts: { password: 'NEW_LOCAL_PASSWORD_NOT_CONSENTED' },
            launch: { gcPath: '/private/path' },
            partyIds: ['party'],
            mainPartyId: 'party'
          });
          expect(f.state.marathons[0].participantIds).toEqual(['hero']);
          expect(
            Object.keys(localStorage).some(
              name => name.startsWith('tvinoferma_backup_') && localStorage.getItem(name) === before
            )
          ).toBe(true);
          expect(f.cloud.session.upload).toHaveBeenCalledTimes(privateCarry ? 1 : 0);
          expect(await f.queue()).toEqual({ status: 'queued' });
          expect(await f.send()).toEqual({ status: 'sent_verified' });
          const payload = await fixturePrivatePayload(f);
          expect(payload.publicSnapshot.sections.characters.records[0]).toMatchObject({
            id,
            archived: !restoring,
            fields: { level: 42 }
          });
          expect(JSON.stringify(payload)).not.toContain('NEW_LOCAL_PASSWORD_NOT_CONSENTED');
          if (privateCarry) expect(payload.privateSnapshot.records[0].fields.password).toBe('PRIVATE_PASSWORD');
          else expect(payload.privateSnapshot).toBeUndefined();
          expect((await inspectMergeQueue(f, provider)).pendingCount).toBe(0);
        }, 30000);
      }
});

// Synthetic native storage and providers, not a live API or two real PCs.
describe.each(['google', 'yandex'])('%s: сохранить местную задачу новой копией вместо облачного удаления', provider => {
  for (const phase of ['queued', 'prepared'])
    for (const privateCarry of [false, true])
      for (const interrupted of [false, true]) {
        it(`очередь ${phase}; carry=${privateCarry}; прерывание=${interrupted}`, async () => {
          const f = await publicationFixture(provider);
          f.state.plannerEntries[0].title = 'МЕСТНАЯ ПРАВКА ДЛЯ НОВОЙ ЗАДАЧИ';
          f.state.plannerEntries[0].recurrence = 'daily';
          f.state.plannerEntries[0].statusByDate = { '2026-10-30': 'done' };
          f.state.characters[0].notes = 'НЕЗАВИСИМАЯ ЗАМЕТКА';
          await f.storage.saveNow();
          expect((await f.queue()).status).toBe('queued');
          if (phase === 'prepared') {
            f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
            expect((await f.send()).status).toBe('deferred');
          }
          const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
          const root = (await inspectMergeQueue(f, provider)).confirmedPin;
          const oldId = f.state.plannerEntries[0].syncId;
          const remote = privateCarry
            ? await incomingPrivateCarry(f, provider, s => {
                s.sections.planner.records = [];
                s.sections.planner.order = [];
              })
            : await incomingPlannerDeletionForMerge(f, provider, root);
          const before = localStorage.getItem(STORAGE_KEY),
            queueBefore = structuredClone(f.fake.queue(provider));
          const extra = privateCarry ? { privateCarryConfirmed: true } : {};
          const preview = await mergePin(f, provider, remote.pin, extra);
          expect(preview.status).toBe('conflicts');
          expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
          expect(f.fake.queue(provider)).toEqual(queueBefore);
          const newId = generateSyncId(webcrypto);
          const resolution = {
            reviewHash: preview.reviewHash,
            cloudRecords: [],
            cloudSettings: [],
            cloudFinanceSettings: false,
            plannerCopies: [{ id: oldId, newId }]
          };
          let current = f.state;
          if (interrupted) {
            f.fake.loseNextCompare();
            expect((await mergePin(f, provider, remote.pin, { ...extra, resolution })).status).toBe(
              'journal_uncertain'
            );
            expect(f.state.settings.cloudSyncPendingMerge).toMatchObject({
              version: 5,
              privateCarryConfirmed: privateCarry,
              resolution: { plannerCopies: [{ id: oldId, newId }] }
            });
            expect(JSON.stringify(f.state.settings.cloudSyncPendingMerge)).not.toContain('МЕСТНАЯ ПРАВКА');
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            vi.resetModules();
            const { state, normalizeState } = await import('../js/core/state.js');
            Object.assign(state, normalizeState(saved));
            current = state;
            const publication = await import('../js/modules/cloudSync/connectedPublication.js');
            expect(
              (
                await publication.queueConnectedSavedSnapshot({
                  provider,
                  invoke: f.fake.invoke,
                  cryptoSource: webcrypto
                })
              ).status
            ).toBe('provenance_review_required');
            expect(
              (
                await mergePin(f, provider, remote.pin, {
                  resolution: { ...resolution, plannerCopies: [{ id: oldId, newId: generateSyncId(webcrypto) }] }
                })
              ).status
            ).toBe('merge_intent_mismatch');
          }
          expect((await mergePin(f, provider, remote.pin, interrupted ? {} : { ...extra, resolution })).status).toBe(
            'merged'
          );
          expect(current.plannerEntries).toEqual([
            expect.objectContaining({
              syncId: newId,
              title: 'МЕСТНАЯ ПРАВКА ДЛЯ НОВОЙ ЗАДАЧИ',
              recurrence: 'daily',
              statusByDate: { '2026-10-30': 'done' }
            })
          ]);
          expect(current.characters[0]).toMatchObject({
            notes: 'НЕЗАВИСИМАЯ ЗАМЕТКА',
            contacts: { password: 'PRIVATE_PASSWORD' }
          });
          expect(current.settings.cloudSyncPendingMerge).toBeUndefined();
          expect(
            Object.keys(localStorage).some(
              key => key.startsWith('tvinoferma_backup_') && localStorage.getItem(key) === before
            )
          ).toBe(true);
          expect((await mergePin(f, provider, remote.pin)).status).toBe('already_on_base');
          expect(current.plannerEntries).toHaveLength(1);
          const publication = await import('../js/modules/cloudSync/connectedPublication.js');
          const options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
          expect((await publication.queueConnectedSavedSnapshot({ ...options, prepareIdentities: true })).status).toBe(
            'queued'
          );
          expect(
            (await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).status
          ).toBe('sent_verified');
          const payload = await fixturePrivatePayload(f);
          expect(payload.plannerTombstones).toContain(oldId);
          expect(payload.publicSnapshot.sections.planner.records).toEqual([
            expect.objectContaining({
              id: newId,
              fields: expect.objectContaining({ title: 'МЕСТНАЯ ПРАВКА ДЛЯ НОВОЙ ЗАДАЧИ' })
            })
          ]);
          expect(JSON.stringify(payload.publicSnapshot)).not.toContain('PRIVATE_PASSWORD');
          if (privateCarry) expect(payload.privateSnapshot.records[0].fields.password).toBe('REMOTE_CARRY_SECRET');
          else expect(payload.privateSnapshot).toBeUndefined();
          expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
        }, 30000);
      }
  it('отклоняет устаревший выбор после новой местной правки и оставляет старую задачу', async () => {
    const f = await publicationFixture(provider);
    const root = (await inspectMergeQueue(f, provider)).confirmedPin;
    f.state.plannerEntries[0].title = 'ПЕРВАЯ ПРАВКА';
    await f.storage.saveNow();
    await f.queue();
    const remote = await incomingPlannerDeletionForMerge(f, provider, root);
    const conflict = await mergePin(f, provider, remote.pin);
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const resolution = {
      reviewHash: conflict.reviewHash,
      cloudRecords: [],
      cloudSettings: [],
      cloudFinanceSettings: false,
      plannerCopies: [{ id: remote.id, newId: generateSyncId(webcrypto) }]
    };
    f.state.plannerEntries[0].title = 'БОЛЕЕ НОВАЯ ПРАВКА';
    await f.storage.saveNow();
    await f.queue();
    const queue = structuredClone(f.fake.queue(provider));
    expect((await mergePin(f, provider, remote.pin, { resolution })).status).toBe('conflicts_changed');
    expect(f.fake.queue(provider)).toEqual(queue);
    expect(f.state.plannerEntries[0].title).toBe('БОЛЕЕ НОВАЯ ПРАВКА');
    expect(f.state.settings.cloudSyncPendingMerge).toBeUndefined();
  }, 30000);
});

describe.each(['google', 'yandex'])('%s: новая копия после ранее выбранного удаления другой задачи', provider => {
  it('восстанавливает v5 с apply-хешем, не теряет очередь и снимает обе отметки', async () => {
    const f = await publicationFixture(provider, {
      prepare: async f => {
        const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
        f.state.plannerEntries.push({
          ...structuredClone(f.state.plannerEntries[0]),
          id: 'second',
          syncId: generateSyncId(webcrypto),
          title: 'ВТОРАЯ ЗАДАЧА'
        });
        await f.storage.saveNow();
      }
    });
    const removedId = f.state.plannerEntries[0].syncId,
      sourceId = f.state.plannerEntries[1].syncId;
    f.state.plannerEntries[1].title = 'КОПИРОВАТЬ ЭТУ МЕСТНУЮ ПРАВКУ';
    await f.storage.saveNow();
    expect((await f.queue()).status).toBe('queued');
    const remote = await incomingPrivateCarry(f, provider, s => {
      s.sections.planner.records = [];
      s.sections.planner.order = [];
    });
    const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
    const review = await fixturePrivateReview(f, provider);
    expect(
      (
        await stageReviewedCloudApply({
          review,
          pin: remote.pin,
          selectedRecords: [],
          selectedPlannerDeletions: [removedId],
          cryptoSource: webcrypto
        }).commit({ confirmed: true })
      ).status
    ).toBe('applied');
    const preview = await mergePin(f, provider, remote.pin, { privateCarryConfirmed: true });
    expect(preview.status).toBe('conflicts');
    const { generateSyncId } = await import('../js/modules/cloudSync/envelope.js');
    const newId = generateSyncId(webcrypto);
    const resolution = {
      reviewHash: preview.reviewHash,
      cloudRecords: [],
      cloudSettings: [],
      cloudFinanceSettings: false,
      plannerCopies: [{ id: sourceId, newId }]
    };
    f.fake.loseNextCompare();
    expect((await mergePin(f, provider, remote.pin, { resolution, privateCarryConfirmed: true })).status).toBe(
      'journal_uncertain'
    );
    expect(f.state.settings.cloudSyncPendingMerge).toMatchObject({
      version: 5,
      appliedIntentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      privateCarryConfirmed: true
    });
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(saved));
    expect((await mergePin(f, provider, remote.pin)).status).toBe('merged');
    expect(state.plannerEntries).toEqual([
      expect.objectContaining({ syncId: newId, title: 'КОПИРОВАТЬ ЭТУ МЕСТНУЮ ПРАВКУ' })
    ]);
    expect(state.settings.cloudSyncPendingMerge).toBeUndefined();
    expect(state.settings.cloudSyncPendingApply).toBeUndefined();
    const publication = await import('../js/modules/cloudSync/connectedPublication.js');
    const options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
    expect((await publication.queueConnectedSavedSnapshot({ ...options, prepareIdentities: true })).status).toBe(
      'queued'
    );
    expect(
      (await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).status
    ).toBe('sent_verified');
    const payload = await fixturePrivatePayload(f);
    expect(payload.plannerTombstones).toEqual([removedId, sourceId].sort());
    expect(payload.privateSnapshot.records[0].fields.password).toBe('REMOTE_CARRY_SECRET');
    expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
  }, 30000);
});

// Mirrors the native archive action using the same pure membership helpers.
async function fixturePartyMove(state, restoring = false) {
  const { setMembership, setMainParty } = await import('../js/modules/parties/membership.js');
  const all = [...state.characters, ...state.archivedCharacters];
  if (!restoring) {
    const party = state.parties.find(row => row.id === 'party'),
      memberLinks = [];
    for (const char of all)
      if (char.partyIds.includes('party')) {
        memberLinks.push({
          characterId: char.id,
          isMain: char.mainPartyId === 'party',
          order: Number.isFinite(Number(char.partyOrder.party)) ? Number(char.partyOrder.party) : null
        });
        setMembership(char, 'party', false);
        delete char.partyOrder.party;
      }
    state.parties = state.parties.filter(row => row.id !== 'party');
    state.archivedParties = [...state.archivedParties, { ...party, memberLinks }].sort((a, b) => a.order - b.order);
  } else {
    const party = state.archivedParties.find(row => row.id === 'party');
    for (const link of party.memberLinks) {
      const char = all.find(row => row.id === link.characterId);
      setMembership(char, 'party', true);
      if (link.isMain) setMainParty(char, 'party');
      if (link.order !== null) char.partyOrder.party = link.order;
    }
    const { memberLinks, ...active } = party;
    state.archivedParties = state.archivedParties.filter(row => row.id !== 'party');
    state.parties = [...state.parties, active].sort((a, b) => a.order - b.order);
  }
}
async function partyArchiveFixture(provider, restoring = false) {
  return publicationFixture(provider, {
    prepare: async f => {
      const { normalizeState } = await import('../js/core/state.js');
      const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
      const { ui, ...raw } = structuredClone({ ...f.state, ui: null });
      raw.parties = [
        { id: 'party', name: 'Пати', order: 1 },
        { id: 'other', name: 'Другая', order: 2 }
      ];
      raw.archivedParties = [{ id: 'old-archive', name: 'Старый архив', order: 3, memberLinks: [] }];
      Object.assign(raw.characters[0], {
        partyIds: ['party', 'other'],
        mainPartyId: 'party',
        partyOrder: { party: 7, other: 11 }
      });
      const archived = {
        ...structuredClone(raw.characters[0]),
        id: 'archived',
        nick: 'Архивный',
        partyIds: ['party'],
        mainPartyId: 'party',
        partyOrder: { party: 9 }
      };
      delete archived.syncId;
      raw.archivedCharacters = [archived];
      const { ui: ignored, ...normalized } = normalizeState(raw);
      Object.assign(f.state, planSyncIdentities({ snapshot: normalized, cryptoSource: webcrypto }).snapshot);
      if (restoring) await fixturePartyMove(f.state);
      await f.storage.saveNow();
    }
  });
}

describe.each(['google', 'yandex'])('%s: архив и восстановление пати через очередь и backup', provider => {
  for (const restoring of [false, true])
    for (const side of ['local', 'cloud'])
      for (const privateCarry of [false, true])
        for (const interrupted of [false, true]) {
          it(`${restoring ? 'восстановление' : 'архив'} на ${side}; carry=${privateCarry}; прерывание=${interrupted}`, async () => {
            const f = await partyArchiveFixture(provider, restoring);
            const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
            const { currentCloudStateSnapshot } = await import('../js/modules/cloudSync/guardedStateWrite.js');
            const remoteRaw = currentCloudStateSnapshot();
            if (side === 'local') await fixturePartyMove(f.state, restoring);
            else await fixturePartyMove(remoteRaw, restoring);
            f.state.characters[0].notes = 'НЕЗАВИСИМАЯ МЕСТНАЯ ЗАМЕТКА';
            remoteRaw.characters[0].level = 42;
            [...remoteRaw.parties, ...remoteRaw.archivedParties].find(row => row.id === 'party').name =
              'Облачное имя пати';
            await f.storage.saveNow();
            expect((await f.queue()).status).toBe('queued');
            if (interrupted) {
              f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
              expect((await f.send()).status).toBe('deferred');
            }
            const remotePublic = buildPublicSnapshot(remoteRaw),
              root = (await inspectMergeQueue(f, provider)).confirmedPin;
            const remote = privateCarry
              ? await incomingPrivateCarry(f, provider, s => Object.assign(s, remotePublic))
              : { pin: await mergeIncoming(f, provider, root, s => Object.assign(s, remotePublic)) };
            const before = localStorage.getItem(STORAGE_KEY);
            let current = f.state;
            const extra = privateCarry ? { privateCarryConfirmed: true } : {};
            if (interrupted) {
              f.fake.loseNextCompare();
              expect((await mergePin(f, provider, remote.pin, extra)).status).toBe('journal_uncertain');
              const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
              vi.resetModules();
              const { state, normalizeState } = await import('../js/core/state.js');
              Object.assign(state, normalizeState(saved));
              current = state;
              const publication = await import('../js/modules/cloudSync/connectedPublication.js');
              expect(
                (
                  await publication.queueConnectedSavedSnapshot({
                    provider,
                    invoke: f.fake.invoke,
                    cryptoSource: webcrypto
                  })
                ).status
              ).toBe('provenance_review_required');
            }
            expect((await mergePin(f, provider, remote.pin, interrupted ? {} : extra)).status).toBe('merged');
            expect((restoring ? current.parties : current.archivedParties).find(row => row.id === 'party').name).toBe(
              'Облачное имя пати'
            );
            expect(current.characters[0]).toMatchObject({
              notes: 'НЕЗАВИСИМАЯ МЕСТНАЯ ЗАМЕТКА',
              level: 42,
              mainPartyId: restoring ? 'party' : 'other',
              partyOrder: restoring ? { party: 7, other: 11 } : { other: 11 },
              contacts: { password: 'PRIVATE_PASSWORD' },
              launch: { gcPath: '/private/path' }
            });
            expect(current.archivedCharacters[0]).toMatchObject({
              mainPartyId: restoring ? 'party' : null,
              partyIds: restoring ? ['party'] : []
            });
            expect(current.settings.cloudSyncPendingMerge).toBeUndefined();
            expect(
              Object.keys(localStorage).some(
                key => key.startsWith('tvinoferma_backup_') && localStorage.getItem(key) === before
              )
            ).toBe(true);
            const publication = await import('../js/modules/cloudSync/connectedPublication.js'),
              options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
            expect(
              (await publication.queueConnectedSavedSnapshot({ ...options, prepareIdentities: true })).status
            ).toBe('queued');
            expect(
              (await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).status
            ).toBe('sent_verified');
            expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
            const payload = await fixturePrivatePayload(f);
            expect(
              payload.publicSnapshot.sections.parties.records.find(row => row.fields.name === 'Облачное имя пати')
                .archived
            ).toBe(!restoring);
            if (privateCarry) expect(payload.privateSnapshot.records[0].fields.password).toBe('REMOTE_CARRY_SECRET');
            expect(JSON.stringify(payload.publicSnapshot)).not.toContain('PRIVATE_PASSWORD');
          }, 30000);
        }
  for (const field of ['main', 'order'])
    for (const useCloud of [false, true]) {
      it(`конфликт ${field}, выбор группы cloud=${useCloud} восстанавливается после CAS`, async () => {
        const f = await partyArchiveFixture(provider),
          root = (await inspectMergeQueue(f, provider)).confirmedPin;
        const partyId = f.state.parties[0].syncId,
          charId = f.state.characters[0].syncId;
        await fixturePartyMove(f.state);
        f.state.characters[0].notes = 'НЕ ТЕРЯТЬ ЗАМЕТКУ';
        await f.storage.saveNow();
        await f.queue();
        const remote = await mergeIncoming(f, provider, root, s => {
          const char = s.sections.characters.records.find(row => row.id === charId);
          char.fields.level = 42;
          if (field === 'main')
            char.fields.mainPartyId = s.sections.parties.records.find(row => row.fields.name === 'Другая').id;
          else char.fields.partyOrder[partyId] = 99;
        });
        const conflict = await mergePin(f, provider, remote);
        expect(conflict).toMatchObject({
          status: 'conflicts',
          conflicts: [{ reason: 'party-archive-membership', id: partyId }]
        });
        const resolution = {
          reviewHash: conflict.reviewHash,
          cloudRecords: useCloud ? [{ section: 'parties', id: partyId }] : [],
          cloudSettings: [],
          cloudFinanceSettings: false
        };
        f.fake.loseNextCompare();
        expect((await mergePin(f, provider, remote, { resolution })).status).toBe('journal_uncertain');
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        vi.resetModules();
        const { state, normalizeState } = await import('../js/core/state.js');
        Object.assign(state, normalizeState(saved));
        expect((await mergePin(f, provider, remote)).status).toBe('merged');
        expect(state.characters[0]).toMatchObject({ notes: 'НЕ ТЕРЯТЬ ЗАМЕТКУ', level: 42 });
        expect(state.archivedParties.some(row => row.id === 'party')).toBe(!useCloud);
        expect(state.characters[0].mainPartyId).toBe(useCloud && field === 'order' ? 'party' : 'other');
        expect(state.characters[0].partyOrder.party).toBe(useCloud ? (field === 'order' ? 99 : 7) : undefined);
        const publication = await import('../js/modules/cloudSync/connectedPublication.js'),
          options = { provider, invoke: f.fake.invoke, cryptoSource: webcrypto };
        expect((await publication.queueConnectedSavedSnapshot({ ...options, prepareIdentities: true })).status).toBe(
          'queued'
        );
        expect(
          (await publication.sendConnectedQueuedSnapshot({ ...options, openSession: f.cloud.openSession })).status
        ).toBe('sent_verified');
        expect((await inspectMergeQueue(f, provider)).retainedIntents).toEqual([]);
      }, 30000);
    }
});

describe.each(['google', 'yandex'])('%s: обмен полным файлом вместо объединения', provider => {
  async function api(f) {
    return {
      opts: { provider, invoke: f.fake.invoke, cryptoSource: webcrypto, openSession: f.cloud.openSession },
      ...(await import('../js/modules/cloudSync/snapshotFileExchange.js'))
    };
  }
  it('проверка не меняет state; отправка удалений сохраняет старый файл и новую основу', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.state.characters = [];
    f.state.plannerEntries = [];
    await f.storage.saveNow();
    const before = localStorage.getItem(STORAGE_KEY),
      review = await x.checkSnapshotFile(x.opts);
    expect(review.status).toBe('ready');
    expect(review.localChanged).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true })).status).toBe('sent_verified');
    expect(f.cloud.versions).toHaveLength(2);
    expect(f.cloud.versions.has(f.initialEnvelope.versionId)).toBe(true);
    const after = await x.checkSnapshotFile(x.opts);
    expect(after).toMatchObject({ status: 'ready', matches: true, localChanged: false, remoteChanged: false });
    expect((await f.queue()).status).toBe('snapshot_file_mode');
    expect((await f.send()).status).toBe('snapshot_file_mode');
  }, 30000);
  it('применяет полный файл с backup и сохраняет принятую основу до следующих местных правок', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.notes = 'С ДИСКА';
      s.sections.planner.records = [];
      s.sections.planner.order = [];
    });
    // The old v1 fixture is a full snapshot; only this explicit action treats absence as removal.
    const before = localStorage.getItem(STORAGE_KEY),
      review = await x.checkSnapshotFile(x.opts);
    expect(review.status).toBe('ready');
    expect((await x.replaceFromSnapshotFile({ ...x.opts, review, confirmed: false })).status).toBe(
      'confirmation_required'
    );
    const applied = await x.replaceFromSnapshotFile({ ...x.opts, review, confirmed: true });
    expect(applied.status).toBe('applied');
    expect(localStorage.getItem(applied.backup)).toBe(before);
    expect(f.state.plannerEntries).toEqual([]);
    expect(f.state.characters[0]).toMatchObject({
      notes: 'С ДИСКА',
      contacts: { password: 'PRIVATE_PASSWORD' },
      launch: { gcPath: '/private/path' }
    });
    const baseline = structuredClone(f.state.settings.cloudSnapshotFiles[provider]);
    f.state.characters[0].level = 42;
    await f.storage.saveNow();
    expect(await x.checkSnapshotFile(x.opts)).toMatchObject({
      status: 'ready',
      localChanged: true,
      remoteChanged: false,
      matches: false
    });
    expect(f.state.settings.cloudSnapshotFiles[provider]).toEqual(baseline);
  }, 30000);
  it('не заменяет непринятую облачную версию без дополнительного согласия', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 42;
    });
    f.state.characters[0].notes = 'МОЙ ФАЙЛ';
    await f.storage.saveNow();
    const review = await x.checkSnapshotFile(x.opts);
    expect(review.remoteChanged).toBe(true);
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true })).status).toBe(
      'overwrite_confirmation_required'
    );
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true, overwriteConfirmed: true })).status).toBe(
      'sent_verified'
    );
    const payload = await fixturePrivatePayload(f);
    expect(payload.publicSnapshot.sections.characters.records[0].fields).toMatchObject({ notes: 'МОЙ ФАЙЛ', level: 1 });
  }, 30000);
  it('отменяет устаревшее подтверждение при местной правке или смене файла', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      review = await x.checkSnapshotFile(x.opts);
    f.state.characters[0].notes = 'ПОСЛЕ ПРОСМОТРА';
    await f.storage.saveNow();
    expect((await x.replaceFromSnapshotFile({ ...x.opts, review, confirmed: true })).status).toBe(
      'state_changed_or_unsaved'
    );
    const current = await x.checkSnapshotFile(x.opts),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 42;
    });
    expect((await x.uploadSnapshotFile({ ...x.opts, review: current, confirmed: true })).status).toBe('remote_changed');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30000);
  it('после неизвестной загрузки и перезапуска только сверяет прежний файл, сохраняя новые местные правки', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.state.characters[0].notes = 'ОТПРАВЛЕННЫЙ ФАЙЛ';
    await f.storage.saveNow();
    f.cloud.loseNextUpload();
    f.cloud.setVerify(false);
    const review = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true })).status).toBe('verification_pending');
    expect(f.state.settings.cloudSnapshotFiles[provider].pending.phase).toBe('attempting');
    f.state.characters[0].notes = 'НОВАЯ МЕСТНАЯ ПРАВКА';
    await f.storage.saveNow();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(raw));
    const next = await import('../js/modules/cloudSync/snapshotFileExchange.js');
    f.cloud.setVerify(true);
    expect((await next.resumeSnapshotFileUpload({ ...x.opts, confirmed: true })).status).toBe('sent_verified');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    expect(state.characters[0].notes).toBe('НОВАЯ МЕСТНАЯ ПРАВКА');
    expect(await next.checkSnapshotFile(x.opts)).toMatchObject({ status: 'ready', localChanged: true });
  }, 30000);
  it('не выбрасывает прежнюю зашифрованную очередь при переходе', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.state.characters[0].notes = 'СТАРАЯ ОЧЕРЕДЬ';
    await f.storage.saveNow();
    await f.queue();
    const before = f.fake.queue(provider).record;
    expect((await x.checkSnapshotFile(x.opts)).status).toBe('legacy_queue_pending');
    expect(f.fake.queue(provider).record).toBe(before);
    expect(f.state.settings.cloudSnapshotFiles).toBeUndefined();
  }, 30000);
  it('два расходящихся файла не выбираются по дате и не перезаписываются', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 10;
    });
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 20;
    });
    expect((await x.checkSnapshotFile(x.opts)).status).toBe('multiple_files');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30000);
  it.each([false, true])(
    'восстанавливает новый полный файл на втором fake ПК без прежнего объединения (выбор конкурирующих: %s)',
    async withChoice => {
      const source = await publicationFixture(provider),
        sx = await api(source);
      const { pairingCode } = await source.readLocalCloudPairingCode({
        provider,
        invoke: source.fake.invoke,
        cryptoSource: webcrypto
      });
      source.state.characters[0].notes = 'СНИМОК С ПЕРВОГО ПК';
      source.state.plannerEntries = [];
      await source.storage.saveNow();
      let view;
      if (withChoice) {
        const root = (await inspectMergeQueue(source, provider)).confirmedPin;
        await mergeIncoming(source, provider, root, s => {
          s.sections.characters.records[0].fields.level = 10;
        });
        await mergeIncoming(source, provider, root, s => {
          s.sections.characters.records[0].fields.level = 20;
        });
        const variants = await sx.checkSnapshotFile(sx.opts);
        view = await sx.checkSnapshotFile({ ...sx.opts, choice: variants.choices[0] });
      } else view = await sx.checkSnapshotFile(sx.opts);
      expect(
        (
          await sx.uploadSnapshotFile({
            ...sx.opts,
            review: view,
            confirmed: true,
            ...(withChoice ? { resolutionConfirmed: true, overwriteConfirmed: true } : {})
          })
        ).status
      ).toBe('sent_verified');
      const target = await fixture();
      target.state.characters = [];
      target.state.plannerEntries = [];
      await target.storage.saveNow();
      const recovery = target.createCloudRecovery({
        provider,
        invoke: target.fake.invoke,
        cryptoSource: webcrypto,
        openSession: source.cloud.openSession
      });
      const attempt = await recovery.begin({
        pairingCode,
        independentPinConfirmed: true,
        role: 'main',
        secret: mainSecret
      });
      expect(attempt.status).toBe('ready_for_confirmation');
      expect((await attempt.connect({ confirmed: true })).status).toBe('connected');
      const exchange = await import('../js/modules/cloudSync/snapshotFileExchange.js'),
        opts = { provider, invoke: target.fake.invoke, cryptoSource: webcrypto, openSession: source.cloud.openSession };
      const incoming = await exchange.checkSnapshotFile(opts);
      expect(incoming.status).toBe('ready');
      expect((await exchange.replaceFromSnapshotFile({ ...opts, review: incoming, confirmed: true })).status).toBe(
        'applied'
      );
      expect(target.state.characters[0].notes).toBe('СНИМОК С ПЕРВОГО ПК');
      expect(target.state.characters[0].contacts.password).not.toBe('PRIVATE_PASSWORD');
      expect(await exchange.checkSnapshotFile(opts)).toMatchObject({
        status: 'ready',
        matches: true,
        localChanged: false,
        remoteChanged: false
      });
    },
    30000
  );
  it('сохраняет ранее переданную приватную часть только с отдельным согласием', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    await incomingPrivateCarry(f, provider);
    const review = await x.checkSnapshotFile(x.opts);
    expect(review.privateCarry).toBe(true);
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true, overwriteConfirmed: true })).status).toBe(
      'private_confirmation_required'
    );
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          overwriteConfirmed: true,
          privateCarryConfirmed: true
        })
      ).status
    ).toBe('sent_verified');
    expect((await fixturePrivatePayload(f)).privateSnapshot.records[0].fields.password).toBe('REMOTE_CARRY_SECRET');
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
  }, 30000);
  it('после остановки до загрузки возобновляет тот же подготовленный файл', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      list = f.cloud.session.listWithDates;
    let fail = true;
    f.cloud.session.listWithDates = vi.fn(async () =>
      fail && f.state.settings.cloudSnapshotFiles?.[provider]?.pending?.phase === 'prepared'
        ? { status: 'unavailable' }
        : list()
    );
    const review = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true })).status).toBe('unavailable_or_changed');
    expect(f.state.settings.cloudSnapshotFiles[provider].pending.phase).toBe('prepared');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    const pendingId = f.state.settings.cloudSnapshotFiles[provider].pending.pin.versionId;
    fail = false;
    expect((await x.resumeSnapshotFileUpload({ ...x.opts, confirmed: true })).status).toBe('sent_verified');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    expect(f.cloud.versions.has(pendingId)).toBe(true);
  }, 30000);
  it('при подтверждённом not_sent оставляет файл подготовленным для следующего ручного запроса', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    const review = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true })).status).toBe('upload_deferred');
    expect(f.state.settings.cloudSnapshotFiles[provider].pending.phase).toBe('prepared');
    expect((await x.resumeSnapshotFileUpload({ ...x.opts, confirmed: true })).status).toBe('sent_verified');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(2);
  }, 30000);
  it('отменяет подготовленный файл без сети с backup, затем отправляет актуальные данные отдельным файлом', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    const first = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review: first, confirmed: true })).status).toBe('upload_deferred');
    const oldId = f.state.settings.cloudSnapshotFiles[provider].pending.pin.versionId;
    f.state.characters[0].notes = 'ТЕКУЩИЕ ДАННЫЕ';
    await f.storage.saveNow();
    const before = localStorage.getItem(STORAGE_KEY),
      calls = f.cloud.openSession.mock.calls.length;
    const review = await x.inspectSnapshotFileUpload(x.opts);
    expect(review.phase).toBe('prepared');
    expect((await x.releaseSnapshotFileUpload({ ...x.opts, review, confirmed: true })).status).toBe(
      'prepared_cancelled'
    );
    expect(f.cloud.openSession).toHaveBeenCalledTimes(calls);
    expect(f.state.characters[0].notes).toBe('ТЕКУЩИЕ ДАННЫЕ');
    expect(f.state.settings.cloudSnapshotFiles[provider].pending).toBeNull();
    expect(Object.values(localStorage).includes(before)).toBe(true);
    const current = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review: current, confirmed: true })).status).toBe('sent_verified');
    expect(f.cloud.versions.has(oldId)).toBe(false);
    expect((await fixturePrivatePayload(f)).publicSnapshot.sections.characters.records[0].fields.notes).toBe(
      'ТЕКУЩИЕ ДАННЫЕ'
    );
  }, 30000);
  it('снимает неизвестное ожидание только с отдельным согласием; поздний файл разрешается явным выбором, без потери новой правки', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'unknown' });
    const first = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review: first, confirmed: true })).status).toBe(
      'verification_pending'
    );
    const old = structuredClone(f.state.settings.cloudSnapshotFiles[provider].pending),
      review = await x.inspectSnapshotFileUpload(x.opts);
    expect((await x.releaseSnapshotFileUpload({ ...x.opts, review, confirmed: true })).status).toBe(
      'unknown_acknowledgement_required'
    );
    expect(f.state.settings.cloudSnapshotFiles[provider].pending.phase).toBe('attempting');
    expect(
      (await x.releaseSnapshotFileUpload({ ...x.opts, review, confirmed: true, unknownOutcomeAcknowledged: true }))
        .status
    ).toBe('pending_released_uncertain');
    expect(f.state.settings.cloudSnapshotFiles[provider].unsettled[0].pin).toEqual(old.pin);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const freshState = await import('../js/core/state.js');
    Object.assign(freshState.state, freshState.normalizeState(stored));
    f.state = freshState.state;
    f.storage = await import('../js/core/storage.js');
    Object.assign(x, await import('../js/modules/cloudSync/snapshotFileExchange.js'));
    f.state.characters[0].notes = 'НОВЕЙШАЯ ПРАВКА';
    await f.storage.saveNow();
    const fresh = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review: fresh, confirmed: true })).status).toBe('sent_verified');
    const accepted = f.state.settings.cloudSnapshotFiles[provider].acceptedPin;
    f.cloud.versions.set(old.pin.versionId, old.envelope);
    const variants = await x.checkSnapshotFile(x.opts);
    expect(variants.status).toBe('multiple_files');
    const chosen = await x.checkSnapshotFile({
      ...x.opts,
      choice: variants.choices.find(c => c.pin.versionId === accepted.versionId)
    });
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review: chosen,
          confirmed: true,
          resolutionConfirmed: true,
          useCloudFile: true
        })
      ).status
    ).toBe('sent_verified');
    expect(f.state.characters[0].notes).toBe('НОВЕЙШАЯ ПРАВКА');
    expect(f.state.settings.cloudSnapshotFiles[provider].unsettled).toEqual([]);
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(3);
    expect(await x.checkSnapshotFile(x.opts)).toMatchObject({
      status: 'ready',
      matches: true,
      requiresResolution: false
    });
  }, 30000);
  it('выбирает полный облачный файл для диска, не меняя местные данные и не смешивая поля конкурирующих файлов', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    const a = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 10;
    });
    const b = await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 20;
    });
    const variants = await x.checkSnapshotFile(x.opts);
    expect(variants.choices).toHaveLength(2);
    expect((await x.checkSnapshotFile({ ...x.opts, choice: structuredClone(variants.choices[0]) })).status).toBe(
      'remote_changed'
    );
    const review = await x.checkSnapshotFile({
      ...x.opts,
      choice: variants.choices.find(c => c.pin.versionId === a.versionId)
    });
    expect(review.requiresResolution).toBe(true);
    expect(
      (await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true, overwriteConfirmed: true, useCloudFile: true }))
        .status
    ).toBe('resolution_confirmation_required');
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          overwriteConfirmed: true,
          resolutionConfirmed: true,
          useCloudFile: true
        })
      ).status
    ).toBe('sent_verified');
    expect(f.state.characters[0].level).toBe(1);
    expect(f.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    const payload = await fixturePrivatePayload(f);
    expect(payload.version).toBe(6);
    expect(payload.replacedHeads).toEqual([b]);
    expect(payload.publicSnapshot.sections.characters.records[0].fields.level).toBe(10);
    expect(f.cloud.versions.size).toBe(4);
    const incoming = await x.checkSnapshotFile(x.opts);
    expect(incoming.requiresResolution).toBe(false);
    expect((await x.replaceFromSnapshotFile({ ...x.opts, review: incoming, confirmed: true })).status).toBe('applied');
    expect(f.state.characters[0].level).toBe(10);
  }, 30000);
  it('при конкуренции позволяет выбрать текущий местный файл, не принимая значения выбранного облачного файла', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 10;
    });
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 20;
    });
    f.state.characters[0].notes = 'МЕСТНЫЙ ПОБЕДИТЕЛЬ';
    await f.storage.saveNow();
    const variants = await x.checkSnapshotFile(x.opts),
      review = await x.checkSnapshotFile({ ...x.opts, choice: variants.choices[0] });
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          overwriteConfirmed: true,
          resolutionConfirmed: true
        })
      ).status
    ).toBe('sent_verified');
    const fields = (await fixturePrivatePayload(f)).publicSnapshot.sections.characters.records[0].fields;
    expect(fields).toMatchObject({ level: 1, notes: 'МЕСТНЫЙ ПОБЕДИТЕЛЬ' });
  }, 30000);
  it('не применяет выбор, если список heads изменился после просмотра', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 10;
    });
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 20;
    });
    const variants = await x.checkSnapshotFile(x.opts),
      review = await x.checkSnapshotFile({ ...x.opts, choice: variants.choices[0] });
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 30;
    });
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          overwriteConfirmed: true,
          resolutionConfirmed: true,
          useCloudFile: true
        })
      ).status
    ).toBe('remote_changed');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
    expect((await x.checkSnapshotFile({ ...x.opts, choice: variants.choices[0] })).status).toBe('remote_changed');
  }, 30000);
  it('согласие на очистку pending не действует после местного изменения', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    const first = await x.checkSnapshotFile(x.opts);
    await x.uploadSnapshotFile({ ...x.opts, review: first, confirmed: true });
    const review = await x.inspectSnapshotFileUpload(x.opts);
    f.state.characters[0].notes = 'ПОСЛЕ СОГЛАСИЯ';
    await f.storage.saveNow();
    expect((await x.releaseSnapshotFileUpload({ ...x.opts, review, confirmed: true })).status).toBe(
      'state_changed_or_unsaved'
    );
    expect(f.state.settings.cloudSnapshotFiles[provider].pending.phase).toBe('prepared');
  }, 30000);
  it('подтверждённая отправка с конкурентным файлом завершается без зависания, но не объявляет единственного победителя', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      root = (await inspectMergeQueue(f, provider)).confirmedPin;
    const upload = f.cloud.session.upload.getMockImplementation();
    f.cloud.session.upload.mockImplementationOnce(async args => {
      const result = await upload(args);
      await mergeIncoming(f, provider, root, s => {
        s.sections.characters.records[0].fields.level = 30;
      });
      return result;
    });
    const first = await x.checkSnapshotFile(x.opts);
    expect((await x.uploadSnapshotFile({ ...x.opts, review: first, confirmed: true })).status).toBe(
      'sent_with_conflicts'
    );
    expect(f.state.settings.cloudSnapshotFiles[provider].pending).toBeNull();
    expect((await x.checkSnapshotFile(x.opts)).status).toBe('multiple_files');
  }, 30000);
  it('ошибка backup не очищает подготовленный файл', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.cloud.session.upload.mockResolvedValueOnce({ status: 'not_sent' });
    const first = await x.checkSnapshotFile(x.opts);
    await x.uploadSnapshotFile({ ...x.opts, review: first, confirmed: true });
    const before = structuredClone(f.state.settings.cloudSnapshotFiles[provider]),
      review = await x.inspectSnapshotFileUpload(x.opts);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('backup unavailable');
    });
    let result;
    try {
      result = await x.releaseSnapshotFileUpload({ ...x.opts, review, confirmed: true });
    } finally {
      spy.mockRestore();
    }
    expect(result.status).not.toBe('prepared_cancelled');
    expect(f.state.settings.cloudSnapshotFiles[provider]).toEqual(before);
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe.each(['google', 'yandex'])('%s: файловый ручной перенос контактов', provider => {
  async function api(f) {
    return {
      opts: { provider, invoke: f.fake.invoke, cryptoSource: webcrypto, openSession: f.cloud.openSession },
      ...(await import('../js/modules/cloudSync/snapshotFileExchange.js'))
    };
  }
  async function exportPassword(f, x, fields = ['password']) {
    const review = await x.checkSnapshotFile(x.opts),
      prepared = await x.prepareSnapshotFilePrivateExport({
        ...x.opts,
        review,
        fields,
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      });
    expect(prepared.status).toBe('private_export_review');
    const privateSelections = prepared.rows.map(({ characterId, field }) => ({ characterId, field }));
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          overwriteConfirmed: review.remoteChanged,
          privateCarryConfirmed: review.privateCarry,
          privateExport: prepared,
          privateSelections
        })
      ).status
    ).toBe('sent_verified');
    return { review, prepared, privateSelections };
  }
  it('передаёт только выбранные пары и не выгружает последующие местные изменения автоматически', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.state.characters[0].contacts.email = 'NEVER_SELECTED_EMAIL';
    await f.storage.saveNow();
    const review = await x.checkSnapshotFile(x.opts),
      prepared = await x.prepareSnapshotFilePrivateExport({
        ...x.opts,
        review,
        fields: ['password', 'email'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      });
    expect(JSON.stringify(prepared)).not.toContain('PRIVATE_PASSWORD');
    expect(JSON.stringify(prepared)).not.toContain('NEVER_SELECTED_EMAIL');
    const privateSelections = prepared.rows
      .filter(row => row.field === 'password')
      .map(({ characterId, field }) => ({ characterId, field }));
    expect(
      (await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true, privateExport: prepared, privateSelections }))
        .status
    ).toBe('sent_verified');
    expect((await fixturePrivatePayload(f)).privateSnapshot.records[0].fields).toEqual({
      password: 'PRIVATE_PASSWORD'
    });
    expect(JSON.stringify(f.cloud.session.upload.mock.calls)).not.toContain('PRIVATE_PASSWORD');
    f.state.characters[0].contacts.password = 'NEW_PASSWORD_NEVER_AUTO';
    f.state.characters[0].notes = 'PUBLIC_CHANGE';
    await f.storage.saveNow();
    const normal = await x.checkSnapshotFile(x.opts);
    expect(
      (await x.uploadSnapshotFile({ ...x.opts, review: normal, confirmed: true, privateCarryConfirmed: true })).status
    ).toBe('sent_verified');
    expect((await fixturePrivatePayload(f)).privateSnapshot.records[0].fields.password).toBe('PRIVATE_PASSWORD');
  }, 30000);
  it('не готовит пароли без отдельного риска и не использует отменённую capability', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      review = await x.checkSnapshotFile(x.opts);
    expect(
      (
        await x.prepareSnapshotFilePrivateExport({
          ...x.opts,
          review,
          fields: ['password'],
          contactsSourceConfirmed: true
        })
      ).status
    ).toBe('private_consent_required');
    const prepared = await x.prepareSnapshotFilePrivateExport({
      ...x.opts,
      review,
      fields: ['password'],
      contactsSourceConfirmed: true,
      acknowledgePasswordRisk: true
    });
    prepared.cancel();
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          privateExport: prepared,
          privateSelections: [{ characterId: f.state.characters[0].syncId, field: 'password' }]
        })
      ).status
    ).toBe('private_review_changed');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30000);
  it('останавливает устаревшую подготовку и недоступный источник вместо выгрузки пустых полей', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      review = await x.checkSnapshotFile(x.opts),
      prepared = await x.prepareSnapshotFilePrivateExport({
        ...x.opts,
        review,
        fields: ['password'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      });
    f.state.characters[0].contacts.password = 'CHANGED_AFTER_REVIEW';
    await f.storage.saveNow();
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          privateExport: prepared,
          privateSelections: [{ characterId: f.state.characters[0].syncId, field: 'password' }]
        })
      ).status
    ).toBe('state_changed_or_unsaved');
    f.state.settings.security.useVault = true;
    await f.storage.saveNow();
    const current = await x.checkSnapshotFile(x.opts);
    expect(
      (
        await x.prepareSnapshotFilePrivateExport({
          ...x.opts,
          review: current,
          fields: ['password'],
          contactsSourceConfirmed: true,
          acknowledgePasswordRisk: true
        })
      ).status
    ).toBe('private_source_unavailable');
    expect(f.cloud.session.upload).not.toHaveBeenCalled();
  }, 30000);
  it('передаёт выбранную пустую строку как явную очистку, сохраняя не выбранные категории', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    f.state.characters[0].contacts.email = 'KEEP_CLOUD_EMAIL';
    await f.storage.saveNow();
    await exportPassword(f, x, ['password', 'email']);
    f.state.characters[0].contacts.password = '';
    f.state.characters[0].contacts.email = 'NOT_EXPORTED_NEW_EMAIL';
    await f.storage.saveNow();
    const { prepared } = await exportPassword(f, x);
    expect(prepared.rows[0].clears).toBe(true);
    expect((await fixturePrivatePayload(f)).privateSnapshot.records[0].fields).toEqual({
      password: '',
      email: 'KEEP_CLOUD_EMAIL'
    });
  }, 30000);
  it('удаляет публичного персонажа с приватной частью только после отдельного согласия v7', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    await exportPassword(f, x);
    const charId = f.state.characters[0].syncId;
    f.state.characters = [];
    await f.storage.saveNow();
    const review = await x.checkSnapshotFile(x.opts);
    expect(review.privateOrphans).toBe(1);
    expect(
      (await x.uploadSnapshotFile({ ...x.opts, review, confirmed: true, privateCarryConfirmed: true })).status
    ).toBe('private_pruning_confirmation_required');
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          privateCarryConfirmed: true,
          privatePruningConfirmed: true
        })
      ).status
    ).toBe('sent_verified');
    const payload = await fixturePrivatePayload(f);
    expect(payload.version).toBe(7);
    expect(payload.privatePrunedIds).toEqual([charId]);
    expect(payload.privateSnapshot).toBeUndefined();
    expect(payload.publicSnapshot.sections.characters.records).toEqual([]);
  }, 30000);
  it('после неизвестной приватной загрузки сохраняет партию в шифртексте и только сверяет её после перезапуска', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      review = await x.checkSnapshotFile(x.opts),
      prepared = await x.prepareSnapshotFilePrivateExport({
        ...x.opts,
        review,
        fields: ['password'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      });
    f.cloud.loseNextUpload();
    f.cloud.setVerify(false);
    expect(
      (
        await x.uploadSnapshotFile({
          ...x.opts,
          review,
          confirmed: true,
          privateExport: prepared,
          privateSelections: [{ characterId: f.state.characters[0].syncId, field: 'password' }]
        })
      ).status
    ).toBe('verification_pending');
    const pending = f.state.settings.cloudSnapshotFiles[provider].pending;
    expect(JSON.stringify(pending)).not.toContain('PRIVATE_PASSWORD');
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    vi.resetModules();
    const { state, normalizeState } = await import('../js/core/state.js');
    Object.assign(state, normalizeState(raw));
    const storage = await import('../js/core/storage.js');
    state.characters[0].contacts.password = 'NEW_LOCAL_AFTER_RESTART';
    await storage.saveNow();
    const next = await import('../js/modules/cloudSync/snapshotFileExchange.js');
    f.cloud.setVerify(true);
    expect((await next.resumeSnapshotFileUpload({ ...x.opts, confirmed: true })).status).toBe('sent_verified');
    expect(f.cloud.session.upload).toHaveBeenCalledTimes(1);
    expect(state.characters[0].contacts.password).toBe('NEW_LOCAL_AFTER_RESTART');
  }, 30000);
  it('на втором чистом профиле применяет только выбранный пароль с отдельным backup, не принимая публичную базу этим действием', async () => {
    const source = await publicationFixture(provider),
      sx = await api(source);
    source.state.characters[0].contacts.email = 'SOURCE_EMAIL_NOT_IMPORTED';
    await source.storage.saveNow();
    const { pairingCode } = await source.readLocalCloudPairingCode({
      provider,
      invoke: source.fake.invoke,
      cryptoSource: webcrypto
    });
    await exportPassword(source, sx, ['password', 'email']);
    const target = await fixture(),
      recovery = target.createCloudRecovery({
        provider,
        invoke: target.fake.invoke,
        cryptoSource: webcrypto,
        openSession: source.cloud.openSession
      });
    const attempt = await recovery.begin({
      pairingCode,
      independentPinConfirmed: true,
      role: 'main',
      secret: mainSecret
    });
    expect((await attempt.connect({ confirmed: true })).status).toBe('connected');
    const exchange = await import('../js/modules/cloudSync/snapshotFileExchange.js'),
      opts = { provider, invoke: target.fake.invoke, cryptoSource: webcrypto, openSession: source.cloud.openSession };
    const full = await exchange.checkSnapshotFile(opts);
    expect((await exchange.replaceFromSnapshotFile({ ...opts, review: full, confirmed: true })).status).toBe('applied');
    target.state.characters[0].contacts.email = 'TARGET_EMAIL';
    await target.storage.saveNow();
    const publicView = await exchange.checkSnapshotFile(opts),
      review = await exchange.checkSnapshotFilePrivate({
        ...opts,
        review: publicView,
        fields: ['password', 'email'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      });
    expect(review.status).toBe('private_ready');
    expect(JSON.stringify(review)).not.toContain('PRIVATE_PASSWORD');
    expect(JSON.stringify(review)).not.toContain('SOURCE_EMAIL_NOT_IMPORTED');
    const selections = review.rows
        .filter(row => row.field === 'password')
        .map(({ characterId, field }) => ({ characterId, field })),
      baseline = structuredClone(target.state.settings.cloudSnapshotFiles),
      before = localStorage.getItem(STORAGE_KEY);
    const consent = {
      ...opts,
      review,
      selections,
      confirmed: true,
      contactsSourceConfirmed: true,
      acknowledgePasswordRisk: true,
      independentBackupConfirmed: false
    };
    expect((await exchange.applySnapshotFilePrivate(consent)).status).toBe('private_backup_required');
    const applied = await exchange.applySnapshotFilePrivate({ ...consent, independentBackupConfirmed: true });
    expect(applied.status).toBe('applied');
    expect(localStorage.getItem(applied.backup)).toBe(before);
    expect(target.state.characters[0].contacts).toMatchObject({ password: 'PRIVATE_PASSWORD', email: 'TARGET_EMAIL' });
    expect(target.state.settings.cloudSnapshotFiles).toEqual(baseline);
  }, 30000);
  it('не применяет контакты после изменения файла в облаке', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    await exportPassword(f, x);
    f.state.characters[0].contacts.password = 'OTHER_LOCAL';
    await f.storage.saveNow();
    const publicView = await x.checkSnapshotFile(x.opts),
      review = await x.checkSnapshotFilePrivate({
        ...x.opts,
        review: publicView,
        fields: ['password'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      });
    const root = (await inspectMergeQueue(f, provider)).confirmedPin;
    await mergeIncoming(f, provider, root, s => {
      s.sections.characters.records[0].fields.level = 20;
    });
    const selections = review.rows.map(({ characterId, field }) => ({ characterId, field }));
    expect(
      (
        await x.applySnapshotFilePrivate({
          ...x.opts,
          review,
          selections,
          confirmed: true,
          contactsSourceConfirmed: true,
          acknowledgePasswordRisk: true,
          independentBackupConfirmed: true
        })
      ).status
    ).toBe('remote_changed');
    expect(f.state.characters[0].contacts.password).toBe('OTHER_LOCAL');
  }, 30000);
  it('частичное применение контактов не принимает непринятые публичные правки на другом профиле', async () => {
    const source = await publicationFixture(provider),
      sx = await api(source),
      sourceId = source.state.characters[0].syncId;
    source.state.characters[0].notes = 'UNACCEPTED_PUBLIC_UPDATE';
    await source.storage.saveNow();
    const { pairingCode } = await source.readLocalCloudPairingCode({
      provider,
      invoke: source.fake.invoke,
      cryptoSource: webcrypto
    });
    await exportPassword(source, sx);
    const target = await fixture();
    target.state.characters[0].syncId = sourceId;
    target.state.characters[0].contacts.password = 'LOCAL_OLD';
    target.state.characters[0].notes = 'MY_LOCAL_NOTE';
    await target.storage.saveNow();
    const recovery = target.createCloudRecovery({
        provider,
        invoke: target.fake.invoke,
        cryptoSource: webcrypto,
        openSession: source.cloud.openSession
      }),
      attempt = await recovery.begin({ pairingCode, independentPinConfirmed: true, role: 'main', secret: mainSecret });
    await attempt.connect({ confirmed: true });
    const exchange = await import('../js/modules/cloudSync/snapshotFileExchange.js'),
      opts = { provider, invoke: target.fake.invoke, cryptoSource: webcrypto, openSession: source.cloud.openSession };
    const publicView = await exchange.checkSnapshotFile(opts),
      review = await exchange.checkSnapshotFilePrivate({
        ...opts,
        review: publicView,
        fields: ['password'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: true
      }),
      selections = review.rows.map(({ characterId, field }) => ({ characterId, field }));
    expect(
      (
        await exchange.applySnapshotFilePrivate({
          ...opts,
          review,
          selections,
          confirmed: true,
          contactsSourceConfirmed: true,
          acknowledgePasswordRisk: true,
          independentBackupConfirmed: true
        })
      ).status
    ).toBe('applied');
    expect(target.state.characters[0].notes).toBe('MY_LOCAL_NOTE');
    expect(target.state.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(target.state.settings.cloudSnapshotFiles[provider]).toMatchObject({ acceptedPin: null, acceptedHash: null });
  }, 30000);
  it('не позволяет прежнему приватному отправителю создавать очередь после перехода', async () => {
    const f = await publicationFixture(provider),
      x = await api(f);
    await exportPassword(f, x);
    const before = structuredClone(f.fake.queue(provider));
    const { stagePrivatePublication } = await import('../js/modules/cloudSync/privateTransfer.js');
    expect(
      (
        await stagePrivatePublication({
          provider,
          invoke: f.fake.invoke,
          cryptoSource: webcrypto,
          fields: ['password'],
          contactsSourceConfirmed: true,
          acknowledgePasswordRisk: true
        })
      ).status
    ).toBe('snapshot_file_mode');
    expect(f.fake.queue(provider)).toEqual(before);
  }, 30000);
  it('фиксирует категории до await: нельзя подменить email паролем без риска', async () => {
    const f = await publicationFixture(provider),
      x = await api(f),
      review = await x.checkSnapshotFile(x.opts),
      fields = ['email'];
    const pending = x.prepareSnapshotFilePrivateExport({
      ...x.opts,
      review,
      fields,
      contactsSourceConfirmed: true,
      acknowledgePasswordRisk: false
    });
    fields[0] = 'password';
    const prepared = await pending;
    expect(prepared.status).toBe('private_export_review');
    expect(prepared.fields).toEqual(['email']);
    expect(prepared.rows.every(row => row.field === 'email')).toBe(true);
    prepared.cancel();
  }, 30000);
});
