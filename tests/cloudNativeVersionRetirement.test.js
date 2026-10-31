import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { encryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { createNativeVersionRetirement } from '../js/modules/cloudSync/providers/nativeVersionRetirement.js';
const id = () => generateSyncId(webcrypto);
async function fixture(provider) {
  const datasetId = id(),
    envelope = await encryptSnapshot({
      snapshot: { only: 'encrypted' },
      datasetId,
      versionId: id(),
      recoveryKey: generateRecoveryKey(webcrypto),
      cryptoSource: webcrypto
    }),
    invoke = vi.fn(async () => ({ status: 204, body: '', contentType: null }));
  return {
    envelope,
    invoke,
    retire: createNativeVersionRetirement({
      provider,
      invoke,
      accessToken: 'PRIVATE_TOKEN',
      datasetId,
      folderId: 'owned-folder',
      timeoutMs: 20
    }),
    args: {
      envelope,
      rootVersionId: id(),
      checkpointVersionId: id(),
      ...(provider === 'google' ? { fileId: 'owned-version' } : {})
    }
  };
}
describe.each(['google', 'yandex'])('%s: scoped native trash', provider => {
  it('sends only canonical encrypted bytes with dataset/root/checkpoint guard and never permanent deletion', async () => {
    const f = await fixture(provider);
    expect(await f.retire(f.args)).toEqual({ status: 'accepted' });
    const [command, { args }] = f.invoke.mock.calls[0];
    expect(command).toBe('cloud_disk_network');
    expect(args).toMatchObject({
      provider,
      operation: 'retire',
      rootVersionId: f.args.rootVersionId,
      checkpointVersionId: f.args.checkpointVersionId
    });
    expect(JSON.parse(args.body)).toEqual(f.envelope);
    expect(args.body).not.toContain('encrypted');
    expect(args).not.toHaveProperty('url');
    expect(args).not.toHaveProperty('permanently');
  });
  it('blocks root/checkpoint, foreign scope and extra arbitrary URL before invoke', async () => {
    const f = await fixture(provider);
    for (const patch of [
      { rootVersionId: f.envelope.versionId },
      { checkpointVersionId: f.envelope.versionId },
      { rootVersionId: f.args.checkpointVersionId },
      { envelope: { ...f.envelope, datasetId: id() } },
      { url: 'https://other.invalid' }
    ])
      expect((await f.retire({ ...f.args, ...patch })).status).not.toBe('accepted');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('timeouts and exceptions remain unknown, without retry', async () => {
    const f = await fixture(provider);
    f.invoke.mockImplementation(() => new Promise(() => {}));
    expect(await f.retire(f.args)).toEqual({ status: 'unknown' });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});
