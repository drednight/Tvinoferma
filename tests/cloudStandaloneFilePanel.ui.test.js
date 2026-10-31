import { withCloudAccessDiagnostic } from '../js/modules/cloudSync/providers/cloudAccessDiagnostics.js';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { askStandalonePassword, bindStandaloneFilePanel } from '../js/modules/cloudSync/ui/standaloneFilePanel.js';
const html = readFileSync('index.html', 'utf8');
const el = id => document.getElementById(`cloud-standalone-${id}`);
const sha256 = 'a'.repeat(64);
const versionId = '11111111-1111-4111-8111-111111111111';
const file = {
  versionId,
  sha256,
  locations: [
    { provider: 'google', modifiedAt: '2026-10-31T10:00:00Z' },
    { provider: 'yandex', modifiedAt: '2026-10-31T11:00:00Z' }
  ]
};
const token = () => ({
  provider: 'google',
  versionId,
  sha256,
  createdAt: '2026-10-31T09:00:00Z',
  bothChanged: true,
  hasPrivate: true,
  noCommonBase: false,
  privateChanges: [],
  comparison: {
    entries: [
      { section: 'characters', kind: 'only_local', label: '<img src=x onerror=alert(1)> Старый', changes: [] },
      { section: 'planner', kind: 'only_cloud', label: 'Новая задача', changes: [] },
      {
        section: 'characters',
        kind: 'changed',
        label: 'Изменение',
        changes: [{ path: ['nick'], local: { present: true, value: 'Было' }, cloud: { present: true, value: 'Стало' } }]
      }
    ],
    uncomparedSettings: []
  }
});
const disposers = [];
function setup(extra = {}) {
  // Explicit user choice; the production page no longer preselects Google.
  if (extra.chooseDestination !== false)
    document.querySelector('[data-standalone-destination][value=google]').checked = true;
  const runtime = {
    check: vi.fn(async () => ({ files: [file], results: [{ provider: 'google', status: 'checked' }], pending: [] })),
    canSeal: vi.fn(async () => false),
    prepareSave: vi.fn(async () => ({ remoteCopies: 0, hasPrivate: false, hasUnacceptedCopies: false })),
    save: vi.fn(async () => ({ results: [{ provider: 'google', status: 'sent_verified' }] })),
    review: vi.fn(async () => token()),
    accept: vi.fn(async () => ({ status: 'applied' })),
    decline: vi.fn(async () => ({ status: 'kept_local' })),
    forgetRememberedKey: vi.fn(async () => {}),
    continuePending: vi.fn(async () => ({ provider: 'google', status: 'sent_verified' })),
    ...extra.runtime
  };
  const confirm = extra.confirm || vi.fn(async () => true);
  const password = extra.password || vi.fn(async () => 'Ab3!xyZ7');
  const controller = bindStandaloneFilePanel({
    desktop: true,
    startup: false,
    confirm,
    password,
    record: vi.fn(),
    ...extra,
    runtime
  });
  disposers.push(controller.dispose);
  return { runtime, confirm, password };
}
async function click(id) {
  el(id).click();
  await vi.waitFor(() => expect(el(id).disabled).toBe(false));
}
async function compare() {
  await click('check');
  el('files').querySelector('button').click();
  await vi.waitFor(() => expect(el('review').hidden).toBe(false));
  await vi.waitFor(() => expect(el('check').disabled).toBe(false));
}
beforeEach(() => {
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});
describe('standalone full file UX', () => {
  it('starts collapsed and puts the old multi-step flow only under a separate recovery fold', () => {
    expect(document.getElementById('cloud-registration-panel').open).toBe(false);
    expect(document.getElementById('cloud-standalone-legacy')).toBeNull();
    expect(document.getElementById('cloud-file-panel')).toBeNull();
    expect(el('panel').contains(document.getElementById('cloud-setup-main'))).toBe(false);
  });
  it('shows grouped destinations, dates, additions, changes and full-replacement deletions with safe text', async () => {
    const f = setup();
    await compare();
    expect(el('files').textContent).toContain('Google Диск + Яндекс Диск');
    expect(el('files').textContent).toContain('часовой пояс');
    expect(el('differences').textContent).toContain('Будет удалено');
    expect(el('differences').textContent).toContain('Будет добавлено');
    expect(el('differences').textContent).toContain('Было → Стало');
    expect(el('review-status').textContent).toContain('и местные, и облачные');
    expect(el('differences').querySelector('img')).toBeNull();
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('has one password-and-repeat step for a new save and one save button for both destinations', async () => {
    const f = setup();
    document.querySelector('[data-standalone-destination][value=yandex]').checked = true;
    await click('save');
    expect(f.password).toHaveBeenCalledWith({ repeat: true });
    expect(f.runtime.prepareSave).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ['google', 'yandex'], fields: [] })
    );
    expect(f.runtime.save).toHaveBeenCalledOnce();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('каждого диска');
  });
  it('asks only for the existing password, not a new-password repeat, after restart without remembered master', async () => {
    const f = setup({ runtime: { hasEncryptionKey: vi.fn(() => true) } });
    await click('save');
    expect(f.password).toHaveBeenCalledWith({ repeat: false });
  });
  it('does not show a new-password ceremony when the protected/current-session key is unlocked', async () => {
    const f = setup({ runtime: { canSeal: vi.fn(async () => true) } });
    await click('save');
    expect(f.password).not.toHaveBeenCalled();
    expect(f.runtime.save).toHaveBeenCalledOnce();
  });
  it('keeps local data without upload after decline, and never uploads automatically after accept', async () => {
    const f = setup();
    await compare();
    await click('decline');
    expect(f.runtime.decline).toHaveBeenCalledOnce();
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(f.runtime.save).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('не будет напоминаться');
    await compare();
    await click('accept');
    expect(f.runtime.accept).toHaveBeenCalledOnce();
    expect(f.runtime.save).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('второй');
  });
  it('does not replace or upload when the final confirmation was cancelled', async () => {
    const f = setup({
      confirm: vi.fn(async () => false),
      runtime: { prepareSave: vi.fn(async () => ({ remoteCopies: 1, hasUnacceptedCopies: true })) }
    });
    await click('save');
    expect(f.runtime.save).not.toHaveBeenCalled();
    await compare();
    await click('accept');
    expect(f.runtime.accept).not.toHaveBeenCalled();
  });
  it('select-all never grants private consent, password risk, remembering or another destination', async () => {
    setup();
    await click('select-all');
    expect([...document.querySelectorAll('[data-standalone-private]')].every(input => input.checked)).toBe(true);
    for (const id of ['contacts-confirm', 'password-risk', 'remember']) expect(el(id).checked).toBe(false);
    expect(document.querySelector('[data-standalone-destination][value=yandex]').checked).toBe(false);
    await click('save');
    expect(el('status').textContent).toContain('полноту');
    await click('select-none');
    expect([...document.querySelectorAll('[data-standalone-private]')].some(input => input.checked)).toBe(false);
  });
  it('does not retain a private-export policy after a save', async () => {
    const f = setup();
    document.querySelector('[data-standalone-private][value=email]').checked = true;
    el('contacts-confirm').checked = true;
    await click('save');
    expect(f.runtime.prepareSave).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['email'], contactsSourceConfirmed: true })
    );
    expect(document.querySelector('[data-standalone-private][value=email]').checked).toBe(false);
    expect(el('contacts-confirm').checked).toBe(false);
  });
  it('requires another preview if private selections change after comparison', async () => {
    const f = setup();
    await compare();
    document.querySelector('[data-standalone-private][value=email]').checked = true;
    el('contacts-confirm').checked = true;
    await click('accept');
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('заново');
  });
  it('clearly separates unconfirmed upload from success and offers only continuation of the SAME old file', async () => {
    const f = setup({
      runtime: {
        save: vi.fn(async () => ({
          results: [
            { provider: 'google', status: 'verification_pending' },
            { provider: 'yandex', status: 'sent_verified' }
          ]
        }))
      }
    });
    await click('save');
    expect(el('provider-results').textContent).toContain('отправка пока не подтверждена');
    expect(el('provider-results').textContent).toContain('Яндекс Диск: полный файл сохранён');
    el('provider-results').querySelector('button').click();
    await vi.waitFor(() => expect(f.runtime.continuePending).toHaveBeenCalledWith('google'));
  });
  it('keeps advanced sources, privacy, backups and recovery folded away from primary actions', () => {
    setup();
    expect(el('options').open).toBe(false);
    for (const id of ['source', 'remember', 'forget', 'show-backups', 'contacts-confirm'])
      expect(el('options').contains(el(id))).toBe(true);
    expect(el('legacy')).toBeNull();
    expect(el('save').closest('details').id).toBe('cloud-registration-panel');
    expect(el('check').closest('details').id).toBe('cloud-registration-panel');
  });
  it('does not choose a save destination from login or polling; requires an independent explicit choice', async () => {
    expect(document.querySelector('[data-standalone-destination]:checked')).toBeNull();
    const f = setup({
      chooseDestination: false,
      startup: true,
      runtime: {
        check: vi.fn(async () => ({
          files: [],
          pending: [],
          results: [
            { provider: 'google', status: 'credential_missing' },
            { provider: 'yandex', status: 'checked' }
          ]
        }))
      }
    });
    await vi.waitFor(() => expect(el('save').disabled).toBe(false));
    expect(document.querySelector('[data-standalone-destination]:checked')).toBeNull();
    document.defaultView.dispatchEvent(
      new CustomEvent('tf-cloud-credential-ready', { detail: { provider: 'google' } })
    );
    await vi.waitFor(() => expect(el('save').disabled).toBe(false));
    expect(document.querySelector('[data-standalone-destination]:checked')).toBeNull();
    document.querySelector('[data-standalone-destination][value=yandex]').checked = true;
    await click('save');
    expect(f.runtime.prepareSave).toHaveBeenCalledWith(expect.objectContaining({ targets: ['yandex'] }));
    expect(f.runtime.save).toHaveBeenCalledOnce();
  });
  it('does not change an explicit destination after another account is connected', async () => {
    const f = setup({ startup: true });
    await vi.waitFor(() => expect(el('save').disabled).toBe(false));
    const google = document.querySelector('[data-standalone-destination][value=google]');
    google.checked = false;
    google.dispatchEvent(new Event('change'));
    document.querySelector('[data-standalone-destination][value=yandex]').checked = true;
    document.defaultView.dispatchEvent(
      new CustomEvent('tf-cloud-credential-ready', { detail: { provider: 'google' } })
    );
    await vi.waitFor(() => expect(f.runtime.check).toHaveBeenCalledTimes(2));
    expect(google.checked).toBe(false);
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('reports a missing account without exposing raw errors or claiming the file was saved', async () => {
    const f = setup({
      runtime: {
        prepareSave: vi.fn(async () => {
          throw Object.assign(new Error('destinations_unavailable'), {
            results: [{ provider: 'google', status: 'credential_missing' }]
          });
        })
      }
    });
    await click('save');
    expect(el('status').textContent).toContain('Отправка не началась');
    expect(el('provider-results').textContent).toContain('диск не подключён');
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('still confirms an upload that includes private fields', async () => {
    const f = setup({
      confirm: vi.fn(async () => false),
      runtime: {
        prepareSave: vi.fn(async () => ({ remoteCopies: 0, hasPrivate: true, hasUnacceptedCopies: false }))
      }
    });
    document.querySelector('[data-standalone-private][value=email]').checked = true;
    el('contacts-confirm').checked = true;
    await click('save');
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('shows and logs the exact safe failure stage instead of another generic pending result', async () => {
    const record = vi.fn();
    setup({
      record,
      runtime: {
        save: vi.fn(async () => ({
          results: [
            withCloudAccessDiagnostic({ provider: 'google', status: 'verification_pending' }, 'download_link_forbidden')
          ]
        }))
      }
    });
    await click('save');
    expect(el('provider-results').textContent).toContain('Получение ссылки скачивания');
    expect(el('provider-results').textContent).toContain('HTTP 403');
    expect(record).toHaveBeenCalledWith('google', 'standalone_save', 'download_link_forbidden');
  });
  it('never makes native calls in the browser preview', async () => {
    const f = setup({ desktop: false });
    expect(el('save').disabled).toBe(true);
    expect(el('status').textContent).toContain('Windows');
    expect(f.runtime.check).not.toHaveBeenCalled();
  });
  it('periodic/startup checks and account-ready events only check, never save or apply', async () => {
    let tick;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(fn => {
      tick = fn;
      return 123;
    });
    const f = setup({ startup: true });
    await vi.waitFor(() => expect(f.runtime.check).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(el('check').disabled).toBe(false));
    document.defaultView.dispatchEvent(new CustomEvent('tf-cloud-credential-ready'));
    await vi.waitFor(() => expect(f.runtime.check).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(el('check').disabled).toBe(false));
    tick();
    await vi.waitFor(() => expect(f.runtime.check).toHaveBeenCalledTimes(3));
    expect(f.runtime.save).not.toHaveBeenCalled();
    expect(f.runtime.accept).not.toHaveBeenCalled();
  });
});
describe('encryption password dialog', () => {
  beforeEach(() => {
    if (!HTMLDialogElement.prototype.showModal)
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} });
  });
  it('keeps the dialog open and explicitly reports the 8-character minimum, then validates repeat', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {
      this.open = true;
    });
    const promise = askStandalonePassword({ repeat: true });
    const dialog = document.querySelector('dialog'),
      form = dialog.querySelector('form');
    expect(dialog.querySelector('[role=alert]').hidden).toBe(true);
    const pass = form.elements.namedItem('password'),
      repeat = form.elements.namedItem('repeat');
    pass.value = 'Ab3!xyZ';
    repeat.value = pass.value;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(dialog.isConnected).toBe(true);
    expect(dialog.querySelector('[role=alert]').hidden).toBe(false);
    expect(dialog.querySelector('[role=alert]').textContent).toContain('не менее 8 символов');
    pass.value = 'Ab3!xyZ7';
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    expect(dialog.querySelector('[role=alert]').hidden).toBe(true);
    repeat.value = 'Different';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(dialog.querySelector('[role=alert]').textContent).toContain('не совпадают');
    repeat.value = pass.value;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(await promise).toBe('Ab3!xyZ7');
    expect(pass.value).toBe('');
    expect(repeat.value).toBe('');
    expect(dialog.isConnected).toBe(false);
  });
  it('opens elsewhere with one password field and clears it on cancellation', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {
      this.open = true;
    });
    const promise = askStandalonePassword();
    const dialog = document.querySelector('dialog');
    expect(dialog.querySelectorAll('input[type=password]')).toHaveLength(1);
    const input = dialog.querySelector('input');
    input.value = 'private';
    dialog.querySelector('[data-cancel]').click();
    expect(await promise).toBeNull();
    expect(input.value).toBe('');
  });
});

it.each(['credential_refresh_pending', 'credential_blocked', 'login_required'])(
  'offers a direct Google reconnect action for %s without changing destinations',
  async status => {
    const f = setup({
      runtime: { check: vi.fn(async () => ({ files: [], pending: [], results: [{ provider: 'google', status }] })) }
    });
    const panel = document.getElementById('cloud-registration-panel');
    const reconnect = vi.fn();
    panel.addEventListener('tf-cloud-reconnect-google', reconnect);
    const destinations = [...document.querySelectorAll('[data-standalone-destination]')].map(input => input.checked);
    await click('check');
    const button = [...el('provider-results').querySelectorAll('button')].find(
      button => button.textContent === 'Повторить вход Google'
    );
    expect(button).toBeTruthy();
    button.click();
    expect(reconnect).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll('[data-standalone-destination]')].map(input => input.checked)).toEqual(
      destinations
    );
    expect(f.runtime.save).not.toHaveBeenCalled();
  }
);
it('does not suggest fresh OAuth over a damaged account binding', async () => {
  setup({
    runtime: {
      check: vi.fn(async () => ({
        files: [],
        pending: [],
        results: [{ provider: 'google', status: 'credential_binding_blocked' }]
      }))
    }
  });
  await click('check');
  expect(el('provider-results').textContent).toContain('не совпадает с привязкой');
  expect(el('provider-results').querySelector('button')).toBeNull();
});
