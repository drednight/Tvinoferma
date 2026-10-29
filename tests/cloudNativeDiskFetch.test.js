import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import {
  decryptSnapshot,
  encryptSnapshot,
  generateRecoveryKey,
  generateSyncId
} from '../js/modules/cloudSync/envelope.js';
import { createDurableCloudOutbox } from '../js/modules/cloudSync/durableOutbox.js';
import { prepareCloudReview } from '../js/modules/cloudSync/cloudReview.js';
import { createKeyProvisioner } from '../js/modules/cloudSync/keyProvisioning.js';
import { createKeyRecoverer } from '../js/modules/cloudSync/keyRecovery.js';
import { findPortableKeyVersions } from '../js/modules/cloudSync/portableKeyDiscovery.js';
import { createPairingCode, parsePairingCode } from '../js/modules/cloudSync/pairingCode.js';
import { createNativeKeyStateStore } from '../js/modules/cloudSync/providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from '../js/modules/cloudSync/providers/nativeOutboxStore.js';
import { openNativeCloudSession } from '../js/modules/cloudSync/providers/nativeCloudSession.js';
import { prepareGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { prepareYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';
import { normalizeState } from '../js/core/state.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';
import { versionFileName } from '../js/modules/cloudSync/providers/common.js';
import { googleCreateRequest, googleListRequest } from '../js/modules/cloudSync/providers/googleDrive.js';
import { createCloudUploadTransport } from '../js/modules/cloudSync/providers/uploadTransport.js';
import { createAuthenticatedCloudSession } from '../js/modules/cloudSync/providers/authenticatedSession.js';
import { createNativeDiskFetch } from '../js/modules/cloudSync/providers/nativeDiskFetch.js';
import { yandexUploadContentRequest } from '../js/modules/cloudSync/providers/yandexDisk.js';

const datasetId = '01234567-89ab-4cde-8f01-23456789abcd';
const versionId = '11234567-89ab-4cde-8f01-23456789abcd';
const folderId = 'fake-folder';
const fileId = 'fake-file';
const accessToken = 'PRIVATE_FAKE_TOKEN';
const accountKey = 'PRIVATE_FAKE_ACCOUNT';
const clientIds = { google: 'fake-client.apps.googleusercontent.com', yandex: '0123456789abcdef' };
const modified = '2026-10-29T12:00:00Z';
let recoveryKey, sealed;

function reply(data, status = 200, contentType = 'application/json') {
  return { status, body: typeof data === 'string' ? data : JSON.stringify(data), contentType };
}
function empty(status) {
  return { status, body: '', contentType: null };
}
function fakeNative(provider) {
  const files = new Map();
  const calls = [];
  let account = accountKey;
  const invoke = vi.fn(async (command, wrapper) => {
    if (command !== 'cloud_disk_network') throw new Error('FAKE_SECRET_ERROR');
    const args = wrapper.args;
    calls.push(args);
    if (args.provider !== provider) throw new Error('wrong fake provider');
    if (args.operation === 'identity')
      return reply(
        provider === 'google' ? { user: { permissionId: account } } : { client_id: clientIds.yandex, psuid: account }
      );
    if (provider === 'google') {
      if (args.operation === 'generate_id') return reply({ ids: [fileId], kind: 'drive#generatedIds', space: 'drive' });
      if (args.operation === 'create') {
        if (files.has(args.fileId)) return empty(409);
        const metadata = {
          id: args.fileId,
          name: versionFileName(args.datasetId, args.versionId),
          mimeType: 'application/octet-stream',
          appProperties: { tfFormat: '1', tfDataset: args.datasetId, tfVersion: args.versionId },
          modifiedTime: modified
        };
        files.set(args.fileId, { metadata, body: args.body });
        return reply({ id: args.fileId, name: metadata.name, appProperties: metadata.appProperties });
      }
      if (args.operation === 'list') {
        const found = [...files.values()]
          .filter(item => !args.versionId || item.metadata.appProperties.tfVersion === args.versionId)
          .map(item => item.metadata);
        return reply({ files: found, incompleteSearch: false });
      }
      if (args.operation === 'download')
        return files.has(args.fileId)
          ? reply(files.get(args.fileId).body, 200, 'application/octet-stream')
          : empty(404);
    } else {
      const path = `app:/${versionFileName(args.datasetId || datasetId, args.versionId || versionId)}`;
      if (args.operation === 'upload_link') {
        if (files.has(path)) return empty(409);
        return reply({
          href: `https://uploader1.dst.yandex.net/upload-target/fake?path=${encodeURIComponent(path)}`,
          method: 'PUT',
          templated: false
        });
      }
      if (args.operation === 'upload_content') {
        expect(args.accessToken).toBeUndefined();
        const target = new URL(args.link).searchParams.get('path');
        if (files.has(target)) return empty(409);
        files.set(target, { body: args.body });
        return empty(201);
      }
      if (args.operation === 'download_link') {
        if (!files.has(path)) return empty(404);
        return reply({
          href: `https://downloader.dst.yandex.ru/disk/fake?path=${encodeURIComponent(path)}`,
          method: 'GET',
          templated: false
        });
      }
      if (args.operation === 'download_content') {
        const target = new URL(args.link).searchParams.get('path');
        return files.has(target) ? reply(files.get(target).body, 200, 'application/octet-stream') : empty(404);
      }
      if (args.operation === 'list') {
        const items = [...files.keys()]
          .map(name => ({ name: name.slice('app:/'.length), type: 'file', modified }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return reply({
          type: 'dir',
          _embedded: { offset: args.offset, limit: args.limit, total: items.length, items }
        });
      }
    }
    throw new Error('unexpected fake operation');
  });
  return {
    files,
    calls,
    invoke,
    setAccount(value) {
      account = value;
    }
  };
}
function fetchInit(method, headers, body) {
  return {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: new AbortController().signal
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  recoveryKey = generateRecoveryKey(webcrypto);
  sealed = await encryptSnapshot({
    snapshot: { name: 'ЧАСТНОЕ ИМЯ', password: 'ЧАСТНЫЙ ПАРОЛЬ' },
    recoveryKey,
    datasetId,
    versionId,
    cryptoSource: webcrypto
  });
});

describe.each(['google', 'yandex'])('%s: изолированная последовательность через fake IPC', provider => {
  it('проверяет аккаунт, шифрует, записывает, перечитывает и показывает дату без применения', async () => {
    const native = fakeNative(provider);
    const fetchImpl = createNativeDiskFetch({ provider, invoke: native.invoke });
    const client = createAuthenticatedCloudSession({
      provider,
      clientId: clientIds[provider],
      accountKey,
      datasetId,
      accessToken,
      fetchImpl,
      cryptoSource: webcrypto,
      ...(provider === 'google' ? { folderId } : {})
    });
    const allocated = provider === 'google' ? await client.generateFileId() : null;
    if (allocated) expect(allocated).toEqual({ status: 'generated', fileId });
    const args = { envelope: sealed, ...(allocated ? { fileId } : {}) };
    expect(await client.upload(args)).toEqual({ status: 'accepted' });
    expect(await client.verify(args)).toEqual({ status: 'verified' });
    expect(await client.listWithDates()).toEqual({
      status: 'listed',
      versions: [{ versionId, modifiedAt: '2026-10-29T12:00:00.000Z' }]
    });
    const received = await client.read(versionId);
    expect(received).toEqual({ status: 'found', envelope: sealed });
    expect(
      await decryptSnapshot({
        envelope: received.envelope,
        recoveryKey,
        expectedDatasetId: datasetId,
        cryptoSource: webcrypto
      })
    ).toEqual({ name: 'ЧАСТНОЕ ИМЯ', password: 'ЧАСТНЫЙ ПАРОЛЬ' });
    for (const file of native.files.values()) {
      for (const secret of ['ЧАСТНОЕ ИМЯ', 'ЧАСТНЫЙ ПАРОЛЬ', recoveryKey, accessToken])
        expect(file.body).not.toContain(secret);
    }
    const identityCalls = native.calls.filter(call => call.operation === 'identity');
    expect(identityCalls).toHaveLength(provider === 'google' ? 5 : 4);
    for (const call of native.calls.filter(call => call.operation !== 'upload_content'))
      expect(call.accessToken).toBe(accessToken);
    native.setAccount('OTHER_ACCOUNT');
    const before = native.calls.length;
    expect(await client.upload(args)).toEqual({ status: 'account_mismatch' });
    expect(native.calls.slice(before).map(call => call.operation)).toEqual(['identity']);
  });
});

describe('экспериментальный native bridge — ограничения до IPC', () => {
  it('не передаёт произвольные адреса, заголовки, методы и параметры', async () => {
    const invoke = vi.fn();
    const fetch = createNativeDiskFetch({ provider: 'google', invoke });
    const list = googleListRequest({ folderId, datasetId });
    const good = fetchInit('GET', { Authorization: `Bearer ${accessToken}` });
    const attempts = [
      ['http://www.googleapis.com/drive/v3/files', good],
      ['https://www.googleapis.com.evil.test/drive/v3/files', good],
      [list.url + '&extra=1', good],
      [list.url, { ...good, method: 'DELETE' }],
      [list.url, { ...good, headers: { ...good.headers, Cookie: 'PRIVATE' } }],
      [list.url, { ...good, redirect: 'follow' }],
      [list.url, { ...good, credentials: 'include' }],
      [list.url, { ...good, body: '' }],
      [list.url, { ...good, headers: { Authorization: 'Bearer abc\r\ninjected' } }]
    ];
    for (const [url, init] of attempts) await expect(fetch(url, init)).rejects.toThrow('Не удалось безопасно');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Google multipart: отклоняет открытый текст, повтор полей и несовпадение метаданных', async () => {
    const invoke = vi.fn();
    const fetch = createNativeDiskFetch({ provider: 'google', invoke });
    const request = googleCreateRequest({ folderId, datasetId, envelope: sealed, fileId, cryptoSource: webcrypto });
    const init = fetchInit(
      request.method,
      { ...request.headers, Authorization: `Bearer ${accessToken}` },
      request.body
    );
    for (const body of [
      request.body.replace('"algorithm":"AES-256-GCM"', '"algorithm":"plaintext"'),
      request.body.replace('"format":', '"secret":"ЧАСТНОЕ ИМЯ","format":'),
      request.body.replace('"format":', '"format":"other","format":'),
      request.body.replace('"tfVersion":"', '"tfVersion":"wrong-'),
      request.body.replace('"id":"fake-file"', '"id":"other","id":"fake-file"'),
      request.body + '\r\n'
    ])
      await expect(fetch(request.url, { ...init, body })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Яндекс PUT не принимает токен, чужой хост или неконечный/открытый конверт', async () => {
    const invoke = vi.fn();
    const fetch = createNativeDiskFetch({ provider: 'yandex', invoke });
    const link = {
      href: 'https://uploader1.dst.yandex.net/upload-target/test?s=PRIVATE',
      method: 'PUT',
      templated: false
    };
    const request = yandexUploadContentRequest({ link, datasetId, versionId, envelope: sealed });
    const good = fetchInit('PUT', request.headers, request.body);
    for (const [url, init] of [
      ['https://uploader1.dst.yandex.net.evil.test/upload-target/test', good],
      [request.url, { ...good, headers: { ...good.headers, Authorization: `OAuth ${accessToken}` } }],
      [request.url, { ...good, body: '{"name":"ЧАСТНОЕ ИМЯ"}' }],
      [request.url, { ...good, body: request.body.replace('"ciphertext":', '"plaintext":"secret","ciphertext":') }],
      ['https://uploader1.dst.yandex.net/upload-target/%2fsecret', good]
    ])
      await expect(fetch(url, init)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('скрывает исходную ошибку и отклоняет недопустимый ответ IPC', async () => {
    const list = googleListRequest({ folderId, datasetId });
    const init = fetchInit('GET', { Authorization: `Bearer ${accessToken}` });
    for (const answer of [
      { status: 302, body: '', contentType: null },
      { status: 401, body: `private ${accessToken}`, contentType: null },
      { status: 200, body: '{}', contentType: 'application/json\r\nprivate' },
      { status: 200, body: '{}', contentType: null, extra: 'private' },
      { status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1), contentType: null }
    ]) {
      const fetch = createNativeDiskFetch({ provider: 'google', invoke: async () => answer });
      await expect(fetch(list.url, init)).rejects.toThrow('Не удалось безопасно');
    }
    const fetch = createNativeDiskFetch({
      provider: 'google',
      invoke: async () => {
        throw new Error(`PRIVATE ${accessToken}`);
      }
    });
    await expect(fetch(list.url, init)).rejects.not.toThrow(accessToken);
  });

  it('таймаут не освобождает запрос записи до фактического завершения IPC', async () => {
    const gate = deferred();
    const invoke = vi.fn(() => gate.promise);
    const fetchImpl = createNativeDiskFetch({ provider: 'google', invoke });
    const upload = createCloudUploadTransport({
      provider: 'google',
      datasetId,
      folderId,
      accessToken,
      fetchImpl,
      cryptoSource: webcrypto,
      timeoutMs: 100
    });
    expect(await upload.upload({ envelope: sealed, fileId })).toEqual({ status: 'unknown' });
    expect(upload.isBusy()).toBe(true);
    await expect(upload.upload({ envelope: sealed, fileId })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
    gate.resolve(
      reply({
        id: fileId,
        name: versionFileName(datasetId, versionId),
        appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: versionId }
      })
    );
    await vi.waitFor(() => expect(upload.isBusy()).toBe(false));
    expect(invoke).toHaveBeenCalledOnce();
  });
});
// Сеть, journal IPC и OS vault здесь подменены in-memory. Это проверяет
// последовательность компонентов, но не реальную устойчивость Windows/Tauri.
function fakeNativeWithJournal(provider, loseUploadReply = false) {
  const disk = fakeNative(provider);
  let journal = { status: 'empty' };
  let lost = false;
  const invoke = vi.fn(async (command, wrapper) => {
    if (command === 'cloud_disk_network') {
      const result = await disk.invoke(command, wrapper);
      if (
        loseUploadReply &&
        !lost &&
        (wrapper.args.operation === 'create' || wrapper.args.operation === 'upload_content')
      ) {
        lost = true;
        throw new Error('PRIVATE: fake ответ потерян после записи');
      }
      return result;
    }
    if (wrapper.provider !== provider) throw new Error('wrong fake provider');
    if (command === 'cloud_outbox_read') return structuredClone(journal);
    if (command === 'cloud_outbox_install' || command === 'cloud_outbox_compare_exchange') {
      const next = wrapper.args;
      if (command === 'cloud_outbox_install' && journal.status !== 'empty') return { status: 'occupied' };
      if (command === 'cloud_outbox_compare_exchange') {
        if (journal.status !== 'ready') return { status: 'blocked' };
        if (next.expectedRevisionId !== journal.revisionId || next.expectedSha256 !== journal.sha256)
          return { status: 'mismatch' };
      }
      const { slotId, datasetId, deviceId, revisionId, record } = next;
      journal = {
        status: 'ready',
        slotId,
        datasetId,
        deviceId,
        revisionId,
        record,
        sha256: createHash('sha256').update(record).digest('hex')
      };
      return { status: command === 'cloud_outbox_install' ? 'installed' : 'swapped' };
    }
    throw new Error('unexpected fake IPC');
  });
  return { disk, invoke, journal: () => journal };
}

describe.each(['google', 'yandex'])('%s: журнал + авторизованный диск через fake IPC', provider => {
  it('после потерянного ответа перечитывает точную версию и не отправляет её повторно', async () => {
    const fake = fakeNativeWithJournal(provider, true);
    const fetchImpl = createNativeDiskFetch({ provider, invoke: fake.invoke });
    const session = createAuthenticatedCloudSession({
      provider,
      clientId: clientIds[provider],
      accountKey,
      datasetId,
      accessToken,
      fetchImpl,
      cryptoSource: webcrypto,
      ...(provider === 'google' ? { folderId } : {})
    });
    const deviceId = generateSyncId(webcrypto);
    const slotId = generateSyncId(webcrypto);
    const versionId = generateSyncId(webcrypto);
    const { ui, ...snapshot } = normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'hero', nick: 'СЕКРЕТНЫЙ ПЕРСОНАЖ' }]
    });
    const publicSnapshot = buildPublicSnapshot(planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot);
    const version = await sealHistoryVersion({
      publicSnapshot,
      parent: null,
      recoveryKey,
      datasetId,
      versionId,
      cryptoSource: webcrypto
    });
    const open = () =>
      createDurableCloudOutbox({
        provider,
        clientId: clientIds[provider],
        accountKey,
        datasetId,
        deviceId,
        slotId,
        dataKey: recoveryKey,
        store: createNativeOutboxStore({ provider, invoke: fake.invoke }),
        session,
        cryptoSource: webcrypto,
        ...(provider === 'google' ? { folderId } : {})
      });
    const first = open();
    expect(await first.initialize(true)).toEqual({ status: 'initialized' });
    expect(await first.enqueue(version.envelope)).toEqual({ status: 'queued' });
    expect(await first.sendNext()).toEqual({ status: 'needs_verification' });
    expect(fake.disk.files.size).toBe(1);
    expect(fake.journal().record).not.toContain('СЕКРЕТНЫЙ ПЕРСОНАЖ');
    expect(fake.journal().record).not.toContain(recoveryKey);
    const resumed = open();
    expect(await resumed.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await resumed.verifyNext()).toEqual({ status: 'confirmed' });
    expect(await resumed.sendNext()).toEqual({ status: 'idle' });
    const writes = fake.disk.calls.filter(
      call => call.operation === (provider === 'google' ? 'create' : 'upload_content')
    );
    expect(writes).toHaveLength(1);
    for (const file of fake.disk.files.values()) {
      expect(file.body).not.toContain('СЕКРЕТНЫЙ ПЕРСОНАЖ');
      expect(file.body).not.toContain(recoveryKey);
      expect(file.body).not.toContain(accessToken);
    }
  });
});

function fakeCredentialsAndJournal(provider) {
  const backend = fakeNativeWithJournal(provider, true);
  const credentialSlot = generateSyncId(webcrypto);
  const binding = { slotId: credentialSlot, clientId: clientIds[provider], accountKey };
  let record =
    provider === 'google'
      ? prepareGoogleCredentialRecord({
          ...binding,
          revision: generateSyncId(webcrypto),
          refreshToken: 'FAKE_REFRESH_TOKEN',
          refreshExpiresAt: null
        })
      : prepareYandexCredentialRecord({
          ...binding,
          revision: generateSyncId(webcrypto),
          accessToken,
          expiresAt: 4_000_000
        });
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_credential_read') return { status: 'ready', slotId: credentialSlot, record };
    if (command === 'cloud_credential_compare_exchange') {
      if (record !== args.expected) return { status: 'mismatch' };
      record = args.next;
      return { status: 'swapped' };
    }
    if (command === 'cloud_oauth_network' && args.operation === 'refresh') {
      expect(JSON.parse(record)).toMatchObject({ phase: 'pending', refreshToken: null });
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: OAUTH_PROVIDERS.google.scope
        })
      };
    }
    return backend.invoke(command, args);
  });
  return { backend, binding, invoke };
}

describe.each(['google', 'yandex'])('%s: сквозная отправка с сохранённым доступом и fake IPC', provider => {
  it('после потерянного ответа восстанавливает очередь и сверяет файл без второго POST', async () => {
    const fake = fakeCredentialsAndJournal(provider);
    const openSession = () =>
      openNativeCloudSession({
        provider,
        ...fake.binding,
        datasetId,
        invoke: fake.invoke,
        now: () => 100_000,
        cryptoSource: webcrypto,
        ...(provider === 'google' ? { folderId } : {})
      });
    const deviceId = generateSyncId(webcrypto);
    const slotId = generateSyncId(webcrypto);
    const versionId = generateSyncId(webcrypto);
    const { ui, ...state } = normalizeState({ schemaVersion: 10, characters: [{ id: 'hero', nick: 'ЛИЧНЫЙ ГЕРОЙ' }] });
    const snapshot = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource: webcrypto }).snapshot);
    const version = await sealHistoryVersion({
      publicSnapshot: snapshot,
      parent: null,
      recoveryKey,
      datasetId,
      versionId,
      cryptoSource: webcrypto
    });
    const openQueue = session =>
      createDurableCloudOutbox({
        provider,
        clientId: fake.binding.clientId,
        accountKey,
        datasetId,
        deviceId,
        slotId,
        dataKey: recoveryKey,
        store: createNativeOutboxStore({ provider, invoke: fake.invoke }),
        session,
        cryptoSource: webcrypto,
        ...(provider === 'google' ? { folderId } : {})
      });
    const first = await openSession();
    expect(first.status).toBe('opened');
    const queue = openQueue(first.session);
    expect(await queue.initialize(true)).toEqual({ status: 'initialized' });
    expect(await queue.enqueue(version.envelope)).toEqual({ status: 'queued' });
    expect(await queue.sendNext()).toEqual({ status: 'needs_verification' });
    first.session.dispose();
    const second = await openSession();
    expect(second.status).toBe('opened');
    const resumed = openQueue(second.session);
    expect(await resumed.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await resumed.verifyNext()).toEqual({ status: 'confirmed' });
    expect(await resumed.sendNext()).toEqual({ status: 'idle' });
    expect(
      fake.backend.disk.calls.filter(call => call.operation === (provider === 'google' ? 'create' : 'upload_content'))
    ).toHaveLength(1);
    expect(fake.backend.journal().record).not.toContain('ЛИЧНЫЙ ГЕРОЙ');
    for (const file of fake.backend.disk.files.values()) {
      expect(file.body).not.toContain('ЛИЧНЫЙ ГЕРОЙ');
      expect(file.body).not.toContain(recoveryKey);
      expect(file.body).not.toContain(accessToken);
    }
    second.session.dispose();
  });
});

describe.each(['google', 'yandex'])('%s: ключ → очередь → восстановление (fake IPC)', provider => {
  it('создаёт ключ после проверки backup, шифрует версию и не повторяет потерянную отправку', async () => {
    const fake = fakeCredentialsAndJournal(provider);
    let localKey = null;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'cloud_key_state_read') return localKey ? { status: 'ready', ...localKey } : { status: 'empty' };
      if (command === 'cloud_key_state_install') {
        if (localKey) return { status: 'occupied' };
        localKey = { slotId: args.slotId, record: args.record };
        return { status: 'installed' };
      }
      return fake.invoke(command, args);
    });
    const local = createNativeKeyStateStore({ invoke, cryptoSource: webcrypto });
    const provisioner = createKeyProvisioner({ store: local, cryptoSource: webcrypto });
    const attempt = await provisioner.begin({
      primary: { kind: 'password', secret: 'Синтетический основной пароль 123456!' },
      backup: { kind: 'generated' },
      newDatasetConfirmed: true
    });
    expect(attempt.status).toBe('prepared');
    expect(await attempt.confirmBackup({ secret: attempt.generatedBackupSecret, savedSeparately: true })).toEqual({
      status: 'installed'
    });
    const state = (await createNativeKeyStateStore({ invoke, cryptoSource: webcrypto }).read()).state;
    const newDataset = state.datasetId;
    const dataKey = state.dataKey;
    const { ui, ...original } = normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'hero', nick: 'СИНТЕТИЧЕСКИЙ ГЕРОЙ' }]
    });
    const snapshot = buildPublicSnapshot(planSyncIdentities({ snapshot: original, cryptoSource: webcrypto }).snapshot);
    const version = await sealHistoryVersion({
      publicSnapshot: snapshot,
      parent: null,
      recoveryKey: dataKey,
      datasetId: newDataset,
      versionId: generateSyncId(webcrypto),
      keyBundle: state.bundle,
      keyPin: state.pin,
      cryptoSource: webcrypto
    });
    const openSession = () =>
      openNativeCloudSession({
        provider,
        ...fake.binding,
        datasetId: newDataset,
        invoke,
        now: () => 100_000,
        cryptoSource: webcrypto,
        ...(provider === 'google' ? { folderId } : {})
      });
    const deviceId = generateSyncId(webcrypto);
    const slotId = generateSyncId(webcrypto);
    const openQueue = session =>
      createDurableCloudOutbox({
        provider,
        clientId: fake.binding.clientId,
        accountKey,
        datasetId: newDataset,
        deviceId,
        slotId,
        dataKey,
        store: createNativeOutboxStore({ provider, invoke }),
        session,
        cryptoSource: webcrypto,
        ...(provider === 'google' ? { folderId } : {})
      });
    const first = await openSession();
    expect(first.status).toBe('opened');
    const queue = openQueue(first.session);
    expect(await queue.initialize(true)).toEqual({ status: 'initialized' });
    expect(await queue.enqueue(version.envelope)).toEqual({ status: 'queued' });
    expect(await queue.sendNext()).toEqual({ status: 'needs_verification' });
    first.session.dispose();
    const second = await openSession();
    expect(second.status).toBe('opened');
    const resumed = openQueue(second.session);
    expect(await resumed.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await resumed.verifyNext()).toEqual({ status: 'confirmed' });
    expect(await resumed.sendNext()).toEqual({ status: 'idle' });
    expect(
      fake.backend.disk.calls.filter(call => call.operation === (provider === 'google' ? 'create' : 'upload_content'))
    ).toHaveLength(1);
    const file = [...fake.backend.disk.files.values()][0].body;
    expect(file).not.toContain('СИНТЕТИЧЕСКИЙ ГЕРОЙ');
    expect(file).not.toContain(dataKey);
    expect(fake.backend.journal().record).not.toContain(dataKey);
    expect(file).not.toContain(attempt.generatedBackupSecret);
    expect(file).not.toContain('Синтетический основной пароль');
    expect(JSON.parse(file).version).toBe(2);
    // Второй ПК получает файл с диска, код по отдельному доверенному каналу и backup.
    const code = createPairingCode({ datasetId: attempt.datasetId, keyPin: attempt.pin, rootPin: version.pin });
    expect(code).not.toContain(dataKey);
    expect(code).not.toContain(attempt.generatedBackupSecret);
    const pairing = parsePairingCode(code);
    const listing = await findPortableKeyVersions({
      session: second.session,
      datasetId: pairing.datasetId,
      cryptoSource: webcrypto,
      now: () => Date.parse('2026-10-30T10:30:00.000Z')
    });
    expect(listing).toEqual({
      status: 'listed',
      checkedAt: '2026-10-30T10:30:00.000Z',
      candidates: [{ versionId: version.envelope.versionId, modifiedAt: '2026-10-29T12:00:00.000Z', pin: attempt.pin }],
      legacy: []
    });
    const received = await second.session.read(listing.candidates[0].versionId);
    expect(received.status).toBe('found');
    expect(received.envelope).toEqual(JSON.parse(file));
    let secondKey = null;
    const secondInvoke = vi.fn(async (command, args) => {
      if (command === 'cloud_key_state_read')
        return secondKey ? { status: 'ready', ...secondKey } : { status: 'empty' };
      if (command === 'cloud_key_state_install') {
        if (secondKey) return { status: 'occupied' };
        secondKey = { slotId: args.slotId, record: args.record };
        return { status: 'installed' };
      }
      throw new Error('unexpected second-PC fake IPC');
    });
    const secondStore = createNativeKeyStateStore({ invoke: secondInvoke, cryptoSource: webcrypto });
    const recoverer = createKeyRecoverer({ store: secondStore, cryptoSource: webcrypto });
    const recovery = await recoverer.begin({
      envelope: received.envelope,
      expectedDatasetId: pairing.datasetId,
      expectedPin: pairing.keyPin,
      independentPinConfirmed: true
    });
    expect(recovery.status).toBe('prepared');
    expect(await recovery.recover({ role: 'backup', secret: attempt.generatedBackupSecret })).toEqual({
      status: 'installed'
    });
    const recoveredState = (await secondStore.read()).state;
    expect(recoveredState.dataKey).toBe(dataKey);
    const history = await verifyHistory({
      envelopes: [received.envelope],
      expectedDatasetId: newDataset,
      recoveryKey: recoveredState.dataKey,
      root: pairing.rootPin,
      knownPins: [],
      cryptoSource: webcrypto
    });
    expect(history.publicSnapshot(pairing.rootPin)).toEqual(snapshot);
    // Локальная правка не применяется и не переименовывается в удаление/«самую новую».
    const localSnapshot = structuredClone(snapshot);
    localSnapshot.sections.characters.records[0].fields.nick = 'ДРУГАЯ ЛОКАЛЬНАЯ ВЕРСИЯ';
    const comparison = await prepareCloudReview({
      provider,
      session: second.session,
      datasetId: pairing.datasetId,
      dataKey: recoveredState.dataKey,
      rootPin: pairing.rootPin,
      knownPins: [],
      localSnapshot,
      localSavedAt: null,
      now: () => Date.parse('2026-10-30T10:30:00.000Z'),
      cryptoSource: webcrypto
    });
    expect(comparison.status).toBe('ready_for_review');
    expect(comparison.versions).toHaveLength(1);
    const changes = comparison.compare(comparison.versions[0].pin);
    expect(changes.cloudModifiedAt).toBe('2026-10-29T12:00:00.000Z');
    expect(changes.checkedAt).toBe('2026-10-30T10:30:00.000Z');
    expect(changes.localSavedAt).toBeNull();
    expect(changes.differences.entries.map(item => item.kind)).toEqual(['changed']);
    second.session.dispose();
  }, 30_000);
});
