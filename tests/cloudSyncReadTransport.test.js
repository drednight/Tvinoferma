import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createReadOnlyCloudTransport } from '../js/modules/cloudSync/providers/readOnlyTransport.js';
import {
  googleCreateRequest,
  googleDownloadRequest,
  googleListRequest
} from '../js/modules/cloudSync/providers/googleDrive.js';
import {
  yandexDownloadContentRequest,
  yandexDownloadLinkRequest,
  yandexListRequest,
  yandexMetadataRequest,
  yandexUploadContentRequest,
  yandexUploadLinkRequest
} from '../js/modules/cloudSync/providers/yandexDisk.js';
import { encryptSnapshot, generateRecoveryKey } from '../js/modules/cloudSync/envelope.js';

const datasetId = '0b754a1a-b12c-4ab7-9435-ea2617c95426';
const versionId = 'ec254d5d-9285-4b7c-9c70-a5259cedb41d';
const token = 'private-OAuth-token_123';
const signed = {
  href: 'https://downloader.dst.yandex.ru/disk/sign?secret=temporary-secret',
  method: 'GET',
  templated: false
};
const jsonResponse = (body = '{}', options = {}) => new Response(body, { status: 200, ...options });
const make = (provider, fetchImpl, timeoutMs) =>
  createReadOnlyCloudTransport({ provider, accessToken: token, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });

async function encrypted() {
  return encryptSnapshot({
    snapshot: { title: 'Частное событие' },
    datasetId,
    versionId,
    recoveryKey: generateRecoveryKey(webcrypto),
    cryptoSource: webcrypto
  });
}

describe('ограниченный HTTP-транспорт чтения', () => {
  it('читает список и содержимое Google только с Bearer, без cookies и переходов', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"files":[]}'));
    const transport = make('google', fetchImpl);
    const list = googleListRequest({ folderId: 'private_folder-id', datasetId, pageToken: "part'x &" });
    const read = googleDownloadRequest('some_file-id');
    expect(await transport.send(list)).toEqual({ status: 200, body: '{"files":[]}' });
    expect(await transport.send(read)).toEqual({ status: 200, body: '{"files":[]}' });
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toMatch(/^https:\/\/www\.googleapis\.com\//);
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
      expect(init.headers.Authorization).toBe(`Bearer ${token}`);
      expect(init.body).toBeUndefined();
    }
    expect(JSON.stringify(transport)).not.toContain(token);
  });

  it('использует один и тот же OAuth Яндекса для метаданных, ссылки и разрешённого скачивания', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{}'));
    const transport = make('yandex', fetchImpl);
    for (const request of [
      yandexListRequest({ offset: 0, limit: 100 }),
      yandexMetadataRequest({ datasetId, versionId }),
      yandexDownloadLinkRequest({ datasetId, versionId }),
      yandexDownloadContentRequest(signed)
    ])
      expect((await transport.send(request)).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers.Authorization).toBe(`OAuth ${token}`);
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
    }
    expect(fetchImpl.mock.calls[3][0]).toBe(signed.href);
  });

  it('блокирует запись, посторонние хосты, подменённые query и заголовки до вызова fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse());
    const google = make('google', fetchImpl);
    const yandex = make('yandex', fetchImpl);
    const list = googleListRequest({ folderId: 'folder', datasetId });
    const envelope = await encrypted();
    const bad = [
      [google, { ...list, url: list.url.replace('www.googleapis.com', 'www.googleapis.com.evil.example') }],
      [google, { ...list, url: list.url.replace('https:', 'http:') }],
      [google, { ...list, url: list.url + '&access_token=LEAK' }],
      [google, { ...list, url: list.url.replace('tfFormat', 'other') }],
      [google, { ...list, redirect: 'follow' }],
      [google, { ...list, method: 'POST' }],
      [google, { ...list, headers: { Authorization: 'invented' } }],
      [google, googleCreateRequest({ folderId: 'folder', datasetId, envelope, cryptoSource: webcrypto })],
      [yandex, yandexUploadLinkRequest({ datasetId, versionId })],
      [
        yandex,
        yandexUploadContentRequest({
          link: { href: 'https://uploader1d.dst.yandex.net/upload-target/signed', method: 'PUT', templated: false },
          datasetId,
          versionId,
          envelope
        })
      ],
      [
        yandex,
        { ...yandexDownloadContentRequest(signed), url: 'https://downloader.dst.yandex.ru.evil.example/disk/signed' }
      ],
      [
        yandex,
        { ...yandexDownloadContentRequest(signed), url: 'https://attacker@downloader.dst.yandex.ru/disk/signed' }
      ],
      [
        yandex,
        { ...yandexDownloadContentRequest(signed), url: 'https://downloader.dst.yandex.ru/disk/%2e%2e%2fother' }
      ],
      [google, yandexListRequest()],
      [yandex, googleDownloadRequest('abc')]
    ];
    for (const [transport, request] of bad) await expect(transport.send(request)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('не вызывает getter и не считывает изменённый адрес после начала вызова', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse());
    const transport = make('google', fetchImpl);
    const getter = vi.fn(() => 'https://evil.example/');
    const bad = { ...googleListRequest({ folderId: 'folder', datasetId }) };
    Object.defineProperty(bad, 'url', { enumerable: true, get: getter });
    await expect(transport.send(bad)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const request = googleDownloadRequest('file-id');
    const expectedUrl = request.url;
    const pending = transport.send(request);
    request.url = 'https://evil.example/collect';
    await pending;
    expect(fetchImpl.mock.calls[0][0]).toBe(expectedUrl);
  });

  it('не раскрывает токен, тело ошибки и подписанную ссылку, запрещает редиректы', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`secret ${token} ${signed.href}`);
    });
    const transport = make('yandex', fetchImpl);
    let message;
    try {
      await transport.send(yandexDownloadContentRequest(signed));
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(token);
    expect(message).not.toContain(signed.href);
    expect(message).not.toContain('temporary-secret');
    const redirect = make('google', async () => ({
      status: 302,
      redirected: true,
      type: 'basic',
      url: 'https://evil.example/',
      headers: new Headers(),
      body: null
    }));
    await expect(redirect.send(googleDownloadRequest('id'))).rejects.toThrow('безопасно');
    const denied = make('google', async () => jsonResponse('SERVER-SECRET', { status: 403 }));
    expect(await denied.send(googleDownloadRequest('id'))).toEqual({ status: 403, body: '' });
  });

  it('ограничивает тело, проверяет UTF-8 и отказывает при таймауте', async () => {
    const huge = make('google', async () => jsonResponse('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(huge.send(googleListRequest({ folderId: 'folder', datasetId }))).rejects.toThrow();
    let oversizeSignal;
    const tooLarge = make('google', async (_url, init) => {
      oversizeSignal = init.signal;
      return jsonResponse('', { headers: { 'Content-Length': String(45 * 1024 * 1024 + 1) } });
    });
    await expect(tooLarge.send(googleDownloadRequest('id'))).rejects.toThrow();
    expect(oversizeSignal.aborted).toBe(true);
    const badUtf8 = make('google', async () => jsonResponse(Uint8Array.from([0xc3, 0x28])));
    await expect(badUtf8.send(googleDownloadRequest('id'))).rejects.toThrow();
    let signal;
    const hanging = make(
      'google',
      (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
      25
    );
    await expect(hanging.send(googleDownloadRequest('id'))).rejects.toThrow('безопасно');
    expect(signal.aborted).toBe(true);
  });

  it('отклоняет некорректный токен и ограничивает параллельные чтения', async () => {
    expect(() =>
      createReadOnlyCloudTransport({ provider: 'google', accessToken: 'token\r\nInjected: test' })
    ).toThrow();
    const finish = [];
    const fetchImpl = vi.fn(() => new Promise(resolve => finish.push(resolve)));
    const transport = make('google', fetchImpl);
    const request = googleDownloadRequest('id');
    const pending = Array.from({ length: 4 }, () => transport.send(request));
    await expect(transport.send(request)).rejects.toThrow('Слишком много');
    finish.forEach(resolve => resolve(jsonResponse('{}')));
    await expect(Promise.all(pending)).resolves.toHaveLength(4);
  });

  it('не открывает новые запросы, если fetch игнорирует прерывание после таймаута', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const transport = make('google', fetchImpl, 20);
    const request = googleDownloadRequest('id');
    const pending = Array.from({ length: 4 }, () => transport.send(request));
    const results = await Promise.allSettled(pending);
    expect(results.every(item => item.status === 'rejected')).toBe(true);
    await expect(transport.send(request)).rejects.toThrow('Слишком много');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
