import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { decryptSnapshot, encryptSnapshot, generateRecoveryKey } from '../js/modules/cloudSync/envelope.js';
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
