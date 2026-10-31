import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Composition regression: real JS state/save/ID migration/guarded backups/journals,
// real authenticatedSession/nativeDiskFetch/versionVerifier, only the IPC server is
// synthetic. NOT proof of Windows files/vault or real Yandex credentials/network.
async function fixture() {
  const { state, normalizeState } = await import('../js/core/state.js');
  const { saveNow } = await import('../js/core/storage.js');
  const { prepareYandexCredentialRecord } =
    await import('../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js');
  const { createStandaloneFileRuntime } = await import('../js/modules/cloudSync/standaloneFileRuntime.js');
  const binding = {
    slotId: '01234567-89ab-4cde-8f01-23456789abcd',
    clientId: '0123456789abcdef',
    accountKey: 'FAKE_ACCOUNT'
  };
  const record = prepareYandexCredentialRecord({
    ...binding,
    revision: '11234567-89ab-4cde-8f01-23456789abcd',
    accessToken: 'FAKE_ACCESS',
    expiresAt: Date.now() + 3600000
  });
  const disk = new Map();
  let puts = 0;
  const reply = (body, status = 200) => ({
    status,
    contentType: 'application/json',
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const missing = () => ({ status: 404, contentType: null, body: '' });
  const name = args => `tf-v1-${args.datasetId}-${args.versionId}.tfsc`;
  const native = {
    invoke: vi.fn(async (command, wrapped) => {
      if (command === 'cloud_credential_binding_read')
        return wrapped.provider === 'yandex' ? { status: 'ready', ...binding } : { status: 'empty' };
      if (command === 'cloud_credential_read') return { status: 'ready', slotId: binding.slotId, record };
      if (command === 'cloud_simple_key_read') return null;
      if (command !== 'cloud_disk_network') throw new Error('Unknown synthetic command');
      const args = wrapped.args;
      if (args.operation === 'identity') return reply({ client_id: binding.clientId, psuid: binding.accountKey });
      if (args.operation === 'list') {
        const items = [...disk.keys()].map(name => ({ name, type: 'file', modified: '2026-10-31T10:00:00Z' }));
        return reply({ type: 'dir', _embedded: { items, offset: 0, limit: 100, total: items.length } });
      }
      if (args.operation === 'upload_link')
        return reply({
          href: `https://uploader9x.disk.yandex.net/upload-target/fake?path=${name(args)}`,
          method: 'PUT',
          templated: false,
          operation_id: 'FAKE_ID_NOT_STORED'
        });
      if (args.operation === 'upload_content') {
        const saved = JSON.parse(localStorage.getItem('tvinoferma_state_v1'));
        expect(saved.settings.cloudStandaloneFiles.yandex.pending.phase).toBe('attempting');
        expect(JSON.stringify(saved.settings.cloudStandaloneFiles.yandex.pending.envelope)).toBe(args.body);
        expect(args.accessToken).toBeUndefined();
        const path = new URL(args.link).searchParams.get('path');
        disk.set(path, args.body);
        puts++;
        return { status: 201, contentType: null, body: '' };
      }
      if (args.operation === 'download_link')
        return disk.has(name(args))
          ? reply({
              href: `https://downloader.disk.yandex.ru/disk/fake?path=${name(args)}`,
              method: 'GET',
              templated: false
            })
          : missing();
      if (args.operation === 'download_content') {
        const body = disk.get(new URL(args.link).searchParams.get('path'));
        return body ? { status: 200, contentType: 'application/octet-stream', body } : missing();
      }
      throw new Error('Unknown synthetic operation');
    })
  };
  Object.assign(
    state,
    normalizeState({
      characters: [
        { id: 'a', nick: 'Первый ПК' },
        { id: 'b', nick: 'Ещё персонаж' }
      ],
      settings: { security: { useVault: false } }
    })
  );
  await saveNow();
  return {
    state,
    normalizeState,
    saveNow,
    native,
    disk,
    runtime: createStandaloneFileRuntime(native),
    createStandaloneFileRuntime,
    get puts() {
      return puts;
    }
  };
}

describe('standalone desktop composition with real guarded JS storage', () => {
  it('saves a first full copy after durable ID/journal backups, then another PC previews and fully accepts it with an exact local backup and no upload', async () => {
    const f = await fixture();
    const prepared = await f.runtime.prepareSave({ targets: ['yandex'], password: 'Ab3!xyZ7' });
    const sent = await f.runtime.save(prepared, { confirmed: true });
    expect(sent.results).toEqual([{ provider: 'yandex', status: 'sent_verified' }]);
    expect(f.puts).toBe(1);
    expect(f.disk.size).toBe(1);
    expect(f.state.characters.every(character => typeof character.syncId === 'string')).toBe(true);
    expect(f.state.settings.cloudStandaloneFiles.yandex.pending).toBeNull();
    expect(JSON.stringify(f.state.settings.cloudStandaloneFiles)).not.toContain('Ab3!xyZ7');
    const originalCloud = structuredClone(f.state.characters);
    // Independent application state / no legacy bindings, keys, queue or ancestors.
    Object.assign(
      f.state,
      f.normalizeState({
        characters: [{ id: 'other', nick: 'Местный перед заменой' }],
        settings: { security: { useVault: false }, launcher: { layoutDir: 'LOCAL-SECOND-PC-PATH' } }
      })
    );
    await f.saveNow();
    const before = localStorage.getItem('tvinoferma_state_v1');
    const otherPC = f.createStandaloneFileRuntime(f.native);
    const checked = await otherPC.check({ targets: ['yandex'], manual: true });
    expect(checked.files).toHaveLength(1);
    const file = checked.files[0];
    const review = await otherPC.review({
      provider: 'yandex',
      versionId: file.versionId,
      sha256: file.sha256,
      password: 'Ab3!xyZ7'
    });
    expect(review.comparison.entries.some(entry => entry.kind === 'only_local')).toBe(true);
    expect(review.comparison.entries.some(entry => entry.kind === 'only_cloud')).toBe(true);
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe(before); // read-only preview
    expect((await otherPC.accept(review, { confirmed: true })).status).toBe('applied');
    expect(f.state.characters.map(character => character.syncId)).toEqual(
      originalCloud.map(character => character.syncId)
    );
    expect(f.state.settings.launcher.layoutDir).toBe('LOCAL-SECOND-PC-PATH');
    const backups = Object.keys(localStorage)
      .filter(key => key.startsWith('tvinoferma_backup_'))
      .map(key => localStorage.getItem(key));
    expect(backups).toContain(before);
    expect(f.puts).toBe(1);
    expect(f.native.invoke.mock.calls.some(([command]) => /dataset|outbox|key_state/.test(command))).toBe(false);
  });
});

describe('standalone UI through real runtime and guarded storage', () => {
  it('selects connected Yandex, submits the actual password form, uploads and verifies; next save needs no extra window', async () => {
    const { readFileSync } = await import('node:fs');
    const { bindStandaloneFilePanel } = await import('../js/modules/cloudSync/ui/standaloneFilePanel.js');
    const html = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    document.body.innerHTML = html.getElementById('cloud-registration-panel').outerHTML;
    if (!HTMLDialogElement.prototype.showModal)
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} });
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {
      this.open = true;
    });
    const f = await fixture();
    const confirmAction = vi.fn(async () => true);
    const controller = bindStandaloneFilePanel({
      desktop: true,
      runtime: f.runtime,
      confirm: confirmAction,
      record: vi.fn()
    });
    try {
      const save = document.getElementById('cloud-standalone-save');
      await vi.waitFor(() => expect(save.disabled).toBe(false));
      expect(document.querySelector('[data-standalone-destination]:checked').value).toBe('yandex');
      save.click();
      await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
      const dialog = document.querySelector('dialog');
      expect(dialog.querySelector('[role=alert]').hidden).toBe(true);
      dialog.querySelector('[name=password]').value = 'Ab3!xyZ7';
      dialog.querySelector('[name=repeat]').value = 'Ab3!xyZ7';
      dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
      await vi.waitFor(() => expect(save.disabled).toBe(false), { timeout: 10000 });
      expect(f.puts).toBe(1);
      expect(document.getElementById('cloud-standalone-provider-results').textContent).toContain(
        'полный файл сохранён и сверен'
      );
      expect(confirmAction).not.toHaveBeenCalled();
      expect(document.querySelector('dialog')).toBeNull();
      f.state.characters[0].nick = 'После первой отправки';
      await f.saveNow();
      save.click();
      await vi.waitFor(() => expect(save.disabled).toBe(false), { timeout: 10000 });
      expect(f.puts).toBe(2);
      expect(document.querySelector('dialog')).toBeNull();
      expect(confirmAction).not.toHaveBeenCalled();
      expect(f.state.settings.cloudStandaloneFiles.yandex.pending).toBeNull();
    } finally {
      controller.dispose();
    }
  });
});
