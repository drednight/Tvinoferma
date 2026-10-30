import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { encryptSnapshot, generateRecoveryKey } from '../js/modules/cloudSync/envelope.js';
import { versionFileName } from '../js/modules/cloudSync/providers/common.js';
import { googleGenerateFileIdRequest } from '../js/modules/cloudSync/providers/googleDrive.js';
import { createCloudUploadTransport } from '../js/modules/cloudSync/providers/uploadTransport.js';

const datasetId = '0b754a1a-b12c-4ab7-9435-ea2617c95426';
const versionId = 'ec254d5d-9285-4b7c-9c70-a5259cedb41d';
const otherId = 'fd254d5d-9285-4b7c-9c70-a5259cedb41d';
const folderId = 'folder_123';
const fileId = 'file-id_123';
const token = 'private-token';
const link = {
  href: 'https://uploader1.dst.yandex.net/upload-target/signed?token=PRIVATE',
  method: 'PUT',
  templated: false
};
let envelope;
let recoveryKey;

function googleReply(overrides = {}) {
  return {
    id: fileId,
    name: versionFileName(datasetId, versionId),
    appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: versionId },
    ...overrides
  };
}
function json(value, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
}
function empty(status) {
  return new Response(null, { status });
}
function create(provider, fetchImpl, extra = {}) {
  return createCloudUploadTransport({
    provider,
    datasetId,
    accessToken: token,
    ...(provider === 'google' ? { folderId } : {}),
    cryptoSource: webcrypto,
    fetchImpl,
    ...extra
  });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  recoveryKey = generateRecoveryKey(webcrypto);
  envelope = await encryptSnapshot({
    snapshot: { name: 'Секретное имя', password: 'СЕКРЕТНЫЙ ПАРОЛЬ' },
    recoveryKey,
    datasetId,
    versionId,
    cryptoSource: webcrypto
  });
});

describe('создание Google файла с заранее выданным ID', () => {
  it('генерирует один ID с минимальным запросом и не отправляет файл', async () => {
    const fetch = vi.fn(async () => json({ kind: 'drive#generatedIds', space: 'drive', ids: [fileId] }));
    const client = create('google', fetch);
    expect(await client.generateFileId()).toEqual({ status: 'generated', fileId });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(googleGenerateFileIdRequest().url);
    expect(new URL(url).searchParams.get('count')).toBe('1');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(init.body).toBeUndefined();
  });

  it('передаёт выданный ID и только зашифрованный конверт в multipart POST', async () => {
    const fetch = vi.fn(async () => json(googleReply()));
    const result = await create('google', fetch).upload({ envelope, fileId });
    expect(result).toEqual({ status: 'accepted' });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).origin).toBe('https://www.googleapis.com');
    expect(new URL(url).pathname).toBe('/upload/drive/v3/files');
    expect(new URL(url).searchParams.get('uploadType')).toBe('multipart');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` }
    });
    const boundary = init.headers['Content-Type'].split('boundary=')[1];
    const parts = init.body.split(`--${boundary}`);
    expect(JSON.parse(parts[1].split('\r\n\r\n')[1])).toEqual({
      id: fileId,
      name: versionFileName(datasetId, versionId),
      mimeType: 'application/octet-stream',
      parents: [folderId],
      appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: versionId }
    });
    expect(JSON.parse(parts[2].split('\r\n\r\n')[1])).toEqual(envelope);
    for (const privateValue of ['Секретное имя', 'СЕКРЕТНЫЙ ПАРОЛЬ', recoveryKey, token]) {
      expect(init.body).not.toContain(privateValue);
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it.each([409, 400, 401, 403, 404, 429, 500, 503])('не повторяет POST при ответе %i', async status => {
    const fetch = vi.fn(async () => json({ private: token }, status));
    const result = await create('google', fetch).upload({ envelope, fileId });
    expect(result).toEqual({ status: status === 409 ? 'conflict' : 'unknown' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    googleReply({ id: 'another' }),
    googleReply({ name: 'other' }),
    googleReply({ appProperties: { tfFormat: '1', tfDataset: otherId, tfVersion: versionId } }),
    googleReply({ extra: 'private' }),
    '{"id":"file-id_123","\\u0069d":"another","name":"x","appProperties":{}}',
    '{"id":"file-id_123","name":"x","appProperties":{"tfFormat":"1","tfFormat":"1"}}',
    'not json'
  ])('не считает неверный ответ подтверждением %#', async response => {
    const fetch = vi.fn(async () => json(response));
    expect(await create('google', fetch).upload({ envelope, fileId })).toEqual({ status: 'unknown' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { ids: [] },
    { ids: [fileId, 'second'] },
    { ids: ['../invalid'] },
    { ids: [fileId], space: 'appDataFolder' },
    { ids: [fileId], kind: 'other' },
    '{"ids":["file-id_123"],"\\u0069ds":["another"]}',
    { ids: [fileId], extra: true }
  ])('отклоняет невалидный ответ generateIds %#', async response => {
    const fetch = vi.fn(async () => json(response));
    expect(await create('google', fetch).generateFileId()).toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('отклоняет неправильный ID или чужой набор ещё до сети', async () => {
    const fetch = vi.fn();
    const client = create('google', fetch);
    for (const args of [
      { envelope },
      { envelope, fileId: '../x' },
      { envelope: { ...envelope, datasetId: otherId }, fileId },
      { envelope: { ...envelope, note: 'private' }, fileId },
      { envelope, fileId, extra: true }
    ])
      await expect(client.upload(args)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('двухэтапная загрузка Яндекс Диска', () => {
  it.each([
    [201, 'accepted'],
    [202, 'pending']
  ])('запрещает перезапись, PUT без токена: %i → %s', async (status, expected) => {
    const fetch = vi.fn().mockResolvedValueOnce(json(link)).mockResolvedValueOnce(empty(status));
    const result = await create('yandex', fetch).upload({ envelope });
    expect(result).toEqual({ status: expected });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [linkUrl, first] = fetch.mock.calls[0];
    expect(new URL(linkUrl).origin).toBe('https://cloud-api.yandex.net');
    expect(new URL(linkUrl).searchParams.get('overwrite')).toBe('false');
    expect(new URL(linkUrl).searchParams.get('path')).toBe(`app:/${versionFileName(datasetId, versionId)}`);
    expect(first).toMatchObject({ method: 'GET', headers: { Authorization: `OAuth ${token}` }, redirect: 'error' });
    const [uploadUrl, second] = fetch.mock.calls[1];
    expect(uploadUrl).toBe(link.href);
    expect(second).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      redirect: 'error'
    });
    expect(second.headers.Authorization).toBeUndefined();
    expect(JSON.parse(second.body)).toEqual(envelope);
    for (const secret of ['Секретное имя', 'СЕКРЕТНЫЙ ПАРОЛЬ', recoveryKey, token]) {
      expect(second.body).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503])('после ошибки ссылки %i не отправляет PUT', async status => {
    const fetch = vi.fn(async () => json({ error: token }, status));
    expect(await create('yandex', fetch).upload({ envelope })).toEqual({
      status: status === 409 ? 'conflict' : 'not_sent'
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503])(
    'после PUT %i не придумывает результат и не повторяет',
    async status => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json(link))
        .mockResolvedValueOnce(json({ error: token }, status));
      expect(await create('yandex', fetch).upload({ envelope })).toEqual({ status: 'unknown' });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    { ...link, href: 'https://uploader1.dst.yandex.net.evil.test/upload-target/signed' },
    { ...link, href: 'http://uploader1.dst.yandex.net/upload-target/signed' },
    { ...link, href: 'https://uploader1.dst.yandex.net/upload-target/%2e%2e/secret' },
    { ...link, href: 'https://attacker.test/upload-target/signed' },
    { ...link, method: 'POST' },
    { ...link, templated: true },
    { ...link, extra: 'private' },
    '{"href":"https://attacker.test","\\u0068ref":"https://uploader1.dst.yandex.net/upload-target/ok","method":"PUT","templated":false}',
    'not json'
  ])('не отправляет на недопустимую или неоднозначную ссылку %#', async value => {
    const fetch = vi.fn(async () => json(value));
    expect(await create('yandex', fetch).upload({ envelope })).toEqual({ status: 'not_sent' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('не принимает ID Google, дополнительные поля или генерацию ID', async () => {
    const fetch = vi.fn();
    const client = create('yandex', fetch);
    await expect(client.upload({ envelope, fileId })).rejects.toThrow();
    await expect(client.generateFileId()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('неизвестный исход, сроки и границы доверия', () => {
  it.each(['google', 'yandex'])('ошибка сети после начала записи %s — неизвестный исход', async provider => {
    const fetch = vi.fn();
    if (provider === 'yandex') fetch.mockResolvedValueOnce(json(link));
    fetch.mockRejectedValueOnce(new Error(`private ${token}`));
    const result = await create(provider, fetch).upload({ envelope, ...(provider === 'google' ? { fileId } : {}) });
    expect(result).toEqual({ status: 'unknown' });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('таймаут ссылки не запускает поздний PUT и не освобождает активный слот', async () => {
    const pending = deferred();
    const fetch = vi.fn().mockImplementationOnce(() => pending.promise);
    const client = create('yandex', fetch, { timeoutMs: 20 });
    const first = client.upload({ envelope });
    await expect(first).resolves.toEqual({ status: 'not_sent' });
    await expect(client.upload({ envelope })).rejects.toThrow();
    pending.resolve(json(link));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('монотонный срок блокирует PUT, даже если таймер ещё не выполнился', async () => {
    let now = 1000;
    const clock = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now);
    try {
      const fetch = vi.fn(async () => {
        now += 21;
        return json(link);
      });
      const result = await create('yandex', fetch, { timeoutMs: 20 }).upload({ envelope });
      expect(result).toEqual({ status: 'not_sent' });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('истекший срок после начала Google POST даёт unknown, не успех', async () => {
    let now = 1000;
    const clock = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now);
    try {
      const fetch = vi.fn(async () => {
        now += 21;
        return json(googleReply());
      });
      const result = await create('google', fetch, { timeoutMs: 20 }).upload({ envelope, fileId });
      expect(result).toEqual({ status: 'unknown' });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('не отправляет данные при неработающих или идущих назад монотонных часах', async () => {
    const clock = vi.spyOn(globalThis.performance, 'now');
    try {
      const fetch = vi.fn(async () => json(link));
      clock.mockReturnValue(Number.NaN);
      expect(await create('yandex', fetch).upload({ envelope })).toEqual({ status: 'not_sent' });
      clock.mockReturnValueOnce(1000).mockReturnValue(999);
      expect(await create('yandex', fetch).upload({ envelope })).toEqual({ status: 'not_sent' });
      expect(fetch).not.toHaveBeenCalled();
      // Даже если время всё ещё позже старта, обратный ход между этапами опасен.
      clock.mockReturnValueOnce(1000).mockReturnValueOnce(1001).mockReturnValue(1000.5);
      expect(await create('yandex', fetch).upload({ envelope })).toEqual({ status: 'not_sent' });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('таймаут PUT — unknown; позднее завершение не вызывает ещё одной отправки', async () => {
    const pending = deferred();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(link))
      .mockImplementationOnce(() => pending.promise);
    const client = create('yandex', fetch, { timeoutMs: 20 });
    const result = await client.upload({ envelope });
    expect(result).toEqual({ status: 'unknown' });
    await expect(client.upload({ envelope })).rejects.toThrow();
    pending.resolve(empty(201));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['google', 'yandex'])('документы и редиректы после записи %s не подтверждают успех', async provider => {
    const response = Object.assign(empty(201), {});
    Object.defineProperty(response, 'redirected', { value: true });
    const fetch = vi.fn();
    if (provider === 'yandex') fetch.mockResolvedValueOnce(json(link));
    fetch.mockResolvedValueOnce(response);
    expect(await create(provider, fetch).upload({ envelope, ...(provider === 'google' ? { fileId } : {}) })).toEqual({
      status: 'unknown'
    });
  });

  it('ограничивает ответ по content-length и по фактическим байтам', async () => {
    for (const response of [json(googleReply(), 200, { 'content-length': '65537' }), json('x'.repeat(65537))]) {
      const fetch = vi.fn(async () => response);
      expect(await create('google', fetch).upload({ envelope, fileId })).toEqual({ status: 'unknown' });
    }
  });

  it('фиксирует конверт до ожидания ссылки и не вызывает пользовательские геттеры', async () => {
    const pending = deferred();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(empty(201));
    const input = { ...envelope };
    const upload = create('yandex', fetch).upload({ envelope: input });
    input.ciphertext = 'not-the-original';
    pending.resolve(json(link));
    expect(await upload).toEqual({ status: 'accepted' });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(envelope);
    let invoked = false;
    const evil = { ...envelope };
    Object.defineProperty(evil, 'ciphertext', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('private');
      }
    });
    const secondFetch = vi.fn();
    await expect(create('google', secondFetch).upload({ envelope: evil, fileId })).rejects.toThrow();
    expect(invoked).toBe(false);
    expect(secondFetch).not.toHaveBeenCalled();
  });
});
