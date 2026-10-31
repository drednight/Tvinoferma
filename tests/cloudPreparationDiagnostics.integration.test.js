// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'tvinoferma_state_v1';
async function fixture(extra = {}) {
  vi.resetModules();
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  const { state, normalizeState } = await import('../js/core/state.js');
  const storage = await import('../js/core/storage.js');
  const { stageSyncIdentities } = await import('../js/modules/cloudSync/commitSyncIdentities.js');
  const { preparationDiagnosticCode } = await import('../js/modules/cloudSync/preparationDiagnostics.js');
  Object.assign(
    state,
    normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'hero', nick: 'FAKE_PRIVATE_NICK', contacts: { password: 'FAKE_PASSWORD' } }],
      settings: { security: { useVault: false } },
      ...extra
    })
  );
  return { state, normalizeState, storage, stageSyncIdentities, preparationDiagnosticCode };
}
function failure(f) {
  const before = JSON.stringify(f.state, (k, v) => (k === 'ui' ? undefined : v));
  const disk = localStorage.getItem(KEY);
  let error;
  try {
    f.stageSyncIdentities();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(JSON.stringify(f.state, (k, v) => (k === 'ui' ? undefined : v))).toBe(before);
  expect(localStorage.getItem(KEY)).toBe(disk);
  const code = f.preparationDiagnosticCode(error);
  expect(code).not.toMatch(/FAKE|PRIVATE|PASSWORD|hero/);
  return code;
}
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('безопасная диагностика всей подготовки ID', () => {
  it.each([
    [
      'sync_id',
      f => {
        f.state.characters[0].syncId = 'FAKE_SECRET_BAD_ID';
      },
      'ids.characters/sync_id'
    ],
    [
      'duplicate local',
      f => {
        f.state.characters.push({ ...f.state.characters[0] });
      },
      'ids.characters/duplicate_local_id'
    ],
    [
      'duplicate sync',
      f => {
        const row = f.state.characters[0];
        row.syncId = '11111111-1111-4111-8111-111111111111';
        f.state.characters.push({ ...row, id: 'other' });
      },
      'ids.characters/duplicate_sync_id'
    ],
    [
      'roundtrip differences',
      f => {
        f.state.finance.settings.monthAdjust = { '2026-10': { gold: 0 } };
      },
      'roundtrip.finance/reload_changes'
    ],
    [
      'runtime undefined',
      f => {
        f.state.characters[0].lastCoinUpdate = undefined;
      },
      'snapshot.characters/runtime_value'
    ],
    [
      'unknown stat',
      f => {
        f.state.characters[0].stats.FAKE_PASSWORD = 7;
      },
      'public.characters.stats/unknown_field'
    ],
    [
      'missing stat',
      f => {
        delete f.state.characters[0].stats.hp;
      },
      'public.characters.stats/missing_field'
    ],
    [
      'unknown history',
      f => {
        f.state.characters[0].coinHistory = [{ delta: 1, FAKE_PASSWORD: 'SECRET' }];
      },
      'public.characters.coinHistory/unknown_field'
    ],
    [
      'unknown root',
      f => {
        f.state.FAKE_PRIVATE_FIELD = true;
      },
      'public.root/unknown_field'
    ],
    [
      'missing financial reference',
      f => {
        f.state.finance = f.normalizeState({
          schemaVersion: 10,
          finance: {
            operations: [{ id: 'op', amount: 2, source: 'shop', ref: 'FAKE_PRIVATE_DELETED_ITEM' }]
          }
        }).finance;
      },
      'public.finance.operations/reference'
    ]
  ])('%s: фиксированный код, без изменений базы', async (_name, change, expected) => {
    const f = await fixture();
    change(f);
    await f.storage.saveNow();
    expect(failure(f)).toBe(`setup/identities/${expected}`);
  });

  it('не пропускает проверку схемы, если ID уже были назначены', async () => {
    const f = await fixture();
    await f.storage.saveNow();
    const staged = f.stageSyncIdentities();
    expect((await staged.operation.commit({ confirmed: true })).status).toBe('applied');
    f.state.characters[0].stats.FAKE_PRIVATE_FIELD = 1;
    expect(failure(f)).toBe('setup/identities/public.characters.stats/unknown_field');
  });

  it('все нормальные разделы заполненной базы проходят реальный save/backup/commit/reload', async () => {
    const f = await fixture({
      archivedCharacters: [{ id: 'archived-hero', nick: 'Архив' }],
      parties: [{ id: 'party', name: 'Пати', order: 1 }],
      archivedParties: [
        { id: 'old-party', name: 'Старый архив', memberLinks: [{ characterId: 'archived-hero', isMain: true }] }
      ],
      marathons: [
        {
          schemaVersion: 2,
          kind: 'single',
          id: 'marathon',
          title: 'Марафон',
          participantIds: ['hero'],
          assignments: { hero: ['task'] },
          tasks: [{ id: 'task', title: 'Задание', rewards: [{ id: 'reward', threshold: 1 }] }],
          bonuses: [{ id: 'bonus', text: 'Бонус' }]
        }
      ],
      marathonTemplates: [{ id: 'template', name: 'Шаблон', tasks: [{ title: 'Задание' }] }],
      plannerEntries: [{ id: 'calendar', title: 'Дело' }],
      finance: {
        operations: [{ id: 'op', amount: 2, source: 'shop', ref: 'item' }],
        shopItems: [{ id: 'item', name: 'Товар', price: 2, qty: 1 }],
        loans: [{ id: 'loan', who: 'Заёмщик', principal: 10, payments: [{ id: 'payment', amount: 1 }] }]
      }
    });
    await f.storage.saveNow();
    const before = localStorage.getItem(KEY);
    const staged = f.stageSyncIdentities();
    const result = await staged.operation.commit({ confirmed: true });
    expect(result.status).toBe('applied');
    expect(localStorage.getItem(result.backup)).toBe(before);
    const { captureInitialCloudBaseline } = await import('../js/modules/cloudSync/initialCloudBaseline.js');
    const baseline = await captureInitialCloudBaseline();
    expect(baseline.status).toBe('ready');
    const snapshot = baseline.getPublicSnapshot();
    expect(snapshot.sections.parties.records.find(p => p.archived).fields.order).toBe(null);
    expect(JSON.stringify(snapshot)).not.toContain('FAKE_PASSWORD');
    const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
    const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
    const { prepareFullPublicSnapshotReplace } = await import('../js/modules/cloudSync/applyPublicSnapshot.js');
    const { ui: _ui, ...empty } = f.normalizeState({ schemaVersion: 10 });
    const target = planSyncIdentities({ snapshot: empty }).snapshot;
    const candidate = prepareFullPublicSnapshotReplace({
      localState: target,
      cloudSnapshot: snapshot
    }).candidateState();
    expect(candidate.archivedParties[0].order).toBe(null);
    expect(buildPublicSnapshot(candidate)).toEqual(snapshot);
    baseline.close();
    Object.assign(f.state, f.normalizeState(JSON.parse(localStorage.getItem(KEY))));
    await f.storage.saveNow();
    expect(f.stageSyncIdentities().status).toBe('already_assigned');
  });

  it.each([false, true])('кнопка проверки без пароля/OAuth/save/backup/commit: ошибка=%s', async damaged => {
    const f = await fixture();
    if (damaged) f.state.characters[0].syncId = 'FAKE_PRIVATE_BAD_ID';
    const before = JSON.stringify(f.state);
    const parsed = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
    const { bindInitialCloudPanel } = await import('../js/modules/cloudSync/ui/initialCloudPanel.js');
    const save = vi.spyOn(f.storage, 'saveNow');
    const load = vi.spyOn(f.storage, 'loadData');
    const backup = vi.spyOn(f.storage, 'beginGuardedMigration');
    const native = vi.fn();
    const setup = vi.fn();
    bindInitialCloudPanel({ desktop: true, loadNative: native, makeSetup: setup });
    document.getElementById('cloud-setup-check-data').click();
    await vi.waitFor(() => expect(document.getElementById('cloud-setup-check-data').disabled).toBe(false));
    const status = document.getElementById('cloud-setup-status').textContent;
    expect(status).toContain(damaged ? 'setup/identities/ids.characters/sync_id' : 'Структура данных проверена');
    expect(status).not.toContain('FAKE');
    expect(save).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(null);
    expect(JSON.stringify(f.state)).toBe(before);
  });

  it('внешние message/code/cause/getter не превращаются в диагностику', async () => {
    const f = await fixture();
    const getter = vi.fn(() => {
      throw new Error('FAKE_PASSWORD');
    });
    const forged = Object.defineProperties(
      {},
      { code: { get: getter }, message: { get: getter }, cause: { get: getter } }
    );
    expect(f.preparationDiagnosticCode(forged)).toBe('setup/identities/unknown');
    expect(f.preparationDiagnosticCode(new Error('FAKE_PASSWORD'))).toBe('setup/identities/unknown');
    expect(getter).not.toHaveBeenCalled();
  });
});
