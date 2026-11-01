// @ts-check
// Ephemeral only: no storage, IPC payload, logs or exported account metadata.
// Exact protected record bytes bind a token to its verified credential revision.
// All callers still read the protected store and verify account before disk work.
import { sha256 } from '@noble/hashes/sha2.js';
import { parseGoogleCredentialRecord, MAX_CREDENTIAL_RECORD_CHARS } from './oauthCredentialRecord.js';
const entries = new WeakMap();
const MAX_AGE = 5 * 60_000;
const fingerprint = record =>
  [...sha256(new TextEncoder().encode(record))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export function clearGoogleAccess(invoke) {
  const old = entries.get(invoke);
  if (old) clearTimeout(old.timer);
  entries.delete(invoke);
}
export function rememberGoogleAccess({ invoke, record, accessToken, expiresAt, now = Date.now() }) {
  clearGoogleAccess(invoke);
  const parsed = parseGoogleCredentialRecord(record);
  if (
    parsed.phase !== 'ready' ||
    typeof invoke !== 'function' ||
    typeof accessToken !== 'string' ||
    accessToken.length > 8192 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    expiresAt <= now + 5000
  )
    return;
  const until = Math.min(expiresAt - 5000, now + MAX_AGE);
  const entry = { recordFingerprint: fingerprint(record), accessToken, expiresAt, since: now, until, timer: null };
  entry.timer = setTimeout(() => {
    if (entries.get(invoke) === entry) entries.delete(invoke);
  }, until - now);
  entry.timer?.unref?.();
  entries.set(invoke, entry);
}
export function recalledGoogleAccess({ invoke, record, now = Date.now() }) {
  const entry = entries.get(invoke);
  if (!entry) return null;
  if (
    typeof record !== 'string' ||
    record.length > MAX_CREDENTIAL_RECORD_CHARS ||
    entry.recordFingerprint !== fingerprint(record) ||
    !Number.isSafeInteger(now) ||
    now < entry.since ||
    now >= entry.until
  ) {
    clearGoogleAccess(invoke);
    return null;
  }
  return { accessToken: entry.accessToken, expiresAt: entry.expiresAt };
}
