import { STANDALONE_DATASET_ID } from '../js/modules/cloudSync/standaloneFileConstants.js';
import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  createGoogleVersionReader,
  createYandexVersionReader
} from '../js/modules/cloudSync/providers/versionReaders.js';
import { createReadOnlyCloudTransport } from '../js/modules/cloudSync/providers/readOnlyTransport.js';
import { versionFileName } from '../js/modules/cloudSync/providers/common.js';
import {
  decryptSnapshot,
  encryptSnapshot,
  generateRecoveryKey,
  generateSyncId
} from '../js/modules/cloudSync/envelope.js';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';

const datasetId = '0b754a1a-b12c-4ab7-9435-ea2617c95426';
const otherDataset = '37f14ec7-6672-459d-9488-a2fa8c9f3e89';
const v1 = 'ec254d5d-9285-4b7c-9c70-a5259cedb41d';
const v2 = '7c9db0d2-e0e6-4fc8-a548-78b9caec3421';
const signedHref = 'https://downloader.dst.yandex.ru/disk/file?signature=private';
const page = body => ({ status: 200, body: JSON.stringify(body) });
const missing = { status: 404, body: '' };
const googleFile = (versionId, id = `file_${versionId.replaceAll('-', '')}`) => ({
  id,
  name: versionFileName(datasetId, versionId),
  mimeType: 'application/octet-stream',
  appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: versionId }
});
const google = send => createGoogleVersionReader({ datasetId, folderId: 'private-folder', send });
const yandex = send => createYandexVersionReader({ datasetId, send });
const yandexList = (items, offset = 0, total = items.length, limit = 100) => ({
  type: 'dir',
  _embedded: { items, offset, limit, total }
});
const yandexFile = (versionId, data = datasetId) => ({
  name: versionFileName(data, versionId),
  type: 'file',
  extra: 'not returned'
});

async function encrypted(versionId = v1) {
  const key = generateRecoveryKey(webcrypto);
  const snapshot = { note: 'конфиденциальные сведения', events: [{ title: 'Событие' }] };
  const envelope = await encryptSnapshot({ snapshot, datasetId, versionId, recoveryKey: key, cryptoSource: webcrypto });
  return { key, snapshot, envelope };
}

describe('Google: только чтение зашифрованных версий', () => {
  it('дочитывает страницы дважды, сортирует версии и не возвращает Google id', async () => {
    const send = vi.fn(async request => {
      const token = new URL(request.url).searchParams.get('pageToken');
      return token
        ? page({ files: [googleFile(v2)], incompleteSearch: false })
        : page({ files: [googleFile(v1)], nextPageToken: 'next+opaque' });
    });
    const result = await google(send).list();
    expect(result).toEqual([{ versionId: v2 }, { versionId: v1 }]);
    expect(send).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain('file_');
    expect(send.mock.calls.map(([request]) => new URL(request.url).searchParams.get('pageToken'))).toEqual([
      null,
      'next+opaque',
      null,
      'next+opaque'
    ]);
  });

  it('отказывает при неполном поиске, цикле, отклонённой странице и неоднозначных версиях', async () => {
    const cases = [
      async () => page({ files: [], incompleteSearch: true }),
      async () => page({ files: [], incompleteSearch: null }),
      async () => page({ files: [], nextPageToken: '' }),
      async () => page({ files: [], nextPageToken: 'same' }),
      async request =>
        new URL(request.url).searchParams.has('pageToken')
          ? { status: 400, body: '' }
          : page({ files: [], nextPageToken: 'expired' }),
      async () => page({ files: [googleFile(v1, 'first'), googleFile(v1, 'second')] }),
      async () => page({ files: [googleFile(v1, 'same'), googleFile(v2, 'same')] }),
      async () => page({ files: [{ ...googleFile(v1), name: 'other-name' }] }),
      async () =>
        page({
          files: [{ ...googleFile(v1), appProperties: { ...googleFile(v1).appProperties, tfDataset: otherDataset } }]
        }),
      async () => page({ files: [], extra: 'unexpected' })
    ];
    for (const send of cases) await expect(google(send).list()).rejects.toThrow();
  });

  it('замечает изменение результатов между двумя обходами, но не называет отсутствие удалением', async () => {
    let calls = 0;
    const reader = google(async () => page({ files: ++calls === 1 ? [googleFile(v1)] : [] }));
    await expect(reader.list()).rejects.toThrow('изменился');
    const absent = google(async () => page({ files: [] }));
    expect(await absent.read(v1)).toEqual({ status: 'not_found' });
  });

  it('читает только найденный конверт, проверяет структуру и соответствие id', async () => {
    const { key, snapshot, envelope } = await encrypted();
    const send = vi.fn(async request =>
      new URL(request.url).pathname === '/drive/v3/files' ? page({ files: [googleFile(v1)] }) : page(envelope)
    );
    const result = await google(send).read(v1);
    expect(result.status).toBe('found');
    expect(
      await decryptSnapshot({
        envelope: result.envelope,
        recoveryKey: key,
        expectedDatasetId: datasetId,
        cryptoSource: webcrypto
      })
    ).toEqual(snapshot);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].url).toContain('alt=media');
    const bad = google(async request =>
      new URL(request.url).pathname === '/drive/v3/files'
        ? page({ files: [googleFile(v1)] })
        : page({ ...envelope, versionId: v2 })
    );
    await expect(bad.read(v1)).rejects.toThrow();
    // Структурный reader не имеет ключа: подмену шифротекста обязан отвергнуть следующий шаг.
    const altered = {
      ...envelope,
      ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1)
    };
    const tampered = google(async request =>
      new URL(request.url).pathname === '/drive/v3/files' ? page({ files: [googleFile(v1)] }) : page(altered)
    );
    const candidate = await tampered.read(v1);
    await expect(
      decryptSnapshot({
        envelope: candidate.envelope,
        recoveryKey: key,
        expectedDatasetId: datasetId,
        cryptoSource: webcrypto
      })
    ).rejects.toThrow();
    const lost = google(async request =>
      new URL(request.url).pathname === '/drive/v3/files' ? page({ files: [googleFile(v1)] }) : missing
    );
    await expect(lost.read(v1)).rejects.toThrow();
  });

  it('после чтения отдельно проверяет историю и замечает исчезновение известной версии', async () => {
    const state = normalizeState({
      schemaVersion: 10,
      plannerEntries: [{ id: 'task-1', title: 'Тестовая задача', date: '2026-11-01', kind: 'task', status: 'todo' }]
    });
    const { ui: _ui, ...local } = state;
    const snapshot = buildPublicSnapshot(planSyncIdentities({ snapshot: local, cryptoSource: webcrypto }).snapshot);
    const recoveryKey = generateRecoveryKey(webcrypto);
    const root = await sealHistoryVersion({
      publicSnapshot: snapshot,
      parent: null,
      recoveryKey,
      datasetId,
      versionId: v1,
      cryptoSource: webcrypto
    });
    const updated = structuredClone(snapshot);
    updated.sections.planner.records[0].fields.status = 'done';
    const child = await sealHistoryVersion({
      publicSnapshot: updated,
      parent: root.pin,
      recoveryKey,
      datasetId,
      versionId: v2,
      cryptoSource: webcrypto
    });
    let hideChild = false;
    const send = async request => {
      const url = new URL(request.url);
      if (url.pathname === '/drive/v3/files') {
        const q = url.searchParams.get('q');
        let files = [googleFile(v1, 'root_file'), ...(hideChild ? [] : [googleFile(v2, 'child_file')])];
        if (q.includes("key='tfVersion'")) files = files.filter(file => q.includes(file.appProperties.tfVersion));
        return page({ files });
      }
      return page(url.pathname.endsWith('root_file') ? root.envelope : child.envelope);
    };
    const reader = google(send);
    const load = async () => {
      const versions = await reader.list();
      return Promise.all(versions.map(async ({ versionId }) => (await reader.read(versionId)).envelope));
    };
    const check = envelopes =>
      verifyHistory({
        envelopes,
        expectedDatasetId: datasetId,
        recoveryKey,
        root: root.pin,
        knownPins: [child.pin],
        cryptoSource: webcrypto
      });
    const tree = await check(await load());
    expect(tree.publicSnapshot(child.pin).sections.planner.records[0].fields.status).toBe('done');
    hideChild = true;
    await expect(check(await load())).rejects.toThrow('ранее известная версия');
  });

  it('не включает ошибки fetch в сообщения, ограничивает число версий и страниц', async () => {
    const secret = 'token-and-private-url';
    const broken = google(async () => {
      throw new Error(secret);
    });
    await expect(broken.list()).rejects.not.toThrow(secret);
    const many = Array.from({ length: 130 }, () => googleFile(generateSyncId(webcrypto)));
    let call = 0;
    const long = google(async () =>
      page({
        files: ++call === 1 ? many.slice(0, 100) : many.slice(100),
        ...(call === 1 ? { nextPageToken: 'two' } : {})
      })
    );
    await expect(long.list()).rejects.toThrow();
    let n = 0;
    const pages = google(async () => page({ files: [], nextPageToken: `page${++n}` }));
    await expect(pages.list()).rejects.toThrow();
    expect(n).toBe(128);
  });
});

describe('Яндекс: только чтение зашифрованных версий', () => {
  it('обходит все offset/limit/total, перепроверяет полный список и скрывает посторонние имена', async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ name: `личная-заметка-${i}`, type: 'file' }));
    items[0] = yandexFile(v1);
    items[100] = yandexFile(v2);
    items[119] = yandexFile(v1, otherDataset);
    const send = vi.fn(async request => {
      const params = new URL(request.url).searchParams;
      const offset = Number(params.get('offset'));
      expect(params.get('limit')).toBe('100');
      return page(yandexList(items.slice(offset, offset + 100), offset, items.length));
    });
    const result = await yandex(send).list();
    expect(result).toEqual([{ versionId: v2 }, { versionId: v1 }]);
    expect(send.mock.calls.map(([request]) => Number(new URL(request.url).searchParams.get('offset')))).toEqual([
      0, 100, 0, 100
    ]);
    expect(JSON.stringify(result)).not.toContain('личная');
  });

  it('отказывает при неполном списке, смене total, повторе, неузнанной версии и превышении лимита', async () => {
    const cases = [
      async () => page({ type: 'dir' }),
      async () => page(yandexList([], 1, 0)),
      async () => page(yandexList([], 0, 10)),
      async () => page(yandexList([], 0, 0, 50)),
      async () => page(yandexList([], 0, 5001)),
      async () => page(yandexList([yandexFile(v1), yandexFile(v1)])),
      async () => page(yandexList([{ name: 'tf-v2-unknown.tfsc', type: 'file' }])),
      async () => page(yandexList([{ ...yandexFile(v1), type: 'dir' }])),
      async () => page(yandexList([{ name: '../secret', type: 'file' }])),
      async request => {
        const offset = Number(new URL(request.url).searchParams.get('offset'));
        return offset === 0 ? page(yandexList([yandexFile(v1)], 0, 2)) : page(yandexList([yandexFile(v2)], 1, 3));
      }
    ];
    for (const send of cases) await expect(yandex(send).list()).rejects.toThrow();
    const many = Array.from({ length: 130 }, () => yandexFile(generateSyncId(webcrypto)));
    const tooMany = yandex(async request => {
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      return page(yandexList(many.slice(offset, offset + 100), offset, many.length));
    });
    await expect(tooMany.list()).rejects.toThrow();
  });

  it('распознаёт изменение списка между полными проходами', async () => {
    let calls = 0;
    const reader = yandex(async () => page(yandexList([{ name: ++calls === 1 ? 'before' : 'after', type: 'file' }])));
    await expect(reader.list()).rejects.toThrow('изменился');
  });

  it('скачивает через проверенную ссылку и валидирует конверт; 404 не объявляет удалением', async () => {
    const { key, snapshot, envelope } = await encrypted();
    const send = vi.fn(async request =>
      request.credential === 'yandex' ? page({ href: signedHref, method: 'GET', templated: false }) : page(envelope)
    );
    const result = await yandex(send).read(v1);
    expect(result.status).toBe('found');
    expect(
      await decryptSnapshot({
        envelope: result.envelope,
        recoveryKey: key,
        expectedDatasetId: datasetId,
        cryptoSource: webcrypto
      })
    ).toEqual(snapshot);
    expect(send.mock.calls.map(([request]) => request.credential)).toEqual(['yandex', 'yandex-download']);
    const absent = yandex(vi.fn(async () => missing));
    expect(await absent.read(v1)).toEqual({ status: 'not_found' });
    const bad = yandex(async request =>
      request.credential === 'yandex'
        ? page({ href: signedHref, method: 'GET', templated: false })
        : page({ ...envelope, datasetId: otherDataset })
    );
    await expect(bad.read(v1)).rejects.toThrow();
  });

  it('не отправляет токен на подменённую ссылку и очищает ошибки', async () => {
    const send = vi.fn(async () =>
      page({ href: 'https://evil.example/disk/file?private=secret', method: 'GET', templated: false })
    );
    await expect(yandex(send).read(v1)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    const sendFailure = yandex(async () => {
      throw new Error('secret url');
    });
    await expect(sendFailure.read(v1)).rejects.not.toThrow('secret url');
  });

  it('сквозной mock использует один OAuth-токен для ссылки и файла', async () => {
    const { envelope } = await encrypted();
    const fetchImpl = vi.fn(async url =>
      url.startsWith('https://cloud-api.yandex.net/')
        ? new Response(JSON.stringify({ href: signedHref, method: 'GET', templated: false }), { status: 200 })
        : new Response(JSON.stringify(envelope), { status: 200 })
    );
    const transport = createReadOnlyCloudTransport({
      provider: 'yandex',
      accessToken: 'the-same-test-token',
      fetchImpl
    });
    const result = await yandex(transport.send).read(v1);
    expect(result.status).toBe('found');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers.Authorization).toBe('OAuth the-same-test-token');
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
    }
  });
});

describe.each(['google', 'yandex'])('%s: канонические байты для чтения и сверки', provider => {
  it('отклоняет повторные ключи при чтении и различает изменённый файл от сбоя сети', async () => {
    const { envelope } = await encrypted();
    const duplicate = JSON.stringify(envelope).replace('"version":1', '"version":1,"version":1');
    const file = googleFile(v1);
    const send = vi.fn(async request => {
      const url = new URL(request.url);
      if (provider === 'google' && url.pathname === '/drive/v3/files') return page({ files: [file] });
      if (provider === 'yandex' && url.hostname === 'cloud-api.yandex.net') {
        return page({ href: signedHref, method: 'GET', templated: false });
      }
      return { status: 200, body: duplicate };
    });
    const reader = provider === 'google' ? google(send) : yandex(send);
    await expect(reader.read(v1)).rejects.toThrow();
    const exact = provider === 'google' ? await reader.readExact(v1, file.id) : await reader.readExact(v1);
    expect(exact).toEqual({ status: 'content_mismatch' });
  });
});

describe('standalone backup collection has no legacy 128-file history boundary', () => {
  const versions = Array.from({ length: 140 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`);
  it('Google lists independent backups past the old history boundary while preserving strict pagination', async () => {
    const send = vi.fn(async request => {
      const url = new URL(request.url);
      const offset = url.searchParams.get('pageToken') === 'next' ? 100 : 0;
      const files = versions.slice(offset, offset + 100).map(versionId => ({
        id: `f${versionId}`,
        name: versionFileName(STANDALONE_DATASET_ID, versionId),
        mimeType: 'application/octet-stream',
        appProperties: { tfFormat: '1', tfDataset: STANDALONE_DATASET_ID, tfVersion: versionId }
      }));
      return page({ files, incompleteSearch: false, ...(offset === 0 ? { nextPageToken: 'next' } : {}) });
    });
    const reader = createGoogleVersionReader({ datasetId: STANDALONE_DATASET_ID, folderId: 'standalone-folder', send });
    expect(await reader.list()).toHaveLength(140);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('Yandex lists independent backups past the old history boundary without deleting older files', async () => {
    const send = vi.fn(async request => {
      const offset = Number(new URL(request.url).searchParams.get('offset') || 0);
      const items = versions
        .slice(offset, offset + 100)
        .map(versionId => ({ type: 'file', name: versionFileName(STANDALONE_DATASET_ID, versionId) }));
      return page(yandexList(items, offset, 140));
    });
    const reader = createYandexVersionReader({ datasetId: STANDALONE_DATASET_ID, send });
    expect(await reader.list()).toHaveLength(140);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
