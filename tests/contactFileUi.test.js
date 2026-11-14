import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { state } from '../js/core/state.js';
import { openContactFileExport, openContactFileReview } from '../js/settings/contactFileUi.js';
import { encryptContactFile, decryptContactFile, contactSnapshotFromState } from '../js/settings/contactFileCodec.js';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  document.body.innerHTML = '<div id="modal-root"></div>';
  state.characters = [
    {
      id: 'a',
      nick: '<b>Alpha</b>',
      contacts: { email: 'PRIVATE-EMAIL', password: 'PRIVATE-PASSWORD', recoveryEmail: '', phone: '' }
    }
  ];
  state.archivedCharacters = [];
  state.settings.security.useVault = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('requires explicit key acknowledgement, then offers only ciphertext and never writes contacts to local storage', async () => {
  let blob;
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(value => {
      blob = value;
      return 'blob:contact-test';
    }),
    revokeObjectURL: vi.fn()
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const ov = openContactFileExport();
  const start = ov.body.querySelector('button');
  const download = ov.foot.querySelector('button');
  expect(download.disabled).toBe(true);
  start.click();
  await vi.waitFor(() => expect(ov.body.textContent).toContain('Подготовлено карточек: 1'));
  const key = ov.body.querySelector('input[type="text"]').value;
  expect(key).toMatch(/^TF1-/);
  expect(download.disabled).toBe(true);
  ov.body.querySelector('input[type="checkbox"]').click();
  expect(download.disabled).toBe(false);
  download.click();
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(blob.type).toBe('application/json');
  const file = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  expect(file).not.toContain('PRIVATE-PASSWORD');
  expect(file).not.toContain(key);
  expect((await decryptContactFile(file, key, webcrypto)).characters[0].contacts.password).toBe('PRIVATE-PASSWORD');
  expect(localStorage.length).toBe(0);
  expect(state.characters[0].contacts.password).toBe('PRIVATE-PASSWORD');
  expect(ov.body.textContent).not.toContain('PRIVATE-PASSWORD');
  ov.close();
  expect(ov.body.textContent).not.toContain('PRIVATE-PASSWORD');
});

it('refuses to export a stale prepared snapshot after contacts change', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const ov = openContactFileExport();
  ov.body.querySelector('button').click();
  await vi.waitFor(() => expect(ov.body.textContent).toContain('Подготовлено карточек'));
  ov.body.querySelector('input[type="checkbox"]').click();
  state.characters[0].contacts.password = 'CHANGED';
  ov.foot.querySelector('button').click();
  await vi.waitFor(() => expect(ov.body.textContent).toContain('Не удалось подтвердить'));
  expect(click).not.toHaveBeenCalled();
  expect(ov.body.querySelector('input[type="text"]').value).toBe('');
  ov.close();
});

it('opens encrypted file read-only, hides values until consent and treats nick and contacts as text', async () => {
  const prepared = await encryptContactFile(contactSnapshotFromState(state), webcrypto);
  const ov = openContactFileReview();
  const input = ov.body.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [{ size: prepared.file.length, text: async () => prepared.file }] });
  ov.body.querySelector('input[type="password"]').value = prepared.recoveryKey;
  ov.body.querySelector('button').click();
  await vi.waitFor(() => expect(ov.body.textContent).toContain('Карточек в копии: 1'));
  expect(ov.body.textContent).not.toContain('PRIVATE-PASSWORD');
  expect(ov.body.querySelector('b')).toBeNull();
  expect(ov.body.textContent).toContain('<b>Alpha</b>');
  ov.body.querySelector('input[type="checkbox"]').click();
  expect(ov.body.textContent).toContain('PRIVATE-PASSWORD');
  expect(state.characters[0].contacts.password).toBe('PRIVATE-PASSWORD');
  ov.close();
  expect(ov.body.textContent).not.toContain('PRIVATE-PASSWORD');
});
