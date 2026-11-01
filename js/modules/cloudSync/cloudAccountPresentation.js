// @ts-check
// Personal display labels are session-only. This module MUST NOT be used by
// snapshots, durable logs or diagnostics. No guesses from accountKey/psuid.
import { copyOAuthAccountLabel } from './providers/oauthAccountLabel.js';
const providers = ['google', 'yandex'];
let generation = 0;
export function cloudAccountPresentationGeneration() {
  return generation;
}
const rows = new Map();
const listeners = new Set();
export function cloudAccountPresentation(provider) {
  return rows.get(provider) || Object.freeze({ status: 'unknown', label: null });
}
export function presentCloudAccount(provider, { status, label = null }) {
  if (
    !providers.includes(provider) ||
    !['unknown', 'empty', 'signed_out', 'ready', 'pending', 'blocked', 'unavailable'].includes(status)
  )
    return;
  let safe = null;
  try {
    safe = status === 'ready' ? copyOAuthAccountLabel(provider, label) : null;
  } catch {
    /* never show unvalidated labels */
  }
  rows.set(provider, Object.freeze({ status, label: safe }));
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* UI cannot change file outcomes */
    }
  }
}
export function clearCloudAccountPresentation() {
  generation++;
  for (const provider of providers) presentCloudAccount(provider, { status: 'unknown' });
}
export function subscribeCloudAccountPresentation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
