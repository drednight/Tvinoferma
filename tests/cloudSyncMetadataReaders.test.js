import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleVersionReader,
  createYandexVersionReader
} from '../js/modules/cloudSync/providers/versionReaders.js';
import { createReadOnlyCloudTransport } from '../js/modules/cloudSync/providers/readOnlyTransport.js';
import { versionFileName } from '../js/modules/cloudSync/providers/common.js';

const datasetId = '0b754a1a-b12c-4ab7-9435-ea2617c95426';
const otherDataset = '37f14ec7-6672-459d-9488-a2fa8c9f3e89';
const first = 'ec254d5d-9285-4b7c-9c70-a5259cedb41d';
const second = '7c9db0d2-e0e6-4fc8-a548-78b9caec3421';
const respond = body => ({ status: 200, body: JSON.stringify(body) });
const googleFile = (versionId, modifiedTime) => ({
  id: `private_google_id_${versionId.replaceAll('-', '')}`,
  name: versionFileName(datasetId, versionId),
  mimeType: 'application/octet-stream',
  appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: versionId },
  ...(modifiedTime === undefined ? {} : { modifiedTime })
});
const yandexFile = (versionId, modified, data = datasetId) => ({
  name: versionFileName(data, versionId),
  type: 'file',
  path: 'disk:/private-not-returned',
  ...(modified === undefined ? {} : { modified })
});
const yandexPage = items => ({ type: 'dir', _embedded: { items, offset: 0, limit: 100, total: items.length } });
const google = send => createGoogleVersionReader({ datasetId, folderId: 'private-folder', send });
const yandex = send => createYandexVersionReader({ datasetId, send });

describe('подготовка справочных дат облачных версий', () => {
  it('Google запрашивает и возвращает только дату и versionId после двух полных обходов', async () => {
    const send = vi.fn(async () =>
      respond({ files: [googleFile(first, '2026-10-29T15:45:00+03:00'), googleFile(second, null)] })
    );
    const result = await google(send).listWithDates();
    expect(result).toEqual([
      { versionId: second, modifiedAt: null },
      { versionId: first, modifiedAt: '2026-10-29T12:45:00.000Z' }
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(new URL(send.mock.calls[0][0].url).searchParams.get('fields')).toContain('modifiedTime');
    expect(JSON.stringify(result)).not.toContain('private_google_id');
    // Старый вызов остаётся совместимым и не решает порядок по времени.
    expect(await google(send).list()).toEqual([{ versionId: second }, { versionId: first }]);
  });

  it('Яндекс отдаёт дату для каждого файла своего набора и не раскрывает чужие имена/пути', async () => {
    const send = vi.fn(async () =>
      respond(
        yandexPage([
          yandexFile(first, '2026-10-29T15:45:00+03:00'),
          yandexFile(second, '<script>private</script>'),
          yandexFile(first, '2026-10-30T00:00:00Z', otherDataset),
          { name: 'личная заметка', type: 'file', path: 'disk:/private' }
        ])
      )
    );
    const result = await yandex(send).listWithDates();
    expect(result).toEqual([
      { versionId: second, modifiedAt: null },
      { versionId: first, modifiedAt: '2026-10-29T12:45:00.000Z' }
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/private|личная|script/);
    expect(await yandex(send).list()).toEqual([{ versionId: second }, { versionId: first }]);
  });

  it.each(['google', 'yandex'])(
    '%s обнаруживает изменение времени между обходами, даже в долях миллисекунды',
    async provider => {
      let call = 0;
      const send = async () => {
        const date = ++call === 1 ? '2026-10-29T12:45:00.123000001Z' : '2026-10-29T12:45:00.123000002Z';
        return provider === 'google'
          ? respond({ files: [googleFile(first, date)] })
          : respond(yandexPage([yandexFile(first, date)]));
      };
      const reader = provider === 'google' ? google(send) : yandex(send);
      await expect(reader.listWithDates()).rejects.toThrow('изменился');
    }
  );

  it.each(['google', 'yandex'])(
    '%s при отсутствующей или неверной дате возвращает null, без содержимого ошибки',
    async provider => {
      const bad = 'PRIVATE: пароль и путь';
      const send = async () =>
        provider === 'google'
          ? respond({ files: [googleFile(first, bad), googleFile(second)] })
          : respond(yandexPage([yandexFile(first, bad), yandexFile(second)]));
      const result = await (provider === 'google' ? google(send) : yandex(send)).listWithDates();
      expect(result.every(item => item.modifiedAt === null)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(bad);
    }
  );

  it('Google проходит тот же ограниченный GET-транспорт с новым разрешённым полем', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ files: [googleFile(first, '2026-10-29T12:00:00Z')] }), { status: 200 })
    );
    const transport = createReadOnlyCloudTransport({ provider: 'google', accessToken: 'test-token', fetchImpl });
    const result = await google(transport.send).listWithDates();
    expect(result).toEqual([{ versionId: first, modifiedAt: '2026-10-29T12:00:00.000Z' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    expect(JSON.stringify(result)).not.toContain('test-token');
  });
});
