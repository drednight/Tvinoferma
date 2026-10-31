import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { comparePublicSnapshots } from '../js/modules/cloudSync/compareSnapshots.js';
import { createSelectiveRecordReview } from '../js/modules/cloudSync/selectiveRecordReview.js';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';
import { createCloudUploadTransport } from '../js/modules/cloudSync/providers/uploadTransport.js';
import { createReadOnlyCloudTransport } from '../js/modules/cloudSync/providers/readOnlyTransport.js';
import { createCloudVersionVerifier } from '../js/modules/cloudSync/providers/versionVerifier.js';
import { createAuthenticatedCloudSession } from '../js/modules/cloudSync/providers/authenticatedSession.js';
import {
  createGoogleVersionReader,
  createYandexVersionReader
} from '../js/modules/cloudSync/providers/versionReaders.js';

const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
const folderId = 'folder_test';
const accessToken = 'private-token';
const accountKey = 'PRIVATE_ACCOUNT_KEY';
const clientIds = {
  google: '123456789-test_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
let datasetId, recoveryKey, publicRoot;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function content(value, status = 200) {
  return new Response(value, { status, headers: { 'Content-Type': 'application/octet-stream' } });
}

// Доверенная учебная модель API в памяти теста: не реальный сервис и не гарантия
// совместимости, атомарности, задержек списка, сохранности или безопасности.
function fakeCloud(provider) {
  const files = new Map();
  const pending = new Map();
  const calls = [];
  let nextId = 0;
  let nextResult = 'ok';
  let deferYandex = false;
  let currentAccount = accountKey;
  let currentClient = clientIds[provider];
  let identityFailure = false;
  function setNextResult(result) {
    nextResult = result;
  }
  function finishPending() {
    for (const [key, value] of pending) files.set(key, value);
    pending.clear();
  }
  async function fetchImpl(raw, init) {
    const url = new URL(raw);
    calls.push({ url: raw, method: init.method, headers: init.headers });
    const identityRequest =
      (provider === 'google' && url.pathname === '/drive/v3/about') ||
      (provider === 'yandex' && url.hostname === 'login.yandex.ru' && url.pathname === '/info');
    if (identityRequest) {
      if (identityFailure) throw new Error(`private ${accessToken} ${accountKey}`);
      const response = json(
        provider === 'google'
          ? { user: { permissionId: currentAccount } }
          : { client_id: currentClient, psuid: currentAccount }
      );
      Object.defineProperty(response, 'url', { value: raw });
      return response;
    }
    if (provider === 'google') {
      if (url.pathname === '/drive/v3/files/generateIds' && init.method === 'GET') {
        return json({ ids: [`allocated_${++nextId}`], space: 'drive', kind: 'drive#generatedIds' });
      }
      if (url.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
        const boundary = init.headers['Content-Type'].split('boundary=')[1];
        const parts = init.body.split(`--${boundary}`);
        const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
        const body = parts[2].split('\r\n\r\n')[1].slice(0, -2);
        if (files.has(metadata.id)) return json({ error: 'exists' }, 409);
        files.set(metadata.id, { metadata, body });
        if (nextResult === 'lost') {
          nextResult = 'ok';
          throw new Error('private request details');
        }
        return json({ id: metadata.id, name: metadata.name, appProperties: metadata.appProperties });
      }
      if (url.pathname === '/drive/v3/files' && init.method === 'GET') {
        const q = url.searchParams.get('q');
        const version = /key='tfVersion' and value='([^']+)'/.exec(q)?.[1];
        const found = [...files.entries()]
          .filter(
            ([, value]) =>
              value.metadata.appProperties.tfDataset === datasetId &&
              (!version || value.metadata.appProperties.tfVersion === version)
          )
          .map(([fileId, value]) => ({
            id: fileId,
            name: value.metadata.name,
            mimeType: value.metadata.mimeType,
            appProperties: value.metadata.appProperties
          }));
        return json({ files: found, incompleteSearch: false });
      }
      const match = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (match && init.method === 'GET' && url.searchParams.get('alt') === 'media') {
        return files.has(match[1]) ? content(files.get(match[1]).body) : content('', 404);
      }
    } else {
      if (url.pathname === '/v1/disk/resources/upload' && init.method === 'GET') {
        const path = url.searchParams.get('path');
        if (files.has(path)) return json({ error: 'exists' }, 409);
        return json({
          href: `https://uploader9x.disk.yandex.net/upload-target/fake?path=${encodeURIComponent(path)}`,
          method: 'PUT',
          templated: false,
          operation_id: 'FAKE_OPERATION_NOT_PERSISTED'
        });
      }
      if (url.hostname === 'uploader9x.disk.yandex.net' && init.method === 'PUT') {
        const path = url.searchParams.get('path');
        if (files.has(path)) return json({ error: 'exists' }, 409);
        const item = { body: init.body };
        if (deferYandex) pending.set(path, item);
        else files.set(path, item);
        if (nextResult === 'lost') {
          nextResult = 'ok';
          throw new Error('private request details');
        }
        return new Response(null, { status: deferYandex ? 202 : 201 });
      }
      if (url.pathname === '/v1/disk/resources/download' && init.method === 'GET') {
        const path = url.searchParams.get('path');
        if (!files.has(path)) return json({ error: 'not found' }, 404);
        return json({
          href: `https://downloader.disk.yandex.ru/disk/fake?path=${encodeURIComponent(path)}`,
          method: 'GET',
          templated: false
        });
      }
      if (url.hostname === 'downloader.disk.yandex.ru' && init.method === 'GET') {
        const path = url.searchParams.get('path');
        return files.has(path) ? content(files.get(path).body) : content('', 404);
      }
      if (url.pathname === '/v1/disk/resources' && url.searchParams.get('path') === 'app:/' && init.method === 'GET') {
        const entries = [...files.keys()]
          .map(path => ({ name: path.slice('app:/'.length), type: 'file' }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return json({
          type: 'dir',
          _embedded: { offset, limit, total: entries.length, items: entries.slice(offset, offset + limit) }
        });
      }
    }
    throw new Error('unexpected fake API request');
  }
  return {
    files,
    pending,
    calls,
    fetchImpl,
    setNextResult,
    finishPending,
    setDeferred(value) {
      deferYandex = value;
    },
    setAccount(value) {
      currentAccount = value;
    },
    setClient(value) {
      currentClient = value;
    },
    failIdentity(value) {
      identityFailure = value;
    }
  };
}
function device(provider, cloud) {
  const options = {
    provider,
    datasetId,
    accessToken,
    fetchImpl: cloud.fetchImpl,
    ...(provider === 'google' ? { folderId } : {})
  };
  const upload = createCloudUploadTransport({ ...options, cryptoSource });
  const readTransport = createReadOnlyCloudTransport({ provider, accessToken, fetchImpl: cloud.fetchImpl });
  const send = request => readTransport.send(request);
  const reader =
    provider === 'google'
      ? createGoogleVersionReader({ datasetId, folderId, send })
      : createYandexVersionReader({ datasetId, send });
  const verifier = createCloudVersionVerifier({
    provider,
    datasetId,
    send,
    ...(provider === 'google' ? { folderId } : {})
  });
  return { upload, reader, verifier };
}
function session(provider, cloud, extra = {}) {
  return createAuthenticatedCloudSession({
    provider,
    clientId: clientIds[provider],
    accountKey,
    datasetId,
    accessToken,
    fetchImpl: cloud.fetchImpl,
    cryptoSource,
    ...(provider === 'google' ? { folderId } : {}),
    ...extra
  });
}
async function prepare(publicSnapshot, parent = null) {
  return sealHistoryVersion({ publicSnapshot, parent, datasetId, recoveryKey, versionId: id(), cryptoSource });
}
async function sendVersion(provider, client, envelope) {
  const idResult = provider === 'google' ? await client.upload.generateFileId() : null;
  if (provider === 'google') expect(idResult.status).toBe('generated');
  const args = { envelope, ...(idResult ? { fileId: idResult.fileId } : {}) };
  const result = await client.upload.upload(args);
  return { args, result };
}

beforeEach(() => {
  datasetId = id();
  recoveryKey = generateRecoveryKey(cryptoSource);
  const state = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero-1', nick: 'Личное имя' }],
    plannerEntries: [
      {
        id: 'task-1',
        title: 'Личная задача',
        date: '2026-11-01',
        time: '18:00',
        kind: 'task',
        recurrence: 'daily',
        status: 'todo',
        statusByDate: { '2026-11-01': 'todo' }
      }
    ]
  });
  const { ui, ...snapshot } = state;
  publicRoot = buildPublicSnapshot(planSyncIdentities({ snapshot, cryptoSource }).snapshot);
});

describe.each(['google', 'yandex'])('%s — шифрование, отправка, проверка и два тестовых ПК', provider => {
  it('читает ветки, обнаруживает различия и готовит выбор без изменения данных второго ПК', async () => {
    const cloud = fakeCloud(provider);
    const a = device(provider, cloud);
    const b = device(provider, cloud);
    const root = await prepare(publicRoot);
    const local = structuredClone(publicRoot);
    const remote = structuredClone(publicRoot);
    local.sections.planner.records[0].fields.title = 'Задача на первом ПК';
    remote.sections.planner.records[0].fields.time = '20:30';
    remote.sections.planner.records[0].fields.statusByDate['2026-11-01'] = 'done';
    const localVersion = await prepare(local, root.pin);
    const remoteVersion = await prepare(remote, root.pin);

    for (const version of [root, localVersion, remoteVersion]) {
      const sender = version === remoteVersion ? b : a;
      const { args, result } = await sendVersion(provider, sender, version.envelope);
      expect(result).toEqual({ status: 'accepted' });
      expect(await sender.verifier.verify(args)).toEqual({ status: 'verified' });
    }
    const listed = await a.reader.list();
    expect(listed.map(x => x.versionId).sort()).toEqual(
      [root.pin.versionId, localVersion.pin.versionId, remoteVersion.pin.versionId].sort()
    );
    const downloads = await Promise.all(listed.map(item => a.reader.read(item.versionId)));
    expect(downloads.every(x => x.status === 'found')).toBe(true);
    const tree = await verifyHistory({
      envelopes: downloads.map(x => x.envelope),
      expectedDatasetId: datasetId,
      recoveryKey,
      root: root.pin,
      knownPins: [root.pin],
      cryptoSource
    });
    expect(tree.commonAncestor(localVersion.pin, remoteVersion.pin)).toEqual(root.pin);
    const comparison = comparePublicSnapshots({
      local: tree.publicSnapshot(localVersion.pin),
      cloud: tree.publicSnapshot(remoteVersion.pin)
    });
    const changes = comparison.entries.find(item => item.type === 'plannerEntry').changes;
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: ['time'], local: { present: true, value: '18:00' }, cloud: { present: true, value: '20:30' } },
        {
          path: ['statusByDate', '2026-11-01'],
          local: { present: true, value: 'todo' },
          cloud: { present: true, value: 'done' }
        }
      ])
    );
    const record = snapshot => ({ deleted: false, fields: snapshot.sections.planner.records[0].fields });
    const review = createSelectiveRecordReview({
      base: record(publicRoot),
      local: record(local),
      remote: record(remote)
    });
    const candidate = review.plan({ selected: [['statusByDate', '2026-11-01']] });
    expect(candidate.record.fields).toMatchObject({
      title: 'Задача на первом ПК',
      time: '18:00',
      statusByDate: { '2026-11-01': 'done' }
    });
    expect(local.sections.planner.records[0].fields.statusByDate['2026-11-01']).toBe('todo');
    for (const item of cloud.files.values())
      for (const secret of ['Личное имя', 'Личная задача', 'Задача на первом ПК', recoveryKey, accessToken]) {
        expect(item.body).not.toContain(secret);
      }
  });

  it('после потери ответа записи сначала обнаруживает совпадение чтением и не повторяет запрос', async () => {
    const cloud = fakeCloud(provider);
    const a = device(provider, cloud);
    const v = await prepare(publicRoot);
    cloud.setNextResult('lost');
    const { args, result } = await sendVersion(provider, a, v.envelope);
    expect(result).toEqual({ status: 'unknown' });
    const before = cloud.calls.filter(x => ['PUT', 'POST'].includes(x.method)).length;
    expect(await a.verifier.verify(args)).toEqual({ status: 'verified' });
    expect(cloud.calls.filter(x => ['PUT', 'POST'].includes(x.method))).toHaveLength(before);
    expect(cloud.files.size).toBe(1);
  });

  it('не принимает изменённые байты, повторные поля или отсутствие как проверенную запись', async () => {
    const cloud = fakeCloud(provider);
    const a = device(provider, cloud);
    const v = await prepare(publicRoot);
    const { args } = await sendVersion(provider, a, v.envelope);
    const item = [...cloud.files.values()][0];
    const body = item.body;
    item.body = body.replace('"version":1', '"version":1,"version":1');
    expect(await a.verifier.verify(args)).toEqual({ status: 'mismatch' });
    item.body = `\ufeff${body}`;
    expect((await a.verifier.verify(args)).status).not.toBe('verified');
    item.body = body.replace('"format":', ' "format":');
    expect(await a.verifier.verify(args)).toEqual({ status: 'mismatch' });
    cloud.files.clear();
    expect(await a.verifier.verify(args)).toEqual({ status: 'not_found' });
  });

  it('не выводит токены и тело исключений при ошибке чтения', async () => {
    const v = await prepare(publicRoot);
    const send = vi.fn(async () => {
      throw new Error(`private ${accessToken} ${recoveryKey}`);
    });
    const verifier = createCloudVersionVerifier({
      provider,
      datasetId,
      send,
      ...(provider === 'google' ? { folderId } : {})
    });
    const result = await verifier.verify({ envelope: v.envelope, ...(provider === 'google' ? { fileId: 'id' } : {}) });
    expect(result).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain(recoveryKey);
  });
});

describe.each(['google', 'yandex'])('%s — сверка аккаунта перед сетевыми действиями', provider => {
  it('использует один токен для проверки, записи, проверки содержимого, списка и чтения', async () => {
    const cloud = fakeCloud(provider);
    const a = session(provider, cloud);
    const v = await prepare(publicRoot);
    const allocated = provider === 'google' ? await a.generateFileId() : null;
    const args = { envelope: v.envelope, ...(allocated ? { fileId: allocated.fileId } : {}) };
    expect(await a.upload(args)).toEqual({ status: 'accepted' });
    expect(await a.verify(args)).toEqual({ status: 'verified' });
    expect(await a.listWithDates()).toMatchObject({
      status: 'listed',
      versions: [{ versionId: v.envelope.versionId, modifiedAt: null }]
    });
    expect(await a.read(v.envelope.versionId)).toEqual({ status: 'found', envelope: v.envelope });
    const identityCalls = cloud.calls.filter(call =>
      call.url.includes(provider === 'google' ? '/drive/v3/about' : 'login.yandex.ru/info')
    );
    expect(identityCalls).toHaveLength(provider === 'google' ? 5 : 4);
    for (const call of identityCalls)
      expect(call.headers.Authorization).toBe(`${provider === 'google' ? 'Bearer' : 'OAuth'} ${accessToken}`);
    for (const call of cloud.calls.filter(call => call.method === 'PUT'))
      expect(call.headers.Authorization).toBeUndefined();
  });

  it('смена аккаунта останавливает запись и чтение до запросов диска', async () => {
    const cloud = fakeCloud(provider);
    const a = session(provider, cloud);
    const v = await prepare(publicRoot);
    const allocated = provider === 'google' ? await a.generateFileId() : null;
    const args = { envelope: v.envelope, ...(allocated ? { fileId: allocated.fileId } : {}) };
    cloud.setAccount('OTHER_ACCOUNT');
    const before = cloud.calls.length;
    expect(await a.upload(args)).toEqual({ status: 'account_mismatch' });
    expect(await a.verify(args)).toEqual({ status: 'account_mismatch' });
    expect(await a.listWithDates()).toEqual({ status: 'account_mismatch' });
    expect(await a.read(v.envelope.versionId)).toEqual({ status: 'account_mismatch' });
    expect(
      cloud.calls
        .slice(before)
        .every(call => call.url.includes(provider === 'google' ? '/drive/v3/about' : 'login.yandex.ru/info'))
    ).toBe(true);
    expect(cloud.files.size).toBe(0);
  });

  it('ошибка идентификации не раскрывает исходные сведения и не отправляет файл', async () => {
    const cloud = fakeCloud(provider);
    const a = session(provider, cloud);
    const v = await prepare(publicRoot);
    const allocated = provider === 'google' ? await a.generateFileId() : null;
    cloud.failIdentity(true);
    const result = await a.upload({ envelope: v.envelope, ...(allocated ? { fileId: allocated.fileId } : {}) });
    expect(result).toEqual({ status: 'account_unavailable' });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain(accountKey);
    expect(cloud.files.size).toBe(0);
  });

  it('после потерянного ответа возвращает unknown и сверяет без повторной записи', async () => {
    const cloud = fakeCloud(provider);
    const a = session(provider, cloud);
    const v = await prepare(publicRoot);
    const allocated = provider === 'google' ? await a.generateFileId() : null;
    const args = { envelope: v.envelope, ...(allocated ? { fileId: allocated.fileId } : {}) };
    cloud.setNextResult('lost');
    expect(await a.upload(args)).toEqual({ status: 'unknown' });
    expect(await a.verify(args)).toEqual({ status: 'verified' });
    expect(cloud.calls.filter(call => ['PUT', 'POST'].includes(call.method))).toHaveLength(1);
  });
});

describe('границы изолированного соединения', () => {
  it('не запускает параллельное действие и фиксирует конверт до проверки аккаунта', async () => {
    const cloud = fakeCloud('google');
    const v = await prepare(publicRoot);
    let release;
    const waiting = new Promise(resolve => {
      release = resolve;
    });
    const gatedFetch = async (url, init) => {
      if (url.includes('/drive/v3/about')) await waiting;
      return cloud.fetchImpl(url, init);
    };
    const a = session('google', cloud, { fetchImpl: gatedFetch });
    const mutable = { ...v.envelope };
    const started = a.upload({ envelope: mutable, fileId: 'allocated_test' });
    mutable.ciphertext = 'spoofed';
    await expect(a.listWithDates()).rejects.toThrow();
    release();
    expect(await started).toEqual({ status: 'accepted' });
    expect(JSON.parse(cloud.files.get('allocated_test').body)).toEqual(v.envelope);
  });

  it('таймаут идентификации не приводит к поздней записи, даже если fetch игнорирует abort', async () => {
    const cloud = fakeCloud('google');
    const v = await prepare(publicRoot);
    let release;
    const waiting = new Promise(resolve => {
      release = resolve;
    });
    const gatedFetch = async (url, init) => {
      if (url.includes('/drive/v3/about')) await waiting;
      return cloud.fetchImpl(url, init);
    };
    const a = session('google', cloud, { fetchImpl: gatedFetch, timeoutMs: 20 });
    const result = await a.upload({ envelope: v.envelope, fileId: 'allocated_test' });
    expect(result).toEqual({ status: 'account_unavailable' });
    expect(await a.upload({ envelope: v.envelope, fileId: 'allocated_test' })).toEqual({
      status: 'account_unavailable'
    });
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cloud.calls.every(call => call.method === 'GET')).toBe(true);
    expect(cloud.files.size).toBe(0);
  });

  it.each(['google', 'yandex'])(
    'не начинает сверку %s, пока запоздавший запрос записи не завершился',
    async provider => {
      const cloud = fakeCloud(provider);
      const v = await prepare(publicRoot);
      let release;
      const waiting = new Promise(resolve => {
        release = resolve;
      });
      const gatedFetch = async (url, init) => {
        const result = await cloud.fetchImpl(url, init);
        if (init.method === (provider === 'google' ? 'POST' : 'PUT')) await waiting;
        return result;
      };
      const a = session(provider, cloud, { fetchImpl: gatedFetch, timeoutMs: 20 });
      const allocated = provider === 'google' ? await a.generateFileId() : null;
      const args = { envelope: v.envelope, ...(allocated ? { fileId: allocated.fileId } : {}) };
      expect(await a.upload(args)).toEqual({ status: 'unknown' });
      expect(cloud.files.size).toBe(1);
      await expect(a.verify(args)).rejects.toThrow();
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(await a.verify(args)).toEqual({ status: 'verified' });
      expect(cloud.calls.filter(call => ['PUT', 'POST'].includes(call.method))).toHaveLength(1);
    }
  );

  it('отклоняет неподходящие ключи аккаунта и геттеры до сети', async () => {
    const cloud = fakeCloud('google');
    const v = await prepare(publicRoot);
    expect(() => session('google', cloud, { accountKey: 'name@example.test' })).toThrow();
    expect(() => session('google', cloud, { clientId: 'wrong' })).toThrow();
    let called = false;
    const envelope = { ...v.envelope };
    Object.defineProperty(envelope, 'ciphertext', {
      enumerable: true,
      get() {
        called = true;
        throw new Error('private');
      }
    });
    const a = session('google', cloud);
    await expect(a.upload({ envelope, fileId: 'allocated_test' })).rejects.toThrow();
    expect(called).toBe(false);
    expect(cloud.calls).toHaveLength(0);
  });
});

describe('специфические ограничения сервиса', () => {
  it('для Яндекса несовпадающий client_id не считается подтверждением аккаунта', async () => {
    const cloud = fakeCloud('yandex');
    const a = session('yandex', cloud);
    const v = await prepare(publicRoot);
    cloud.setClient('another_client_id_123456');
    expect(await a.upload({ envelope: v.envelope })).toEqual({ status: 'account_unavailable' });
    expect(cloud.files.size).toBe(0);
  });
  it('при повторном Google ID отвечает конфликтом и не подменяет другое содержимое', async () => {
    const cloud = fakeCloud('google');
    const a = device('google', cloud);
    const first = await prepare(publicRoot);
    const { args } = await sendVersion('google', a, first.envelope);
    const changed = structuredClone(publicRoot);
    changed.sections.planner.records[0].fields.title = 'Другое содержимое';
    // Повтор versionId с новым nonce/данными — конфликт, а не новая версия.
    const second = await sealHistoryVersion({
      publicSnapshot: changed,
      parent: null,
      datasetId,
      recoveryKey,
      versionId: first.envelope.versionId,
      cryptoSource
    });
    const replay = { ...args, envelope: second.envelope };
    expect(await a.upload.upload(replay)).toEqual({ status: 'conflict' });
    expect(await a.verifier.verify(args)).toEqual({ status: 'verified' });
    expect(await a.verifier.verify(replay)).toEqual({ status: 'mismatch' });
    expect(cloud.files.size).toBe(1);
  });
  it('для Google отклоняет совпадающее имя версии, если найден другой ID', async () => {
    const cloud = fakeCloud('google');
    const a = device('google', cloud);
    const v = await prepare(publicRoot);
    const { args } = await sendVersion('google', a, v.envelope);
    expect(await a.verifier.verify({ ...args, fileId: 'another_valid_id' })).toEqual({ status: 'mismatch' });
  });
  it('для Яндекса 202 не считается завершённой записью и проверяется позже без PUT', async () => {
    const cloud = fakeCloud('yandex');
    cloud.setDeferred(true);
    const a = device('yandex', cloud);
    const v = await prepare(publicRoot);
    const { args, result } = await sendVersion('yandex', a, v.envelope);
    expect(result).toEqual({ status: 'pending' });
    expect(await a.verifier.verify(args)).toEqual({ status: 'not_found' });
    cloud.finishPending();
    expect(await a.verifier.verify(args)).toEqual({ status: 'verified' });
    expect(cloud.calls.filter(x => x.method === 'PUT')).toHaveLength(1);
  });
});
