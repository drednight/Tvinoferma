import { preparationDiagnosticCode } from '../js/modules/cloudSync/preparationDiagnostics.js';
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { prepareFullPublicSnapshotReplace } from '../js/modules/cloudSync/applyPublicSnapshot.js';
it('roundtrips the full UI fixture into an independent PC', () => {
  const ready = raw => {
    const { ui, ...s } = normalizeState(raw);
    return planSyncIdentities({ snapshot: s, cryptoSource: webcrypto }).snapshot;
  };
  const source = ready(JSON.parse(readFileSync('tests/fixtures/ui-demo-state.json', 'utf8')));
  source.characters.forEach(c => {
    c.coinHistory = [];
    c.statsHistory = [];
  });
  const target = buildPublicSnapshot(source, {
    settingsSelections: ['appearance', 'navigation', 'planner', 'eventReminders']
  });
  expect(() =>
    prepareFullPublicSnapshotReplace({ localState: ready({}), cloudSnapshot: target, cryptoSource: webcrypto })
  ).not.toThrow();
});

const ready = raw => {
  const { ui, ...snapshot } = normalizeState(raw);
  return planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
};
it('reproduces a live backdated operation / party reorder and preserves every record through reload', () => {
  const source = ready({
    parties: [
      { id: 'p1', name: 'Первая', order: 1 },
      { id: 'p2', name: 'Вторая', order: 2 }
    ],
    finance: {
      operations: [
        { id: 'o1', date: '2026-11-01', amount: 10 },
        { id: 'o2', date: '2026-10-01', amount: 20 }
      ],
      shopItems: [
        { id: 'i1', name: 'Новый', date: '2026-11-01', qty: 1, price: 10 },
        { id: 'i2', name: 'Ранний', date: '2026-10-01', qty: 2, price: 5 }
      ]
    }
  });
  // Editing does not necessarily sort the live arrays as reload does.
  source.parties.reverse();
  source.finance.operations.reverse();
  source.finance.shopItems.reverse();
  const target = buildPublicSnapshot(source),
    pinned = JSON.stringify(target);
  const prepared = prepareFullPublicSnapshotReplace({
    localState: ready({}),
    cloudSnapshot: target,
    cryptoSource: webcrypto
  });
  expect(prepared.orderingNormalized).toEqual(expect.arrayContaining(['parties', 'finance']));
  expect(JSON.stringify(target)).toBe(pinned);
  const candidate = prepared.candidateState();
  const { ui, ...reloaded } = normalizeState(candidate);
  expect(buildPublicSnapshot(candidate)).toEqual(buildPublicSnapshot(reloaded));
  const actual = buildPublicSnapshot(reloaded);
  for (const section of ['characters', 'parties', 'marathons', 'planner', 'finance']) {
    const sorted = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(actual.sections[section].records)).toEqual(sorted(target.sections[section].records));
  }
  expect(candidate.finance.operations.map(o => o.date)).toEqual(['2026-11-01', '2026-10-01']);
});
it('still rejects a real field change on reload, with a fixed section-only diagnostic and no write', () => {
  const source = ready({ plannerEntries: [{ id: 'p', title: 'Задача', date: '2026-11-01' }] });
  source.plannerEntries[0].title = '  PRIVATE_TITLE  ';
  const target = buildPublicSnapshot(source),
    pinned = JSON.stringify(source);
  let error;
  try {
    prepareFullPublicSnapshotReplace({ localState: ready({}), cloudSnapshot: target, cryptoSource: webcrypto });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(preparationDiagnosticCode(error)).toBe('setup/identities/planner/reload_changes');
  expect(String(error)).not.toContain('PRIVATE_TITLE');
  expect(JSON.stringify(source)).toBe(pinned);
});
