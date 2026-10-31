import { describe, it, expect, vi } from 'vitest';
import { createNativeDiskFetch } from '../js/modules/cloudSync/providers/nativeDiskFetch.js';
import { createReadOnlyCloudTransport } from '../js/modules/cloudSync/providers/readOnlyTransport.js';
import { yandexDownloadContentRequest } from '../js/modules/cloudSync/providers/yandexDisk.js';
import {
  cloudAccessDiagnostic,
  CLOUD_ACCESS_MESSAGES,
  nativeCloudAccessDiagnostic
} from '../js/modules/cloudSync/providers/cloudAccessDiagnostics.js';

const request = yandexDownloadContentRequest({
  href: 'https://downloader.disk.yandex.ru/disk/PRIVATE_SIGNED_PATH?token=PRIVATE_SIGNATURE',
  method: 'GET',
  templated: false
});
describe('native transport fixed codes only', () => {
  it.each(['connect', 'timeout', 'busy', 'redirect', 'encoding', 'size', 'body', 'policy', 'client', 'transport'])(
    'retains safe %s diagnostic through the complete read transport',
    async reason => {
      const invoke = vi.fn(async () => {
        throw `cloud_disk_${reason}`;
      });
      const fetchImpl = createNativeDiskFetch({ provider: 'yandex', invoke });
      const transport = createReadOnlyCloudTransport({ provider: 'yandex', accessToken: 'PRIVATE_ACCESS', fetchImpl });
      const error = await transport.send(request).catch(e => e);
      const code = `download_content_${reason === 'timeout' ? 'timeout' : reason === 'transport' ? 'transport_unavailable' : 'native_' + reason}`;
      expect(cloudAccessDiagnostic(error)).toBe(code);
      expect(CLOUD_ACCESS_MESSAGES[code]).toContain('Скачивание для сверки —');
      expect(error.message).not.toMatch(/PRIVATE|https:|cloud_disk/);
      expect(JSON.stringify(error)).toBe('{}');
      expect(invoke).toHaveBeenCalledOnce();
    }
  );
  it.each([
    new Error('cloud_disk_connect PRIVATE_ACCESS'),
    { message: 'cloud_disk_connect' },
    'cloud_disk_connect PRIVATE_ACCESS',
    'cloud_disk_connect\n',
    'https://PRIVATE_URL',
    '__proto__'
  ])('does not interpret arbitrary native errors as diagnostic codes', async error => {
    expect(nativeCloudAccessDiagnostic(error, 'download_content')).toBeUndefined();
    const fetchImpl = createNativeDiskFetch({
      provider: 'yandex',
      invoke: async () => {
        throw error;
      }
    });
    const transport = createReadOnlyCloudTransport({ provider: 'yandex', accessToken: 'PRIVATE_ACCESS', fetchImpl });
    const failure = await transport.send(request).catch(e => e);
    expect(cloudAccessDiagnostic(failure)).toBe('download_content_transport_unavailable');
    expect(failure.message).not.toMatch(/PRIVATE|https:|cloud_disk/);
  });
  it('does not release a live IPC request after UI cancellation', async () => {
    let reject;
    const controller = new AbortController();
    const invoke = vi.fn(
      () =>
        new Promise((_, no) => {
          reject = no;
        })
    );
    const fetchImpl = createNativeDiskFetch({ provider: 'yandex', invoke });
    const init = {
      method: 'GET',
      headers: { Authorization: 'OAuth PRIVATE_ACCESS' },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    };
    const first = fetchImpl(request.url, init).catch(e => e);
    controller.abort();
    await expect(fetchImpl(request.url, { ...init, signal: new AbortController().signal })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
    reject('cloud_disk_timeout');
    await first;
  });
});
