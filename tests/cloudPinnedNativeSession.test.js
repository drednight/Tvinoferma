import { beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { createKeyStateRecord } from '../js/modules/cloudSync/keyStateRecord.js';
import { createDatasetBindingRecord } from '../js/modules/cloudSync/datasetBindingRecord.js';
import { openPinnedNativeCloudSession } from '../js/modules/cloudSync/providers/pinnedNativeCloudSession.js';
import { prepareGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { prepareYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const accountSlotId = '01234567-89ab-4cde-8f01-23456789abcd';
const revision = '11234567-89ab-4cde-8f01-23456789abcd';
const keySlotId = '21234567-89ab-4cde-8f01-23456789abcd';
const keyRevision = '31234567-89ab-4cde-8f01-23456789abcd';
const datasetId = '41234567-89ab-4cde-8f01-23456789abcd';
const rootId = '61234567-89ab-4cde-8f01-23456789abcd';
const clients = { google: 'fake-client.apps.googleusercontent.com', yandex: '0123456789abcdef' };
const accountKey = 'PRIVATE_ACCOUNT';
const access = 'PRIVATE_ACCESS';
const refresh = 'PRIVATE_REFRESH';
let keys, keyRaw;

beforeAll(async () => {
  keys = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: 'Синтетический пароль только для теста 123!' },
    backup: { kind: 'generated' },
    cryptoSource: webcrypto
  });
  keyRaw = (
    await createKeyStateRecord(
      {
        slotId: keySlotId,
        revision: keyRevision,
        datasetId,
        bundle: keys.bundle,
        pin: keys.pin,
        dataKey: keys.dataKey
      },
      webcrypto
    )
  ).raw;
}, 30_000);

function fixture(provider) {
  const account = { slotId: accountSlotId, clientId: clients[provider], accountKey };
  let credential =
    provider === 'google'
      ? prepareGoogleCredentialRecord({ ...account, revision, refreshToken: refresh, refreshExpiresAt: null })
      : prepareYandexCredentialRecord({ ...account, revision, accessToken: access, expiresAt: 3_700_000 });
  let pin = createDatasetBindingRecord({
    provider,
    accountSlotId,
    keySlotId,
    datasetId,
    keyPin: keys.pin,
    rootPin: { versionId: rootId, sha256: 'b'.repeat(64) },
    ...(provider === 'google' ? { folderId: 'FAKE_FOLDER' } : {})
  }).raw;
  let key = keyRaw;
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_dataset_binding_read')
      return pin === null ? { status: 'empty' } : { status: 'ready', record: pin };
    if (command === 'cloud_key_state_read') return { status: 'ready', slotId: keySlotId, record: key };
    if (command === 'cloud_credential_binding_read') return { status: 'ready', ...account };
    if (command === 'cloud_credential_read') return { status: 'ready', slotId: accountSlotId, record: credential };
    if (command === 'cloud_credential_compare_exchange') {
      if (credential !== args.expected) return { status: 'mismatch' };
      credential = args.next;
      return { status: 'swapped' };
    }
    if (command === 'cloud_oauth_network' && args.operation === 'refresh') {
      if (args.refreshClaim.expected !== credential) throw new Error('PRIVATE stale claim');
      credential = args.refreshClaim.pending;
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: OAUTH_PROVIDERS.google.scope
        })
      };
    }
    if (command === 'cloud_disk_network') {
      if (args.args.operation === 'identity')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            provider === 'google'
              ? { user: { permissionId: accountKey } }
              : { client_id: clients.yandex, psuid: accountKey }
          )
        };
      if (args.args.operation === 'list')
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            provider === 'google'
              ? { files: [], incompleteSearch: false }
              : { type: 'dir', _embedded: { offset: args.args.offset, limit: args.args.limit, total: 0, items: [] } }
          )
        };
    }
    throw new Error('PRIVATE unknown call');
  });
  return {
    invoke,
    setPin(value) {
      pin = value;
    },
    setKey(value) {
      key = value;
    },
    pin: () => pin,
    options: { provider, invoke, cryptoSource: webcrypto, now: () => 100_000 }
  };
}
function diskCalls(f) {
  return f.invoke.mock.calls.filter(([command]) => command === 'cloud_disk_network').length;
}
function noSecrets(value) {
  const raw = JSON.stringify(value);
  for (const privateValue of [accountKey, access, refresh, keys.dataKey, 'PRIVATE unknown'])
    expect(raw).not.toContain(privateValue);
}

describe.each(['google', 'yandex'])('%s: открытие с доверенным локальным pin (fake IPC)', provider => {
  it('перечитывает привязку и доказательство ключа перед сетью, не выдаёт секрет', async () => {
    const f = fixture(provider);
    const opened = await openPinnedNativeCloudSession(f.options);
    expect(opened.status).toBe('opened');
    expect(opened.datasetId).toBe(datasetId);
    expect(opened.keyPin).toEqual(keys.pin);
    expect(opened.rootPin.versionId).toBe(rootId);
    noSecrets(opened);
    expect(await opened.session.listWithDates()).toEqual({ status: 'listed', versions: [] });
    opened.session.dispose();
    expect(await opened.session.listWithDates()).toEqual({ status: 'account_unavailable' });
  });
  it('изменение pin или повреждение ключа до следующего действия закрывает сеть', async () => {
    for (const change of ['pin', 'key']) {
      const f = fixture(provider);
      const opened = await openPinnedNativeCloudSession(f.options);
      expect(opened.status).toBe('opened');
      const before = diskCalls(f);
      if (change === 'pin') f.setPin(f.pin().replace('b'.repeat(64), 'c'.repeat(64)));
      else f.setKey(keyRaw.replace(keys.dataKey, `TF1-${'A'.repeat(43)}`));
      expect(await opened.session.upload({ envelope: {} })).toEqual({ status: 'account_unavailable' });
      expect(diskCalls(f)).toBe(before);
    }
  });
  it('не открывается при отсутствии pin или его несовпадении с ключом/аккаунтом', async () => {
    for (const change of ['empty', 'keySlot', 'keyPin', 'accountSlot']) {
      const f = fixture(provider);
      if (change === 'empty') f.setPin(null);
      if (change === 'keySlot') f.setPin(f.pin().replace(keySlotId, rootId));
      if (change === 'keyPin') f.setPin(f.pin().replace(keys.pin.sha256, 'c'.repeat(64)));
      if (change === 'accountSlot') f.setPin(f.pin().replace(accountSlotId, rootId));
      const result = await openPinnedNativeCloudSession(f.options);
      expect(result).toEqual({ status: change === 'empty' ? 'binding_missing' : 'binding_blocked' });
      expect(f.invoke.mock.calls.some(([cmd]) => cmd === 'cloud_oauth_network' || cmd === 'cloud_disk_network')).toBe(
        false
      );
    }
  });
  it('не доверяет только синтаксису native-записи: неверное доказательство ключа блокирует до сети', async () => {
    const f = fixture(provider);
    f.setKey(keyRaw.replace(keys.dataKey, `TF1-${'A'.repeat(43)}`));
    expect(await openPinnedNativeCloudSession(f.options)).toEqual({ status: 'binding_unavailable' });
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === 'cloud_oauth_network' || cmd === 'cloud_disk_network')).toBe(
      false
    );
  });
});
