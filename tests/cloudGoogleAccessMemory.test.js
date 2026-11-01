import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rememberGoogleAccess,
  recalledGoogleAccess,
  clearGoogleAccess
} from '../js/modules/cloudSync/providers/googleAccessMemory.js';
import {
  prepareGoogleCredentialRecord,
  serializeGoogleCredentialRecord,
  parseGoogleCredentialRecord
} from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
const record = prepareGoogleCredentialRecord({
  slotId: '01234567-89ab-4cde-8f01-23456789abcd',
  revision: '11234567-89ab-4cde-8f01-23456789abcd',
  clientId: 'fake.apps.googleusercontent.com',
  accountKey: 'FAKE_ACCOUNT',
  refreshToken: 'FAKE_REFRESH',
  refreshExpiresAt: null
});
afterEach(() => vi.useRealTimers());
function fixture() {
  const invoke = vi.fn();
  rememberGoogleAccess({ invoke, record, accessToken: 'FAKE_ACCESS', expiresAt: 4_000_000, now: 1_000_000 });
  return { invoke, recall: (extra = {}) => recalledGoogleAccess({ invoke, record, now: 1_001_000, ...extra }) };
}
describe('short-lived verified Google access, never a replacement for store/account checks', () => {
  it('is scoped to the exact invoke instance and protected record bytes', () => {
    const f = fixture();
    expect(f.recall()?.accessToken).toBe('FAKE_ACCESS');
    expect(f.recall({ invoke: vi.fn() })).toBeNull();
    expect(f.recall({ record: record + ' ' })).toBeNull();
    expect(f.recall()).toBeNull();
  });
  it.each([999_999, 1_300_000, NaN])('expires or invalidates on clock %s', now => {
    const f = fixture();
    expect(f.recall({ now })).toBeNull();
    expect(f.recall()).toBeNull();
  });
  it('clears at the timer deadline without another access', () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.advanceTimersByTime(300_000);
    expect(f.recall()).toBeNull();
  });
  it('never remembers pending credentials or an expired access', () => {
    const f = fixture();
    const pending = serializeGoogleCredentialRecord({
      ...parseGoogleCredentialRecord(record),
      phase: 'pending',
      revision: '21234567-89ab-4cde-8f01-23456789abcd',
      attemptId: '31234567-89ab-4cde-8f01-23456789abcd',
      refreshToken: null,
      refreshExpiresAt: null
    });
    rememberGoogleAccess({
      invoke: f.invoke,
      record: pending,
      accessToken: 'FAKE_ACCESS',
      expiresAt: 4_000_000,
      now: 1_000_000
    });
    expect(f.recall()).toBeNull();
    rememberGoogleAccess({
      invoke: f.invoke,
      record,
      accessToken: 'FAKE_ACCESS',
      expiresAt: 1_000_001,
      now: 1_000_000
    });
    expect(f.recall()).toBeNull();
  });
  it('supports explicit eviction', () => {
    const f = fixture();
    clearGoogleAccess(f.invoke);
    expect(f.recall()).toBeNull();
  });
});
