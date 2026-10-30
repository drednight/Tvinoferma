import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { encryptSnapshot, generateRecoveryKey } from '../js/modules/cloudSync/envelope.js';
import {
  googleListRequest,
  googleDownloadRequest,
  googleCreateRequest
} from '../js/modules/cloudSync/providers/googleDrive.js';
import {
  yandexListRequest,
  yandexMetadataRequest,
  yandexUploadLinkRequest,
  yandexDownloadLinkRequest,
  yandexUploadContentRequest,
  yandexDownloadContentRequest
} from '../js/modules/cloudSync/providers/yandexDisk.js';
import { versionFileName } from '../js/modules/cloudSync/providers/common.js';

const datasetId = '0b754a1a-b12c-4ab7-9435-ea2617c95426';
const versionId = 'ec254d5d-9285-4b7c-9c70-a5259cedb41d';
const otherId = 'fd254d5d-9285-4b7c-9c70-a5259cedb41d';
const folderId = '123_google-folder_ABC';
const uploadLink = {
  href: 'https://uploader1d.dst.yandex.net:443/upload-target/signed?secret=not-a-real-token',
  method: 'PUT',
  templated: false
};
const downloadLink = {
  href: 'https://downloader.dst.yandex.ru/disk/signed?secret=not-a-real-token',
  method: 'GET',
  templated: false
};
let envelope;
let recoveryKey;

beforeEach(async () => {
  recoveryKey = generateRecoveryKey(webcrypto);
  envelope = await encryptSnapshot({
    snapshot: { character: 'Частное имя', note: 'личная заметка', password: 'secret-value' },
    recoveryKey,
    datasetId,
    versionId,
    cryptoSource: webcrypto
  });
});

describe('идентификация облачной версии', () => {
  it('использует только идентификаторы, не пользовательское имя', () => {
    expect(versionFileName(datasetId, versionId)).toBe(`tf-v1-${datasetId}-${versionId}.tfsc`);
    expect(() => versionFileName('../private', versionId)).toThrow();
  });
});

describe('подготовка Google Drive API без сети и токенов', () => {
  it('строит страничный поиск внутри папки и только по метаданным версии', () => {
    const request = googleListRequest({ folderId, datasetId, versionId, pageToken: "x y'&not-query" });
    const url = new URL(request.url);
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.pathname).toBe('/drive/v3/files');
    expect(url.searchParams.get('q')).toBe(
      `'${folderId}' in parents and trashed = false and appProperties has { key='tfFormat' and value='1' } and appProperties has { key='tfDataset' and value='${datasetId}' } and appProperties has { key='tfVersion' and value='${versionId}' }`
    );
    expect(url.searchParams.get('pageToken')).toBe("x y'&not-query");
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('fields')).toContain('incompleteSearch');
    expect(request).toMatchObject({ method: 'GET', credential: 'google', redirect: 'error' });
    expect(JSON.stringify(request)).not.toContain('Authorization');
  });

  it('допускает поиск всех версий набора без подстановки версии', () => {
    const url = new URL(googleListRequest({ folderId, datasetId }).url);
    expect(url.searchParams.get('q')).not.toContain('tfVersion');
  });

  it.each([
    { folderId: "x' or trashed = false", datasetId },
    { folderId, datasetId: '../private' },
    { folderId, datasetId, versionId: "x' or y" },
    { folderId, datasetId, pageToken: '' },
    { folderId, datasetId, pageToken: 'a'.repeat(4097) }
  ])('отклоняет неправильные параметры поиска %#', input => {
    expect(() => googleListRequest(input)).toThrow();
  });

  it('читает контент только по допустимому file ID', () => {
    const request = googleDownloadRequest('abcDEF_-123');
    expect(request).toMatchObject({ method: 'GET', credential: 'google', redirect: 'error' });
    expect(new URL(request.url).searchParams.get('alt')).toBe('media');
    expect(() => googleDownloadRequest('../a?alt=media')).toThrow();
  });

  it('создаёт отдельный multipart файл с зашифрованным содержимым', () => {
    const request = googleCreateRequest({ folderId, datasetId, envelope, cryptoSource: webcrypto });
    expect(request).toMatchObject({ method: 'POST', credential: 'google', redirect: 'error' });
    expect(new URL(request.url).searchParams.get('uploadType')).toBe('multipart');
    const boundary = request.headers['Content-Type'].split('boundary=')[1];
    const parts = request.body.split(`--${boundary}`);
    const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
    const content = JSON.parse(parts[2].split('\r\n\r\n')[1]);
    expect(metadata).toEqual({
      name: versionFileName(datasetId, versionId),
      mimeType: 'application/octet-stream',
      parents: [folderId],
      appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: versionId }
    });
    expect(content).toEqual(envelope);
    for (const secret of ['Частное имя', 'личная заметка', 'secret-value', recoveryKey]) {
      expect(JSON.stringify(request)).not.toContain(secret);
    }
    expect(JSON.stringify(request)).not.toContain('Authorization');
  });

  it('не принимает чужой набор, неподходящий конверт или путь с инъекцией', () => {
    expect(() => googleCreateRequest({ folderId, datasetId: otherId, envelope, cryptoSource: webcrypto })).toThrow();
    expect(() =>
      googleCreateRequest({ folderId, datasetId, envelope: { ...envelope, note: 'oops' }, cryptoSource: webcrypto })
    ).toThrow();
    expect(() => googleCreateRequest({ folderId: 'abc/../d', datasetId, envelope, cryptoSource: webcrypto })).toThrow();
  });

  it('отказывается от слишком большого multipart вместо усечения данных', () => {
    const huge = { ...envelope, ciphertext: 'A'.repeat(6_000_000) };
    expect(() => googleCreateRequest({ folderId, datasetId, envelope: huge, cryptoSource: webcrypto })).toThrow(
      /слишком большая/
    );
  });
});

describe('подготовка Яндекс Диска без сети и токенов', () => {
  it('перечисляет app:/ с ограниченной страницей', () => {
    const request = yandexListRequest({ offset: 100, limit: 100 });
    const url = new URL(request.url);
    expect(url.origin).toBe('https://cloud-api.yandex.net');
    expect(url.searchParams.get('path')).toBe('app:/');
    expect(url.searchParams.get('offset')).toBe('100');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(request).toMatchObject({
      method: 'GET',
      credential: 'yandex',
      redirect: 'error',
      headers: { Accept: 'application/json' }
    });
  });

  it.each([{ offset: -1 }, { offset: 1.1 }, { offset: Infinity }, { limit: 0 }, { limit: 1001 }])(
    'отклоняет недопустимые страницы %#',
    input => expect(() => yandexListRequest(input)).toThrow()
  );

  it('использует только безопасное имя версии, и всегда запрет перезаписи', () => {
    const options = { datasetId, versionId };
    const path = `app:/${versionFileName(datasetId, versionId)}`;
    const upload = new URL(yandexUploadLinkRequest(options).url);
    const download = new URL(yandexDownloadLinkRequest(options).url);
    const metadata = new URL(yandexMetadataRequest(options).url);
    expect(upload.pathname).toBe('/v1/disk/resources/upload');
    expect(download.pathname).toBe('/v1/disk/resources/download');
    for (const url of [upload, download, metadata]) expect(url.searchParams.get('path')).toBe(path);
    expect(upload.searchParams.get('overwrite')).toBe('false');
    expect(() => yandexUploadLinkRequest({ datasetId: '../../file', versionId })).toThrow();
  });

  it('передаёт зашифрованный конверт загрузчику без OAuth', () => {
    const request = yandexUploadContentRequest({ link: uploadLink, datasetId, versionId, envelope });
    expect(request).toMatchObject({ method: 'PUT', credential: 'none', redirect: 'error' });
    expect(JSON.parse(request.body)).toEqual(envelope);
    for (const secret of ['Частное имя', 'личная заметка', 'secret-value', recoveryKey, 'Authorization']) {
      expect(JSON.stringify(request)).not.toContain(secret);
    }
    expect(() => yandexUploadContentRequest({ link: uploadLink, datasetId: otherId, versionId, envelope })).toThrow();
    expect(() => yandexUploadContentRequest({ link: uploadLink, datasetId, versionId: otherId, envelope })).toThrow();
  });

  it('для скачивания требует отдельную доверенную отправку OAuth только известному хосту', () => {
    const request = yandexDownloadContentRequest(downloadLink);
    expect(request).toMatchObject({ method: 'GET', credential: 'yandex-download', redirect: 'error' });
    expect(JSON.stringify(request)).not.toContain('Authorization');
  });

  it.each([
    'http://uploader1d.dst.yandex.net/upload',
    'https://uploader1d.dst.yandex.net.evil.example/upload',
    'https://evil.example/uploader1d.dst.yandex.net/upload',
    'https://attacker@uploader1d.dst.yandex.net/upload',
    'https://uploader1d.dst.yandex.net:444/upload',
    'https://uploader1d.dst.yandex.net/upload#fragment',
    'https://uploader1d.dst.yandex.net/other',
    'https://uploader1d.dst.yandex.net/upload-target/%2e%2e%2fother',
    'https://other.yandex.net/upload',
    'file:///tmp/file'
  ])('отклоняет непроверенный адрес загрузки %#', href => {
    expect(() =>
      yandexUploadContentRequest({ link: { ...uploadLink, href }, datasetId, versionId, envelope })
    ).toThrow();
  });

  it.each([
    'https://downloader.dst.yandex.ru.evil.example/file',
    'https://uploader1d.dst.yandex.net/file',
    'https://other.yandex.ru/file',
    'https://downloader.dst.yandex.ru/other',
    'https://downloader.dst.yandex.ru/disk/%2e%2e%2fother',
    'http://downloader.dst.yandex.ru/file',
    'https://downloader.dst.yandex.ru:444/file'
  ])('не отправляет OAuth на непроверенный адрес скачивания %#', href => {
    expect(() => yandexDownloadContentRequest({ ...downloadLink, href })).toThrow();
  });

  it('не принимает шаблонные, неверные по методу или вычисляемые ссылки', () => {
    expect(() => yandexDownloadContentRequest({ ...downloadLink, templated: true })).toThrow();
    expect(() => yandexDownloadContentRequest({ ...downloadLink, method: 'PUT' })).toThrow();
    const getter = vi.fn(() => downloadLink.href);
    const link = {
      method: 'GET',
      templated: false,
      get href() {
        return getter();
      }
    };
    expect(() => yandexDownloadContentRequest(link)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('не выводит секретную ссылку в сообщение об ошибке', () => {
    const href = 'https://evil.example/signed?access=secret-test-value';
    try {
      yandexDownloadContentRequest({ ...downloadLink, href });
      throw new Error('ожидалась ошибка');
    } catch (error) {
      expect(String(error)).not.toContain(href);
      expect(String(error)).not.toContain('secret-test-value');
    }
  });
});
