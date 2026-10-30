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

async function publicationFixture(provider) {
  const f = await fixture();
  const pending = await begin(f.setup(provider));
  await pending.confirmBackup({ secret: pending.generatedBackupSecret, savedSeparately: true });
  const initial = fakeSendSession(f, provider);
  expect(
    await f.sendInitialCloudRoot({
      provider,
      invoke: f.fake.invoke,
      confirmed: true,
      cryptoSource: webcrypto,
      openSession: initial.openSession
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
