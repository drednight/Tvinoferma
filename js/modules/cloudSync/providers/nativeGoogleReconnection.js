// @ts-check
// Fresh browser OAuth only. NEVER retries the refresh token of an unknown attempt.
// Keeps the protected slot/account/client pin; CAS refuses any concurrent change.
import { object } from '../exportSchema.js';
import { generateSyncId } from '../envelope.js';
import {
  parseGoogleCredentialRecord,
  prepareGoogleCredentialRecord,
  serializeGoogleCredentialRecord
} from './oauthCredentialRecord.js';
import { createNativeGoogleCredentialStore } from './nativeCredentialStore.js';

export function createNativeGoogleReconnectInstaller({
  invoke,
  expected,
  cryptoSource = globalThis.crypto,
  timeoutMs = 25000
}) {
  const before = parseGoogleCredentialRecord(expected);
  const store = createNativeGoogleCredentialStore({
    slotId: before.slotId,
    clientId: before.clientId,
    accountKey: before.accountKey,
    invoke,
    timeoutMs
  });
  let spent = false,
    installation = null;
  return Object.freeze({
    async installIfAbsent(args) {
      if (spent) throw new Error('reconnect_spent');
      spent = true;
      const input = object(args, ['slotId', 'clientId', 'accountKey', 'record']);
      const fresh = parseGoogleCredentialRecord(input.record);
      if (
        fresh.phase !== 'ready' ||
        fresh.slotId !== input.slotId ||
        fresh.clientId !== input.clientId ||
        fresh.accountKey !== input.accountKey ||
        fresh.clientId !== before.clientId ||
        fresh.accountKey !== before.accountKey
      )
        throw new Error('reconnect_account_changed');
      const next = prepareGoogleCredentialRecord({
        slotId: before.slotId,
        clientId: before.clientId,
        accountKey: before.accountKey,
        revision: fresh.revision,
        refreshToken: fresh.refreshToken,
        refreshExpiresAt: fresh.refreshExpiresAt
      });
      // No write until fresh credentials, two identity checks and user consent
      // have already completed in the normal enrollment attempt.
      if ((await store.read()) !== expected) return 'occupied';
      let from = expected;
      if (before.phase === 'ready') {
        const revision = generateSyncId(cryptoSource),
          attemptId = generateSyncId(cryptoSource);
        if (new Set([before.slotId, before.revision, fresh.revision, revision, attemptId]).size !== 5)
          throw new Error('reconnect_invalid');
        from = serializeGoogleCredentialRecord({
          ...before,
          revision,
          attemptId,
          phase: 'pending',
          refreshToken: null,
          refreshExpiresAt: null
        });
        if ((await store.compareExchange(expected, from)) !== 'swapped') return 'occupied';
      }
      if ((await store.compareExchange(from, next)) !== 'swapped') return 'occupied';
      installation = { request: input.record, record: next };
      return 'installed';
    },
    async verifyInstallation(args) {
      if (!installation || args.record !== installation.request) return false;
      try {
        return (await store.read()) === installation.record;
      } finally {
        installation = null;
      }
    }
  });
}
