// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { inspectInitialCloudSend } from '../js/modules/cloudSync/inspectInitialCloudSend.js';
import { prepareYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';
import { prepareGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';

const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../js/modules/cloudSync/initialCloudSetup.js', () => ({ readLocalCloudPairingCode: mock.read }));
const id = () => webcrypto.randomUUID();
function fixture(provider = 'yandex') {
  const account = {
    slotId: id(),
    clientId:
      provider === 'google' ? '123456789-fake_client.apps.googleusercontent.com' : '0123456789abcdef0123456789abcdef',
    accountKey: 'FAKE_PRIVATE_ACCOUNT'
  };
  const fields = { ...account, revision: id() };
  let raw =
    provider === 'yandex'
      ? prepareYandexCredentialRecord({ ...fields, accessToken: 'FAKE_PRIVATE_TOKEN', expiresAt: 100000 })
      : prepareGoogleCredentialRecord({ ...fields, refreshToken: 'FAKE_PRIVATE_TOKEN', refreshExpiresAt: null });
  const invoke = vi.fn(async command => {
    if (command === 'cloud_credential_binding_read') return { status: 'ready', ...account };
    if (command === 'cloud_credential_read') return { status: 'ready', slotId: account.slotId, record: raw };
    throw new Error('FAKE_PRIVATE_UNEXPECTED_WRITE');
  });
  return { opts: { provider, invoke, now: () => 10000 }, invoke, setRaw: value => (raw = value) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.read.mockResolvedValue({ status: 'ready', pairingCode: 'FAKE_PRIVATE_CODE' });
});
describe('местная готовность: нет HTTP, refresh, записи, отправки или значений в результате', () => {
  it.each(['google', 'yandex'])('%s: проверяет доступ только чтением, не доказывает API', async provider => {
    const f = fixture(provider);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(await inspectInitialCloudSend(f.opts)).toEqual({ status: 'local_send_ready' });
    expect(f.invoke.mock.calls.every(([cmd]) => cmd.endsWith('_read'))).toBe(true);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
  it.each(['binding_missing_or_blocked', 'queue_blocked', 'FAKE_PRIVATE_UNKNOWN'])(
    'останавливается до чтения токена: %s',
    async status => {
      mock.read.mockResolvedValueOnce({ status });
      const f = fixture();
      const result = await inspectInitialCloudSend(f.opts);
      expect(result.status).toBe(status === 'FAKE_PRIVATE_UNKNOWN' ? 'probe_binding_unavailable' : status);
      expect(f.invoke).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('FAKE_PRIVATE');
    }
  );
  it('различает истёкший срок без refresh/удаления привязки', async () => {
    const f = fixture();
    expect(await inspectInitialCloudSend({ ...f.opts, now: () => 100000 })).toEqual({ status: 'login_required' });
    expect(f.invoke.mock.calls.every(([cmd]) => cmd.endsWith('_read'))).toBe(true);
  });
  it('истечение во время повторного чтения тоже не выдаёт готовность', async () => {
    const f = fixture();
    expect(
      await inspectInitialCloudSend({ ...f.opts, now: vi.fn().mockReturnValueOnce(10000).mockReturnValueOnce(100000) })
    ).toEqual({ status: 'login_required' });
  });
  it('не выводит некорректный credential JSON, путь или token', async () => {
    const f = fixture();
    f.setRaw('{FAKE_PRIVATE_TOKEN');
    expect(await inspectInitialCloudSend(f.opts)).toEqual({ status: 'probe_credential_record_invalid' });
    f.invoke.mockRejectedValueOnce(new Error('FAKE_PRIVATE_PATH'));
    expect(await inspectInitialCloudSend(f.opts)).toEqual({ status: 'probe_credential_read_unavailable' });
  });
  it('не выдаёт за готовность смену привязки во время проверки', async () => {
    const f = fixture();
    mock.read
      .mockResolvedValueOnce({ status: 'ready', pairingCode: 'OLD' })
      .mockResolvedValueOnce({ status: 'ready', pairingCode: 'NEW' });
    expect(await inspectInitialCloudSend(f.opts)).toEqual({ status: 'local_binding_changed' });
  });
  it('таймаут только чтения не становится разрешением или записью', async () => {
    const f = fixture();
    const original = f.invoke.getMockImplementation();
    f.invoke.mockImplementation(command =>
      command === 'cloud_credential_read' ? new Promise(() => {}) : original(command)
    );
    expect(await inspectInitialCloudSend({ ...f.opts, timeoutMs: 20 })).toEqual({
      status: 'probe_credential_read_unavailable'
    });
  });
});
