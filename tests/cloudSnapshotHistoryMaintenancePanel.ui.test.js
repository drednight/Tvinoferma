import { legacyCloudHtml } from './helpers/legacyCloudHtml.js';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { bindSnapshotHistoryMaintenancePanel } from '../js/modules/cloudSync/ui/snapshotHistoryMaintenancePanel.js';
import { cloudActivity, clearCloudActivity } from '../js/modules/cloudSync/cloudEventLog.js';
const html = legacyCloudHtml(readFileSync('index.html', 'utf8')),
  el = id => document.getElementById('cloud-history-' + id);
function setup(extra = {}) {
  const api = {
      publishSnapshotHistoryCheckpoint: vi.fn(async () => ({ status: 'sent_verified' })),
      prepareSnapshotHistoryRetirement: vi.fn(async () => ({ status: 'retirement_ready', count: 1, cancel: vi.fn() })),
      retireNextSnapshotHistoryFile: vi.fn(async () => ({ status: 'retired_verified', remaining: 0 })),
      releaseSnapshotHistoryRetirement: vi.fn(async () => ({ status: 'retirement_released_uncertain' })),
      inspectSnapshotHistoryArchive: vi.fn(async () => ({
        status: 'archive_restore_choices',
        choices: [{ versionId: 'ARCHIVE_HEAD', head: true, privateAvailable: true }],
        cancel: vi.fn()
      })),
      prepareSnapshotHistoryRestore: vi.fn(async () => ({
        status: 'archive_restore_review',
        differences: { entries: [{ section: 'planner', kind: 'only_local', label: 'Удалённая задача' }] },
        rows: [{ characterId: 'c', field: 'password', label: 'Персонаж', selectable: true, clears: false }],
        cancel: vi.fn()
      })),
      applySnapshotHistoryRestore: vi.fn(async () => ({ status: 'applied' }))
    },
    loadNative = vi.fn(async () => ({ invoke: vi.fn() })),
    confirm = vi.fn(() => true);
  bindSnapshotHistoryMaintenancePanel({ desktop: true, maintenanceApi: api, loadNative, confirm, ...extra });
  return { api, loadNative, confirm };
}
function chooseFile(size = 10) {
  Object.defineProperty(el('maintenance-file'), 'files', {
    configurable: true,
    value: [{ size, text: vi.fn(async () => 'ENCRYPTED_ARCHIVE_ONLY') }]
  });
  el('maintenance-file').dispatchEvent(new Event('change'));
}
function check(id) {
  el(id).checked = true;
  el(id).dispatchEvent(new Event('change'));
}
function verified() {
  el('archive').dispatchEvent(
    new CustomEvent('tf-history-archive-verified', { detail: { provider: 'google', review: { opaque: true } } })
  );
}
beforeEach(() => {
  clearCloudActivity();
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
  document.getElementById('cloud-registration-provider').value = 'google';
});
describe('контрольный файл, корзина и restore — UI', () => {
  it('web preview never opens native, and contacts opt-ins default off', () => {
    const f = setup({ desktop: false });
    for (const id of [
      'checkpoint',
      'cleanup-review',
      'cleanup',
      'cleanup-release',
      'inspect',
      'restore-review',
      'restore-apply'
    ]) {
      expect(el(id).disabled).toBe(true);
      el(id).click();
    }
    expect(f.loadNative).not.toHaveBeenCalled();
    for (const e of document.querySelectorAll('#cloud-history-private-fields input')) expect(e.checked).toBe(false);
  });
  it('requires verified archive plus stopped devices and independent key before checkpoint', async () => {
    const f = setup();
    expect(el('checkpoint').disabled).toBe(true);
    verified();
    check('paused');
    expect(el('checkpoint').disabled).toBe(true);
    check('key-backup');
    el('checkpoint').click();
    await vi.waitFor(() => expect(f.api.publishSnapshotHistoryCheckpoint).toHaveBeenCalledTimes(1));
    expect(f.api.publishSnapshotHistoryCheckpoint.mock.calls[0][0]).toMatchObject({
      allDevicesPausedConfirmed: true,
      independentKeyBackupConfirmed: true,
      privateCarryConfirmed: false
    });
    expect(f.api.retireNextSnapshotHistoryFile).not.toHaveBeenCalled();
    expect(el('maintenance-status').textContent).not.toContain('ENCRYPTED_ARCHIVE_ONLY');
  });
  it('canceled confirmation never publishes', async () => {
    const f = setup({ confirm: () => false });
    verified();
    check('paused');
    check('key-backup');
    el('checkpoint').click();
    await vi.waitFor(() => expect(el('checkpoint').disabled).toBe(false));
    expect(f.api.publishSnapshotHistoryCheckpoint).not.toHaveBeenCalled();
  });
  it('cleanup requires fresh review and separate consent, then verifies outcomes', async () => {
    const f = setup();
    chooseFile();
    expect(el('cleanup').disabled).toBe(true);
    el('cleanup-review').click();
    await vi.waitFor(() => expect(f.api.prepareSnapshotHistoryRetirement).toHaveBeenCalledTimes(1));
    expect(el('cleanup').disabled).toBe(true);
    check('paused');
    check('key-backup');
    el('cleanup').click();
    await vi.waitFor(() => expect(f.api.retireNextSnapshotHistoryFile).toHaveBeenCalledTimes(1));
    expect(el('maintenance-status').textContent).toContain('Корзина не очищалась');
    expect(cloudActivity()[0]).toMatchObject({ provider: 'google', action: 'history_retirement', outcome: 'success' });
  });
  it('unknown trash stops loop instead of retrying', async () => {
    const f = setup();
    f.api.retireNextSnapshotHistoryFile.mockResolvedValue({ status: 'retirement_unknown' });
    chooseFile();
    el('cleanup-review').click();
    await vi.waitFor(() => expect(f.api.prepareSnapshotHistoryRetirement).toHaveBeenCalledTimes(1));
    check('paused');
    check('key-backup');
    el('cleanup').click();
    await vi.waitFor(() => expect(el('maintenance-status').textContent).toContain('Автоматического повтора нет'));
    expect(f.api.retireNextSnapshotHistoryFile).toHaveBeenCalledTimes(1);
  });
  it.each(['retirement_unknown', 'retirement_released_uncertain', 'verification_pending'])(
    'logs %s as uncertain, not a failed guard or success',
    async outcome => {
      const f = setup();
      if (outcome === 'verification_pending') {
        f.api.publishSnapshotHistoryCheckpoint.mockResolvedValue({ status: outcome });
        verified();
        check('paused');
        check('key-backup');
        el('checkpoint').click();
      } else {
        f.api.releaseSnapshotHistoryRetirement.mockResolvedValue({ status: outcome });
        el('cleanup-release').click();
      }
      await vi.waitFor(() => expect(cloudActivity()[0]?.outcome).toBe('uncertain'));
      expect(JSON.stringify(cloudActivity())).not.toContain('ENCRYPTED_ARCHIVE_ONLY');
    }
  );
  it('restores chosen version with deletions; no contact selected automatically and exact selection only', async () => {
    const f = setup();
    chooseFile();
    el('inspect').click();
    await vi.waitFor(() => expect(el('version').options).toHaveLength(2));
    expect(el('restore-review').disabled).toBe(true);
    el('version').value = '0';
    el('version').dispatchEvent(new Event('change'));
    el('restore-review').click();
    await vi.waitFor(() => expect(el('restore-apply').disabled).toBe(false));
    expect(f.api.prepareSnapshotHistoryRestore.mock.calls[0][0].fields).toEqual([]);
    expect(el('restore-differences').textContent).toContain('будет удалено');
    expect(el('restore-contacts').querySelector('input').checked).toBe(false);
    el('restore-all').click();
    expect(el('restore-contacts').querySelector('input').checked).toBe(true);
    el('restore-none').click();
    expect(el('restore-contacts').querySelector('input').checked).toBe(false);
    el('restore-apply').click();
    await vi.waitFor(() => expect(f.api.applySnapshotHistoryRestore).toHaveBeenCalledTimes(1));
    expect(f.api.applySnapshotHistoryRestore.mock.calls[0][0].selections).toEqual([]);
    expect(el('maintenance-status').textContent).toContain('Принятая облачная база');
  });
  it('changing provider resets all opaque choices', async () => {
    setup();
    verified();
    check('paused');
    check('key-backup');
    expect(el('checkpoint').disabled).toBe(false);
    const provider = document.getElementById('cloud-registration-provider');
    provider.value = 'yandex';
    provider.dispatchEvent(new Event('change'));
    expect(el('checkpoint').disabled).toBe(true);
    expect(el('restore-apply').disabled).toBe(true);
  });
});
