import { describe, it, expect } from 'vitest';
import {
  readPendingConservativeMerge,
  mergeRetainsAppliedIntent
} from '../js/modules/cloudSync/pendingConservativeMerge.js';
const id = n =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const pin = n => ({ versionId: id(n), sha256: 'a'.repeat(64) });
function marker() {
  return {
    version: 5,
    operationId: id(1),
    provider: 'yandex',
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
    resolution: {
      reviewHash: 'd'.repeat(64),
      cloudRecords: [],
      cloudSettings: [],
      cloudFinanceSettings: false,
      plannerCopies: [{ id: id(7), newId: id(8) }]
    },
    appliedIntentHash: null,
    privateCarryConfirmed: false
  };
}
const read = m => readPendingConservativeMerge({ cloudSyncPendingMerge: m });
describe('v5 сохранённого решения о новой копии задачи', () => {
  it.each([false, true])('восстанавливает тот же новый ID; privateCarry=%s', carry => {
    const m = marker();
    m.privateCarryConfirmed = carry;
    expect(read(m)).toEqual(m);
    expect(mergeRetainsAppliedIntent(read(m))).toBe(false);
    const result = read(m);
    result.resolution.plannerCopies[0].newId = id(9);
    expect(m.resolution.plannerCopies[0].newId).toBe(id(8));
  });
  it('не подменяет старые форматы', () => {
    for (const version of [1, 2, 3, 4]) {
      const m = marker();
      m.version = version;
      expect(() => read(m)).toThrow();
    }
  });
  it.each(['none', 'null', 'empty', 'implicitCarry', 'hiddenSecret'])('отклоняет повреждённое решение %s', kind => {
    const m = marker();
    if (kind === 'none') delete m.resolution.plannerCopies;
    if (kind === 'null') m.resolution = null;
    if (kind === 'empty') m.resolution.plannerCopies = [];
    if (kind === 'implicitCarry') delete m.privateCarryConfirmed;
    if (kind === 'hiddenSecret') m.resolution.plannerCopies[0].secret = 'secret';
    expect(() => read(m)).toThrow();
  });
  it('проверяет отдельный хеш намерения после выборочного применения', () => {
    const m = marker();
    m.appliedIntentHash = 'e'.repeat(64);
    expect(() => read(m)).toThrow();
    m.pendingPin = pin(6);
    m.pendingPhase = 'prepared';
    expect(mergeRetainsAppliedIntent(read(m))).toBe(true);
  });
});
