import { describe, expect, it } from 'vitest';
import { isSyncId } from '../js/modules/cloudSync/envelope.js';
import { createPairingCode } from '../js/modules/cloudSync/pairingCode.js';
import { createDatasetBindingRecord } from '../js/modules/cloudSync/datasetBindingRecord.js';
import { validGoogleId } from '../js/modules/cloudSync/providers/common.js';
import {
  validCredentialId,
  prepareGoogleCredentialRecord
} from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import {
  validOAuthAccountKey,
  validOAuthClientId,
  validOAuthRedirect
} from '../js/modules/cloudSync/providers/oauthCommon.js';

const id = '01234567-89ab-4cde-8f01-23456789abcd';
const second = '11234567-89ab-4cde-8f01-23456789abcd';
const hash = 'a'.repeat(64);

describe('строгие окончания идентификаторов и отпечатков', () => {
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('отклоняет завершающий управляющий символ %j', suffix => {
    expect(isSyncId(id + suffix)).toBe(false);
    expect(validCredentialId(id + suffix)).toBe(false);
    expect(validGoogleId('valid-folder' + suffix)).toBe(false);
    expect(validOAuthAccountKey('private-account' + suffix)).toBe(false);
    expect(validOAuthClientId('google', 'fake-client.apps.googleusercontent.com' + suffix)).toBe(false);
    expect(validOAuthClientId('yandex', '0123456789abcdef' + suffix)).toBe(false);
    expect(validOAuthRedirect('http://127.0.0.1:37181/oauth/cloud/callback' + suffix)).toBe(false);
    expect(() =>
      createPairingCode({
        datasetId: id,
        keyPin: { bundleId: id, sha256: hash + suffix },
        rootPin: { versionId: id, sha256: hash }
      })
    ).toThrow();
    expect(() =>
      createDatasetBindingRecord({
        provider: 'yandex',
        accountSlotId: id,
        keySlotId: second,
        datasetId: id,
        keyPin: { bundleId: id, sha256: hash },
        rootPin: { versionId: second, sha256: hash + suffix }
      })
    ).toThrow();
    expect(() =>
      prepareGoogleCredentialRecord({
        slotId: id,
        clientId: 'fake-client.apps.googleusercontent.com',
        accountKey: 'private-account',
        revision: second,
        refreshToken: 'fake-token' + suffix,
        refreshExpiresAt: null
      })
    ).toThrow();
  });
  it('отвергает не-v4 ID в локальном pin, даже если это допустимый синтаксис общего sync ID', () => {
    const old = id.replace('-4cde-', '-1cde-');
    expect(isSyncId(old)).toBe(true);
    expect(validCredentialId(old)).toBe(false);
    expect(() =>
      createDatasetBindingRecord({
        provider: 'yandex',
        accountSlotId: id,
        keySlotId: second,
        datasetId: old,
        keyPin: { bundleId: id, sha256: hash },
        rootPin: { versionId: second, sha256: hash }
      })
    ).toThrow();
  });
});
