import { describe, it, expect } from 'vitest';
import {
  readPendingConservativeMerge,
  mergeRetainsAppliedIntent
} from '../js/modules/cloudSync/pendingConservativeMerge.js';
const id = n =>
  `${n.toString().repeat(8)}-${n.toString().repeat(4)}-4${n.toString().repeat(3)}-8${n.toString().repeat(3)}-${n.toString().repeat(12)}`;
const pin = n => ({ versionId: id(n), sha256: 'a'.repeat(64) });
function marker() {
  return {
    version: 4,
    operationId: id(1),
    provider: 'google',
    datasetId: id(2),
    basePin: pin(3),
    targetPin: pin(4),
    previousBase: null,
    queueRevisionId: id(5),
    pendingPin: null,
    pendingPhase: null,
    retainedIntents: [],
    settingsSelections: [],
    localHash: 'b'.repeat(64),
    mergedHash: 'c'.repeat(64),
    resolution: null,
    appliedIntentHash: null,
    privateCarryConfirmed: true
  };
}
const read = m => readPendingConservativeMerge({ cloudSyncPendingMerge: m });
describe('v4 сохранённого намерения ciphertext-only', () => {
  it('сохраняет точный pin, явное подтверждение и не требует фиктивного apply-хеша', () => {
    const m = marker();
    expect(read(m)).toEqual(m);
    expect(mergeRetainsAppliedIntent(read(m))).toBe(false);
    const copy = read(m);
    copy.targetPin.sha256 = 'd'.repeat(64);
    expect(m.targetPin.sha256).toBe('a'.repeat(64));
  });
  it.each([false, null, 'true', undefined])('отклоняет неявное разрешение %s', value => {
    const m = marker();
    m.privateCarryConfirmed = value;
    expect(() => read(m)).toThrow();
  });
  it('проверяет отдельный источник выборочного удаления, если он присутствует', () => {
    const m = marker();
    m.appliedIntentHash = 'e'.repeat(64);
    expect(() => read(m)).toThrow();
    m.pendingPin = pin(6);
    m.pendingPhase = 'prepared';
    expect(mergeRetainsAppliedIntent(read(m))).toBe(true);
    m.appliedIntentHash = 'broken';
    expect(() => read(m)).toThrow();
  });
  it('не разрешает скрытые поля и не меняет старые форматы', () => {
    const m = marker();
    m.contacts = { password: 'secret' };
    expect(() => read(m)).toThrow();
    delete m.contacts;
    delete m.privateCarryConfirmed;
    m.version = 3;
    expect(() => read(m)).toThrow();
    m.appliedIntentHash = 'e'.repeat(64);
    m.pendingPin = pin(6);
    m.pendingPhase = 'queued';
    expect(mergeRetainsAppliedIntent(read(m))).toBe(true);
  });
});
