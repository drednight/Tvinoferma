import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  openNativeCloudSession,
  openStoredNativeCloudSession,
  openStoredNativeGoogleFolderDiscovery,
  openStoredStandaloneGoogleFolder
} from '../js/modules/cloudSync/providers/nativeCloudSession.js';
import { prepareGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { prepareYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';
import { createNativeDatasetBindingStore } from '../js/modules/cloudSync/providers/nativeDatasetBindingStore.js';
import { openPinnedNativeCloudSession } from '../js/modules/cloudSync/providers/pinnedNativeCloudSession.js';
import { parseDatasetBindingRecord } from '../js/modules/cloudSync/datasetBindingRecord.js';
import { encryptSnapshot } from '../js/modules/cloudSync/envelope.js';
import { historyEnvelopePin, sealHistoryVersion } from '../js/modules/cloudSync/history.js';
import { createPairingCode, parsePairingCode } from '../js/modules/cloudSync/pairingCode.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { createKeyRecoverer } from '../js/modules/cloudSync/keyRecovery.js';
import { createKeyStateRecord, parseKeyStateRecord } from '../js/modules/cloudSync/keyStateRecord.js';
import { findPortableKeyVersions } from '../js/modules/cloudSync/portableKeyDiscovery.js';
import { prepareCloudReview } from '../js/modules/cloudSync/cloudReview.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { normalizeState } from '../js/core/state.js';
import { versionFileName } from '../js/modules/cloudSync/providers/common.js';

const slotId = '01234567-89ab-4cde-8f01-23456789abcd';
const revision = '11234567-89ab-4cde-8f01-23456789abcd';
const revision2 = '21234567-89ab-4cde-8f01-23456789abcd';
const datasetId = '31234567-89ab-4cde-8f01-23456789abcd';
const clients = { google: 'fake-client.apps.googleusercontent.com', yandex: '0123456789abcdef' };
const accountKey = 'FAKE_PRIVATE_ACCOUNT';
const access = 'FAKE_PRIVATE_ACCESS';
const refresh = 'FAKE_PRIVATE_REFRESH';

function fixture(
  provider,
  {
    lostRefresh = false,
    identity = accountKey,
    expiresAt = 3_700_000,
    folders = [],
    rootEnvelope = null,
    rootFolderIds = ['FOLDER_CANDIDATE']
  } = {}
) {
  const binding = { slotId, clientId: clients[provider], accountKey };
  let record =
    provider === 'google'
      ? prepareGoogleCredentialRecord({ ...binding, revision, refreshToken: refresh, refreshExpiresAt: null })
      : prepareYandexCredentialRecord({ ...binding, revision, accessToken: access, expiresAt });
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_credential_binding_read') return { status: 'ready', ...binding };
    if (command === 'cloud_credential_read') return { status: 'ready', slotId, record };
    if (command === 'cloud_credential_compare_exchange') {
      if (record !== args.expected) return { status: 'mismatch' };
      record = args.next;
      return { status: 'swapped' };
    }
    if (command === 'cloud_oauth_network' && args.operation === 'refresh') {
      if (args.refreshClaim.expected !== record) throw new Error('PRIVATE stale claim');
      expect(args.refreshClaim.slotId).toBe(slotId);
      record = args.refreshClaim.pending;
      expect(JSON.parse(record).phase).toBe('pending');
      if (lostRefresh) throw new Error('PRIVATE unknown reply');
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: OAUTH_PROVIDERS.google.scope
        })
      };
    }
    if (command === 'cloud_disk_network') {
      expect(args.args.provider).toBe(provider);
      if (args.args.operation === 'identity')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            provider === 'google'
              ? { user: { permissionId: identity } }
              : { client_id: clients.yandex, psuid: identity }
          )
        };
      if (args.args.operation === 'folder_list')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: folders, incompleteSearch: false })
        };
      if (args.args.operation === 'list')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            provider === 'google'
              ? {
                  files:
                    rootEnvelope &&
                    rootFolderIds.includes(args.args.folderId) &&
                    (!args.args.versionId || args.args.versionId === rootEnvelope.versionId)
                      ? [
                          {
                            id: 'ROOT_FILE_ID',
                            name: versionFileName(datasetId, rootEnvelope.versionId),
                            mimeType: 'application/octet-stream',
                            appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: rootEnvelope.versionId }
                          }
                        ]
                      : [],
                  incompleteSearch: false
                }
              : { type: 'dir', _embedded: { offset: args.args.offset, limit: args.args.limit, total: 0, items: [] } }
          )
        };
      if (args.args.operation === 'download' && args.args.fileId === 'ROOT_FILE_ID' && rootEnvelope)
        return { status: 200, contentType: 'application/octet-stream', body: JSON.stringify(rootEnvelope) };
    }
    throw new Error('PRIVATE unknown fake command');
  });
  return {
    invoke,
    record: () => record,
    replace(value) {
      record = value;
    },
    binding,
    options: {
      provider,
      ...binding,
      datasetId,
      invoke,
      cryptoSource: webcrypto,
      ...(provider === 'google' ? { folderId: 'fake-folder' } : {})
    }
  };
}
function noSecret(value) {
  const text = JSON.stringify(value);
  for (const secret of [accountKey, access, refresh, 'PRIVATE unknown']) expect(text).not.toContain(secret);
}

describe.each(['google', 'yandex'])('%s: открытая сессия только с fake IPC', provider => {
  it('сверяет сохранённую запись и аккаунт перед чтением, не выдавая токен', async () => {
    const f = fixture(provider);
    const opened = await openNativeCloudSession({ ...f.options, now: () => 100_000 });
    expect(opened.status).toBe('opened');
    noSecret(opened);
    const result = await opened.session.listWithDates();
    expect(result).toEqual({ status: 'listed', versions: [] });
    noSecret(result);
    const commands = f.invoke.mock.calls
      .filter(([command]) => command === 'cloud_disk_network')
      .map(([, args]) => args.args.operation);
    expect(commands.slice(-3)).toEqual(['identity', 'list', 'list']);
    opened.session.dispose();
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_unavailable' });
  });

  it('открывает сессию из ранее закреплённого pin без ручного ввода ID аккаунта', async () => {
    const f = fixture(provider);
    const { slotId: _slot, clientId: _client, accountKey: _account, ...options } = f.options;
    const opened = await openStoredNativeCloudSession({ ...options, now: () => 100_000 });
    expect(opened.status).toBe('opened');
    noSecret(opened);
    expect(await opened.session.listWithDates()).toEqual({ status: 'listed', versions: [] });
    expect(f.invoke.mock.calls[0][0]).toBe('cloud_credential_binding_read');
    opened.session.dispose();
  });

  it.each(['empty', 'blocked', 'pending'])('состояние pin %s останавливает открытие до OAuth и диска', async state => {
    const f = fixture(provider);
    const invoke = vi.fn(async (command, args) =>
      command === 'cloud_credential_binding_read' ? { status: state } : f.invoke(command, args)
    );
    const { slotId: _slot, clientId: _client, accountKey: _account, ...options } = f.options;
    const result = await openStoredNativeCloudSession({ ...options, invoke, now: () => 100_000 });
    expect(result).toEqual({ status: state === 'empty' ? 'credential_missing' : 'credential_blocked' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('подменённый или некорректный pin не передаёт токен и не запускает диск', async () => {
    const f = fixture(provider);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'cloud_credential_binding_read')
        return { status: 'ready', ...f.binding, accountKey: 'OTHER_ACCOUNT' };
      return f.invoke(command, args);
    });
    const { slotId: _slot, clientId: _client, accountKey: _account, ...options } = f.options;
    const result = await openStoredNativeCloudSession({ ...options, invoke, now: () => 100_000 });
    expect(result.status).not.toBe('opened');
    expect(
      f.invoke.mock.calls.some(([command]) => command === 'cloud_disk_network' || command === 'cloud_oauth_network')
    ).toBe(false);
  });

  it('не начинает запись, если локальная привязка изменилась или срок истёк', async () => {
    const f = fixture(provider);
    let time = 100_000;
    const opened = await openNativeCloudSession({ ...f.options, now: () => time });
    expect(opened.status).toBe('opened');
    const calls = f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network').length;
    const previous = JSON.parse(f.record());
    f.replace(JSON.stringify({ ...previous, revision: revision2 }));
    expect(await opened.session.upload({ envelope: {} })).toEqual({ status: 'account_unavailable' });
    expect(f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network')).toHaveLength(calls);
    time = 3_700_000;
    expect(await opened.session.upload({ envelope: {} })).toEqual({ status: 'account_unavailable' });
    expect(f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network')).toHaveLength(calls);
  });

  it('сдвиг часов назад закрывает действие, а неверная привязка не открывается', async () => {
    const f = fixture(provider);
    let time = 100_000;
    const opened = await openNativeCloudSession({ ...f.options, now: () => time });
    expect(opened.status).toBe('opened');
    time--;
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_unavailable' });
    const wrong = await openNativeCloudSession({ ...f.options, accountKey: 'OTHER_ACCOUNT', now: () => 100_000 });
    expect(wrong.status).not.toBe('opened');
    noSecret(wrong);
  });
});

describe('особые исходы подключения через fake IPC', () => {
  it('Яндекс с истёкшим access требует новый вход и не выполняет refresh', async () => {
    const f = fixture('yandex', { expiresAt: 100_001 });
    expect(await openNativeCloudSession({ ...f.options, now: () => 100_000 })).toEqual({ status: 'login_required' });
    expect(f.invoke.mock.calls.some(([command]) => command === 'cloud_oauth_network')).toBe(false);
  });
  it('Google не повторяет потерянный refresh после нового открытия', async () => {
    const f = fixture('google', { lostRefresh: true });
    expect(await openNativeCloudSession({ ...f.options, now: () => 100_000 })).toEqual({
      status: 'credential_blocked'
    });
    expect(await openNativeCloudSession({ ...f.options, now: () => 100_000 })).toEqual({
      status: 'credential_blocked'
    });
    expect(f.invoke.mock.calls.filter(([command]) => command === 'cloud_oauth_network')).toHaveLength(1);
  });
  it('Яндекс не начинает чтение версий при другом аккаунте', async () => {
    const f = fixture('yandex', { identity: 'OTHER_ACCOUNT' });
    const opened = await openNativeCloudSession({ ...f.options, now: () => 100_000 });
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_mismatch' });
    expect(
      f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network').map(([, args]) => args.args.operation)
    ).toEqual(['identity']);
  });
});

describe('поиск кандидатов Google через сохранённый аккаунт (fake IPC)', () => {
  const folder = id => ({
    id,
    name: 'Твиноферма',
    mimeType: 'application/vnd.google-apps.folder',
    appProperties: { tfFolder: '1' }
  });
  it('читает два полных списка без заранее известного folderId и не предоставляет запись', async () => {
    const f = fixture('google', { folders: [folder('FOLDER_CANDIDATE')] });
    const opened = await openStoredNativeGoogleFolderDiscovery({
      invoke: f.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect(opened.status).toBe('opened');
    expect(Object.keys(opened.session).sort()).toEqual(['discover', 'dispose', 'probeRoot']);
    const result = await opened.session.discover();
    expect(result).toEqual({ status: 'candidate', folders: [{ folderId: 'FOLDER_CANDIDATE', name: 'Твиноферма' }] });
    noSecret(result);
    const operations = f.invoke.mock.calls
      .filter(([cmd]) => cmd === 'cloud_disk_network')
      .map(([, args]) => args.args.operation);
    expect(operations.slice(-3)).toEqual(['identity', 'folder_list', 'folder_list']);
    expect(operations).not.toContain('folder_create');
    expect(operations).not.toContain('create');
    opened.session.dispose();
    expect(await opened.session.discover()).toEqual({ status: 'account_unavailable' });
  });
  it.each([
    [[], 'empty'],
    [[folder('second'), folder('first')], 'ambiguous']
  ])('не выбирает и не создаёт папку при результате %s', async (folders, status) => {
    const f = fixture('google', { folders });
    const opened = await openStoredNativeGoogleFolderDiscovery({
      invoke: f.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    const result = await opened.session.discover();
    expect(result.status).toBe(status);
    expect(result.folders).toHaveLength(folders.length);
    expect(
      f.invoke.mock.calls.some(([cmd, args]) => cmd === 'cloud_disk_network' && args.args.operation === 'folder_create')
    ).toBe(false);
  });
  it('изменённая локальная запись закрывает поиск до сетевого запроса', async () => {
    const f = fixture('google', { folders: [folder('FOLDER_CANDIDATE')] });
    const opened = await openStoredNativeGoogleFolderDiscovery({
      invoke: f.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    const before = f.invoke.mock.calls.filter(([cmd]) => cmd === 'cloud_disk_network').length;
    f.replace(JSON.stringify({ ...JSON.parse(f.record()), revision: revision2 }));
    expect(await opened.session.discover()).toEqual({ status: 'account_unavailable' });
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === 'cloud_disk_network')).toHaveLength(before);
  });
  it.each(['empty', 'blocked', 'pending'])('не обновляет токен, когда pin имеет состояние %s', async state => {
    const f = fixture('google');
    const invoke = vi.fn(async (command, args) =>
      command === 'cloud_credential_binding_read' ? { status: state } : f.invoke(command, args)
    );
    const result = await openStoredNativeGoogleFolderDiscovery({ invoke, now: () => 100_000, cryptoSource: webcrypto });
    expect(result).toEqual({ status: state === 'empty' ? 'credential_missing' : 'credential_blocked' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('отвергает подменённый pin и незавершённый или меняющийся список', async () => {
    const f = fixture('google');
    let pages = 0;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'cloud_disk_network' && args.args.operation === 'folder_list') {
        pages++;
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: pages === 1 ? [folder('first')] : [folder('second')], incompleteSearch: false })
        };
      }
      return f.invoke(command, args);
    });
    const opened = await openStoredNativeGoogleFolderDiscovery({ invoke, now: () => 100_000, cryptoSource: webcrypto });
    expect(await opened.session.discover()).toEqual({ status: 'changed' });
    const g = fixture('google');
    const badPin = vi.fn(async (command, args) =>
      command === 'cloud_credential_binding_read'
        ? { status: 'ready', ...g.binding, accountKey: 'OTHER_ACCOUNT' }
        : g.invoke(command, args)
    );
    expect(
      (await openStoredNativeGoogleFolderDiscovery({ invoke: badPin, now: () => 100_000, cryptoSource: webcrypto }))
        .status
    ).not.toBe('opened');
    expect(g.invoke.mock.calls.some(([cmd]) => cmd === 'cloud_oauth_network' || cmd === 'cloud_disk_network')).toBe(
      false
    );
  });
  it('находит точный корень из независимо полученного кода только в обнаруженной папке', async () => {
    const rootVersion = '41234567-89ab-4cde-8f01-23456789abcd';
    const rootEnvelope = await encryptSnapshot({
      snapshot: { fake: true },
      recoveryKey: `TF1-${'A'.repeat(43)}`,
      datasetId,
      versionId: rootVersion,
      cryptoSource: webcrypto
    });
    const rootPin = await historyEnvelopePin({
      envelope: rootEnvelope,
      expectedDatasetId: datasetId,
      cryptoSource: webcrypto
    });
    const pairingCode = createPairingCode({
      datasetId,
      rootPin,
      keyPin: { bundleId: '51234567-89ab-4cde-8f01-23456789abcd', sha256: 'a'.repeat(64) }
    });
    const f = fixture('google', { folders: [folder('FOLDER_CANDIDATE')], rootEnvelope });
    const opened = await openStoredNativeGoogleFolderDiscovery({
      invoke: f.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    const args = { folderId: 'FOLDER_CANDIDATE', pairingCode, independentPinConfirmed: true };
    expect(await opened.session.probeRoot(args)).toEqual({ status: 'candidate_unavailable' });
    await opened.session.discover();
    await expect(opened.session.probeRoot({ ...args, independentPinConfirmed: false })).rejects.toThrow();
    expect(await opened.session.probeRoot({ ...args, folderId: 'OTHER' })).toEqual({ status: 'candidate_unavailable' });
    expect(await opened.session.probeRoot(args)).toEqual({ status: 'matched_root', folderId: 'FOLDER_CANDIDATE' });
    const changedCode = createPairingCode({
      datasetId,
      rootPin: { ...rootPin, sha256: 'b'.repeat(64) },
      keyPin: { bundleId: '51234567-89ab-4cde-8f01-23456789abcd', sha256: 'a'.repeat(64) }
    });
    expect(await opened.session.probeRoot({ ...args, pairingCode: changedCode })).toEqual({ status: 'root_mismatch' });
    const calls = f.invoke.mock.calls
      .filter(([cmd]) => cmd === 'cloud_disk_network')
      .map(([, value]) => value.args.operation);
    expect(calls.filter(operation => operation === 'download')).toHaveLength(2);
    expect(calls).not.toContain('folder_create');
    expect(calls).not.toContain('create');
    opened.session.dispose();
    expect(await opened.session.probeRoot(args)).toEqual({ status: 'candidate_unavailable' });
  });
  it('связывает поиск, восстановление backup-ключом и read-only сравнение на втором условном ПК', async () => {
    const mainSecret = 'Синтетический пароль для первого условного ПК 123!';
    const keys = await createKeyBundle({
      datasetId,
      primary: { kind: 'password', secret: mainSecret },
      backup: { kind: 'generated' },
      cryptoSource: webcrypto
    });
    const { ui, ...state } = normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'local-id', nick: 'Облачный персонаж' }]
    });
    const cloud = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource: webcrypto }).snapshot);
    const local = structuredClone(cloud);
    local.sections.characters.records[0].fields.nick = 'Другая локальная запись';
    const before = JSON.stringify(local);
    const root = await sealHistoryVersion({
      publicSnapshot: cloud,
      parent: null,
      recoveryKey: keys.dataKey,
      datasetId,
      versionId: '41234567-89ab-4cde-8f01-23456789abcd',
      keyBundle: keys.bundle,
      keyPin: keys.pin,
      cryptoSource: webcrypto
    });
    const pairingCode = createPairingCode({ datasetId, keyPin: keys.pin, rootPin: root.pin });
    const pairing = parsePairingCode(pairingCode);
    const pc2 = fixture('google', { folders: [folder('FOLDER_CANDIDATE')], rootEnvelope: root.envelope });
    const found = await openStoredNativeGoogleFolderDiscovery({
      invoke: pc2.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect((await found.session.discover()).status).toBe('candidate');
    expect(
      await found.session.probeRoot({ folderId: 'FOLDER_CANDIDATE', pairingCode, independentPinConfirmed: true })
    ).toEqual({ status: 'matched_root', folderId: 'FOLDER_CANDIDATE' });
    found.session.dispose();
    const opened = await openStoredNativeCloudSession({
      provider: 'google',
      datasetId: pairing.datasetId,
      folderId: 'FOLDER_CANDIDATE',
      invoke: pc2.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect(opened.status).toBe('opened');
    const discovery = await findPortableKeyVersions({
      session: opened.session,
      datasetId,
      cryptoSource: webcrypto,
      now: () => 200_000
    });
    expect(discovery.status).toBe('listed');
    expect(discovery.candidates[0].pin).toEqual(pairing.keyPin);
    const source = await opened.session.read(root.pin.versionId);
    expect(source.status).toBe('found');
    let localRaw = null;
    const keyStore = {
      read: vi.fn(async () => (localRaw === null ? { status: 'empty' } : { status: 'ready', raw: localRaw })),
      install: vi.fn(async value => {
        if (localRaw !== null) return { status: 'occupied' };
        localRaw = (await createKeyStateRecord(value, webcrypto)).raw;
        return { status: 'installed' };
      })
    };
    const recoverer = createKeyRecoverer({ store: keyStore, cryptoSource: webcrypto });
    const attempt = await recoverer.begin({
      envelope: source.envelope,
      expectedDatasetId: pairing.datasetId,
      expectedPin: pairing.keyPin,
      independentPinConfirmed: true
    });
    expect(await attempt.recover({ role: 'backup', secret: keys.generatedBackupSecret })).toEqual({
      status: 'installed'
    });
    const restored = await parseKeyStateRecord(localRaw, webcrypto);
    expect(restored.state.dataKey).toBe(keys.dataKey);
    opened.session.dispose();
    let datasetRaw = null;
    const invoke2 = vi.fn(async (command, args) => {
      if (command === 'cloud_dataset_binding_read')
        return datasetRaw === null ? { status: 'empty' } : { status: 'ready', record: datasetRaw };
      if (command === 'cloud_dataset_binding_install') {
        if (datasetRaw !== null) return { status: 'occupied' };
        expect(args.confirmed).toBe(true);
        expect(parseDatasetBindingRecord(args.record).binding.keySlotId).toBe(restored.state.slotId);
        datasetRaw = args.record;
        return { status: 'installed' };
      }
      if (command === 'cloud_key_state_read')
        return { status: 'ready', slotId: restored.state.slotId, record: localRaw };
      return pc2.invoke(command, args);
    });
    const pinStore = createNativeDatasetBindingStore({ provider: 'google', invoke: invoke2 });
    expect(
      await pinStore.install(
        {
          provider: 'google',
          accountSlotId: slotId,
          keySlotId: restored.state.slotId,
          datasetId,
          keyPin: pairing.keyPin,
          rootPin: pairing.rootPin,
          folderId: 'FOLDER_CANDIDATE'
        },
        true
      )
    ).toEqual({ status: 'installed' });
    const pinned = await openPinnedNativeCloudSession({
      provider: 'google',
      invoke: invoke2,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect(pinned.status).toBe('opened');
    expect(pinned.rootPin).toEqual(pairing.rootPin);
    noSecret(pinned);
    const review = await prepareCloudReview({
      provider: 'google',
      session: pinned.session,
      datasetId,
      dataKey: restored.state.dataKey,
      rootPin: pairing.rootPin,
      knownPins: [],
      localSnapshot: local,
      localSavedAt: null,
      now: () => 300_000,
      cryptoSource: webcrypto
    });
    expect(review.status).toBe('ready_for_review');
    const compared = review.compare(pairing.rootPin);
    expect(compared.cloudModifiedAt).toBeNull();
    expect(compared.localSavedAt).toBeNull();
    expect(compared.checkedAt).toBe(new Date(300_000).toISOString());
    expect(JSON.stringify(compared.differences)).toContain('Облачный персонаж');
    expect(JSON.stringify(local)).toBe(before);
    expect(keyStore.install).toHaveBeenCalledTimes(1);
    const ops = pc2.invoke.mock.calls
      .filter(([cmd]) => cmd === 'cloud_disk_network')
      .map(([, args]) => args.args.operation);
    expect(ops).not.toContain('folder_create');
    expect(ops).not.toContain('create');
    pinned.session.dispose();
  }, 30_000);
  it('одинаковый корень в нескольких папках остаётся неоднозначным', async () => {
    const rootVersion = '41234567-89ab-4cde-8f01-23456789abcd';
    const rootEnvelope = await encryptSnapshot({
      snapshot: { fake: true },
      recoveryKey: `TF1-${'A'.repeat(43)}`,
      datasetId,
      versionId: rootVersion,
      cryptoSource: webcrypto
    });
    const rootPin = await historyEnvelopePin({
      envelope: rootEnvelope,
      expectedDatasetId: datasetId,
      cryptoSource: webcrypto
    });
    const pairingCode = createPairingCode({
      datasetId,
      rootPin,
      keyPin: { bundleId: '51234567-89ab-4cde-8f01-23456789abcd', sha256: 'a'.repeat(64) }
    });
    const f = fixture('google', {
      folders: [folder('FOLDER_CANDIDATE'), folder('SECOND_FOLDER')],
      rootEnvelope,
      rootFolderIds: ['FOLDER_CANDIDATE', 'SECOND_FOLDER']
    });
    const opened = await openStoredNativeGoogleFolderDiscovery({
      invoke: f.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect((await opened.session.discover()).status).toBe('ambiguous');
    for (const folderId of ['FOLDER_CANDIDATE', 'SECOND_FOLDER'])
      expect(await opened.session.probeRoot({ folderId, pairingCode, independentPinConfirmed: true })).toEqual({
        status: 'matched_root',
        folderId
      });
  });
  it('смена записи во время чтения корня не возвращает совпадение', async () => {
    const rootVersion = '41234567-89ab-4cde-8f01-23456789abcd';
    const rootEnvelope = await encryptSnapshot({
      snapshot: { fake: true },
      recoveryKey: `TF1-${'A'.repeat(43)}`,
      datasetId,
      versionId: rootVersion,
      cryptoSource: webcrypto
    });
    const rootPin = await historyEnvelopePin({
      envelope: rootEnvelope,
      expectedDatasetId: datasetId,
      cryptoSource: webcrypto
    });
    const pairingCode = createPairingCode({
      datasetId,
      rootPin,
      keyPin: { bundleId: '51234567-89ab-4cde-8f01-23456789abcd', sha256: 'a'.repeat(64) }
    });
    const f = fixture('google', { folders: [folder('FOLDER_CANDIDATE')], rootEnvelope });
    const invoke = vi.fn(async (command, args) => {
      const response = await f.invoke(command, args);
      if (command === 'cloud_disk_network' && args.args.operation === 'download')
        f.replace(JSON.stringify({ ...JSON.parse(f.record()), revision: revision2 }));
      return response;
    });
    const opened = await openStoredNativeGoogleFolderDiscovery({ invoke, now: () => 100_000, cryptoSource: webcrypto });
    await opened.session.discover();
    expect(
      await opened.session.probeRoot({ folderId: 'FOLDER_CANDIDATE', pairingCode, independentPinConfirmed: true })
    ).toEqual({ status: 'account_unavailable' });
  });
  it('несовпадение аккаунта или неполный список не превращается в успешный поиск', async () => {
    const f = fixture('google', { folders: [folder('FOLDER_CANDIDATE')] });
    let failIdentity = false;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'cloud_disk_network' && args.args.operation === 'identity' && failIdentity)
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { permissionId: 'OTHER_ACCOUNT' } })
        };
      return f.invoke(command, args);
    });
    const opened = await openStoredNativeGoogleFolderDiscovery({ invoke, now: () => 100_000, cryptoSource: webcrypto });
    failIdentity = true;
    expect(await opened.session.discover()).toEqual({ status: 'account_mismatch' });
    expect(
      f.invoke.mock.calls.some(([cmd, args]) => cmd === 'cloud_disk_network' && args.args.operation === 'folder_list')
    ).toBe(false);
    const g = fixture('google');
    const incomplete = vi.fn(async (command, args) =>
      command === 'cloud_disk_network' && args.args.operation === 'folder_list'
        ? { status: 200, contentType: 'application/json', body: JSON.stringify({ files: [], incompleteSearch: true }) }
        : g.invoke(command, args)
    );
    const second = await openStoredNativeGoogleFolderDiscovery({
      invoke: incomplete,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect(await second.session.discover()).toEqual({ status: 'unavailable' });
  });
  it('не принимает datasetId/folderId и сетевые операции извне', async () => {
    const f = fixture('google');
    await expect(
      openStoredNativeGoogleFolderDiscovery({ invoke: f.invoke, folderId: 'fake-folder' })
    ).rejects.toThrow();
    await expect(openStoredNativeGoogleFolderDiscovery({ invoke: f.invoke, datasetId })).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe('standalone Google folder capability (not legacy discovery)', () => {
  const folder = id => ({
    id,
    name: 'Твиноферма',
    mimeType: 'application/vnd.google-apps.folder',
    appProperties: { tfFolder: '1' }
  });
  it('allocates a durable folder ID and creates it without any root/pairing/data binding', async () => {
    const folders = [];
    const f = fixture('google', { folders });
    const writes = [];
    const invoke = vi.fn(async (command, args) => {
      if (command === 'cloud_disk_network' && args.args.operation === 'generate_id')
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ ids: ['standalone-folder'] }) };
      if (command === 'cloud_disk_network' && args.args.operation === 'folder_create') {
        writes.push(args.args.fileId);
        folders.push(folder(args.args.fileId));
        return { status: 201, contentType: 'application/json', body: JSON.stringify(folder(args.args.fileId)) };
      }
      return f.invoke(command, args);
    });
    const opened = await openStoredStandaloneGoogleFolder({ invoke, now: () => 100_000, cryptoSource: webcrypto });
    expect(opened.status).toBe('opened');
    expect((await opened.session.discover()).status).toBe('empty');
    expect(await opened.session.generateFileId()).toEqual({ status: 'generated', fileId: 'standalone-folder' });
    expect(await opened.session.createOnce({ fileId: 'standalone-folder' })).toEqual({ status: 'accepted' });
    expect((await opened.session.discover()).folders).toEqual([{ folderId: 'standalone-folder', name: 'Твиноферма' }]);
    expect(writes).toEqual(['standalone-folder']);
    expect((await opened.session.createOnce({ fileId: 'another-id' })).status).toBe('blocked_in_session');
    opened.session.dispose();
    expect(await opened.session.generateFileId()).toEqual({ status: 'account_unavailable' });
    noSecret(opened);
    expect(invoke.mock.calls.some(([command]) => /dataset|outbox|key_state/.test(command))).toBe(false);
  });
  it('leaves the original folder discovery capability strictly read-only', async () => {
    const f = fixture('google');
    const opened = await openStoredNativeGoogleFolderDiscovery({
      invoke: f.invoke,
      now: () => 100_000,
      cryptoSource: webcrypto
    });
    expect(opened.session.generateFileId).toBeUndefined();
    expect(opened.session.createOnce).toBeUndefined();
    opened.session.dispose();
  });
});
