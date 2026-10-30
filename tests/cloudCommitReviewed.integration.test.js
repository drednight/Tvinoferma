import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const KEY = 'tvinoferma_state_v1';
async function fixture() {
  vi.resetModules();
  localStorage.clear();
  const { state, normalizeState } = await import('../js/core/state.js');
  const storage = await import('../js/core/storage.js');
  const { localStorageAdapter: adapter } = await import('../js/core/storageAdapters/localStorageAdapter.js');
  const { planSyncIdentities } = await import('../js/modules/cloudSync/identityMigration.js');
  const { buildPublicSnapshot } = await import('../js/modules/cloudSync/publicSnapshot.js');
  const { sealHistoryVersion } = await import('../js/modules/cloudSync/history.js');
  const { generateSyncId, generateRecoveryKey } = await import('../js/modules/cloudSync/envelope.js');
  const { prepareCloudReview } = await import('../js/modules/cloudSync/cloudReview.js');
  const { stageReviewedCloudApply } = await import('../js/modules/cloudSync/commitReviewedCloud.js');
  Object.assign(
    state,
    normalizeState({
      schemaVersion: 10,
      characters: [
        {
          id: 'local-hero',
          nick: 'Герой',
          notes: 'Локально',
          contacts: { password: 'PRIVATE_PASSWORD' },
          launch: { gcPath: '/private/local' }
        }
      ],
      plannerEntries: [{ id: 'local-task', title: 'Локальная задача', date: '2026-10-28', kind: 'task' }],
      settings: { security: { useVault: false } }
    })
  );
  const { ui, ...withoutUi } = state;
  Object.assign(state, planSyncIdentities({ snapshot: withoutUi, cryptoSource: webcrypto }).snapshot);
  await storage.saveNow();
  const oldRaw = localStorage.getItem(KEY);
  const remote = structuredClone(withoutUi);
  // planSyncIdentities returns a detached snapshot; take the assigned current state instead.
  const { ui: _ui, ...localSnapshot } = state;
  const local = structuredClone(localSnapshot);
  remote.characters = structuredClone(local.characters);
  remote.plannerEntries = structuredClone(local.plannerEntries);
  remote.characters[0].notes = 'Облачная заметка';
  remote.plannerEntries[0].title = 'Облачная задача';
  const localPublic = buildPublicSnapshot(local);
  const cloud = buildPublicSnapshot(remote);
  const datasetId = generateSyncId(webcrypto);
  const dataKey = generateRecoveryKey(webcrypto);
  const root = await sealHistoryVersion({
    publicSnapshot: cloud,
    parent: null,
    recoveryKey: dataKey,
    datasetId,
    versionId: generateSyncId(webcrypto),
    cryptoSource: webcrypto
  });
  const session = {
    listWithDates: async () => ({
      status: 'listed',
      versions: [{ versionId: root.pin.versionId, modifiedAt: '2026-10-29T10:00:00Z' }]
    }),
    read: async () => ({ status: 'found', envelope: root.envelope })
  };
  const review = await prepareCloudReview({
    provider: 'yandex',
    session,
    datasetId,
    dataKey,
    rootPin: root.pin,
    knownPins: [root.pin],
    localSnapshot: localPublic,
    localSavedAt: null,
    cryptoSource: webcrypto
  });
  const selection = [
    { section: 'characters', id: local.characters[0].syncId },
    { section: 'planner', id: local.plannerEntries[0].syncId }
  ];
  const stage = () =>
    stageReviewedCloudApply({ review, pin: root.pin, selectedRecords: selection, cryptoSource: webcrypto });
  return { state, storage, adapter, oldRaw, review, root, selection, stage, stageReviewedCloudApply };
}

beforeEach(() => vi.restoreAllMocks());

describe('применение проверенного снимка с реальным browser storage', () => {
  it('по подтверждению сохраняет точный backup, выбранные изменения и локальные секреты', async () => {
    const f = await fixture();
    const ui = f.state.ui;
    ui.activeTab = 'settings';
    const operation = f.stage();
    expect(await operation.commit({ confirmed: false })).toEqual({ status: 'confirmation_required' });
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    const result = await operation.commit({ confirmed: true });
    expect(result).toMatchObject({ status: 'applied', selectedCount: 2 });
    expect(localStorage.getItem(result.backup)).toBe(f.oldRaw);
    const disk = JSON.parse(localStorage.getItem(KEY));
    expect(disk.characters[0]).toMatchObject({
      notes: 'Облачная заметка',
      contacts: { password: 'PRIVATE_PASSWORD' },
      launch: { gcPath: '/private/local' }
    });
    expect(disk.plannerEntries[0].title).toBe('Облачная задача');
    expect(disk.settings.cloudSyncPendingApply).toMatchObject({
      version: 1,
      events: [{ provider: 'yandex', pin: f.root.pin, records: f.selection, settings: [], financeSettings: false }]
    });
    const { requireResolvedSelectiveApply } = await import('../js/modules/cloudSync/pendingSelectiveApply.js');
    expect(() => requireResolvedSelectiveApply(disk.settings)).toThrow('происхождение');
    const { normalizeState } = await import('../js/core/state.js');
    expect(() => requireResolvedSelectiveApply(normalizeState(disk).settings)).toThrow('происхождение');
    expect(f.state.ui).toBe(ui);
    expect(f.state.ui.activeTab).toBe('settings');
    expect(await operation.commit({ confirmed: true })).toEqual({ status: 'closed' });
  });

  it('не трогает диск после изменения локальных данных или контактов во время просмотра', async () => {
    const f = await fixture();
    const operation = f.stage();
    f.state.characters[0].contacts.password = 'NEW_LOCAL_PASSWORD';
    expect(await operation.commit({ confirmed: true })).toEqual({ status: 'state_changed' });
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    expect(await f.adapter.listBackups()).toEqual([]);
  });

  it('не перезаписывает более свежий или несохранённый диск и не создаёт backup не того состояния', async () => {
    const f = await fixture();
    const operation = f.stage();
    const changed = JSON.parse(f.oldRaw);
    changed.characters[0].notes = 'Другая программа';
    const changedRaw = JSON.stringify(changed);
    localStorage.setItem(KEY, changedRaw);
    expect(await operation.commit({ confirmed: true })).toEqual({ status: 'disk_changed_or_unsaved' });
    expect(localStorage.getItem(KEY)).toBe(changedRaw);
    expect(await f.adapter.listBackups()).toEqual([]);
  });

  it('при отказе backup не меняет память или диск и останавливает запись', async () => {
    const f = await fixture();
    vi.spyOn(f.adapter, 'createMigrationBackup').mockRejectedValue(new Error('private path'));
    const outcome = await f.stage().commit({ confirmed: true });
    expect(outcome).toEqual({ status: 'backup_unconfirmed_restart' });
    expect(f.state.characters[0].notes).toBe('Локально');
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    await expect(f.storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('прерывает применение при изменении памяти во время создания копии', async () => {
    const f = await fixture();
    let release;
    let started;
    const began = new Promise(resolve => {
      started = resolve;
    });
    const wait = new Promise(resolve => {
      release = resolve;
    });
    const makeBackup = f.adapter.createMigrationBackup.bind(f.adapter);
    vi.spyOn(f.adapter, 'createMigrationBackup').mockImplementation(async (...args) => {
      const name = await makeBackup(...args);
      started();
      await wait;
      return name;
    });
    const pending = f.stage().commit({ confirmed: true });
    await began;
    f.state.characters[0].notes = 'Несохранённая правка';
    release();
    const outcome = await pending;
    expect(outcome.status).toBe('state_changed_after_backup_restart');
    expect(localStorage.getItem(outcome.backup)).toBe(f.oldRaw);
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    expect(f.state.characters[0].notes).toBe('Несохранённая правка');
    await expect(f.storage.persist()).rejects.toThrow('Запись остановлена');
  });

  it('не повторяет запись после потерянного ответа и оставляет исходную копию', async () => {
    const f = await fixture();
    const originalSave = f.adapter.saveMigratedState.bind(f.adapter);
    const save = vi.spyOn(f.adapter, 'saveMigratedState').mockImplementation(async (...args) => {
      await originalSave(...args);
      throw new Error('ответ потерян');
    });
    const operation = f.stage();
    const outcome = await operation.commit({ confirmed: true });
    expect(outcome.status).toBe('write_unconfirmed_restart');
    expect(localStorage.getItem(outcome.backup)).toBe(f.oldRaw);
    expect(JSON.parse(localStorage.getItem(KEY)).characters[0].notes).toBe('Облачная заметка');
    expect(await operation.commit({ confirmed: true })).toEqual({ status: 'closed' });
    await expect(f.storage.persist()).rejects.toThrow('Запись остановлена');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('не применяет частично облачную ветку одновременно с публикацией в этом JS-контексте', async () => {
    const f = await fixture();
    const { beginCloudDataOperation } = await import('../js/modules/cloudSync/credentialResetCoordination.js');
    const sending = beginCloudDataOperation();
    const operation = f.stage();
    expect(await operation.commit({ confirmed: true })).toEqual({ status: 'busy' });
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
    sending.finish(false);
    expect((await operation.commit({ confirmed: true })).status).toBe('applied');
  });

  it('не принимает поддельный обзор, пустой выбор или неверный pin', async () => {
    const f = await fixture();
    expect(() =>
      f.stageReviewedCloudApply({ review: { prepareApply() {} }, pin: f.root.pin, selectedRecords: f.selection })
    ).toThrow();
    expect(() => f.stageReviewedCloudApply({ review: f.review, pin: f.root.pin, selectedRecords: [] })).toThrow();
    expect(() =>
      f.stageReviewedCloudApply({
        review: f.review,
        pin: { ...f.root.pin, sha256: '0'.repeat(64) },
        selectedRecords: f.selection
      })
    ).toThrow();
    const operation = f.stage();
    expect(operation.cancel()).toEqual({ status: 'cancelled' });
    expect(await operation.commit({ confirmed: true })).toEqual({ status: 'closed' });
    expect(localStorage.getItem(KEY)).toBe(f.oldRaw);
  });
});
