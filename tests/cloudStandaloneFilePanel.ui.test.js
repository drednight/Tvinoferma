import { cloudDiagnosticSnapshot, clearCloudDiagnostics } from '../js/modules/cloudSync/cloudDiagnostics.js';
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
    prepareSave: vi.fn(async options => {
      if (!(await runtime.canSeal())) await options.requestPassword({ repeat: !runtime.hasEncryptionKey?.() });
      return { remoteCopies: 0, hasPrivate: false, hasUnacceptedCopies: false };
    }),
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
  return { runtime, confirm, password, controller };
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
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    value() {
      this.open = true;
    }
  },
  close: {
    configurable: true,
    value() {
      this.open = false;
    }
  }
});
beforeEach(() => {
  clearCloudDiagnostics();
  localStorage.removeItem('tf_cloud_file_options_v1');
  localStorage.removeItem('tf_cloud_auto_check_v1');
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
  // Exercise the retained experimental module in isolation, not its hidden production entry.
  document.getElementById('cloud-registration-panel').hidden = false;
  document.getElementById('cloud-registration-panel').removeAttribute('inert');
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
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
    expect(el('files').textContent).not.toContain('Google Диск + Яндекс Диск');
    expect(el('files').querySelectorAll('.cloud-copy-card')).toHaveLength(2);
    expect(el('files').textContent).toContain('часовой пояс');
    expect(el('differences').textContent).toContain('Будет удалено');
    expect(el('differences').textContent).toContain('Будет добавлено');
    expect(el('differences').textContent).toContain('БылоСтало');
    expect(el('review-status').textContent).toContain('и местные, и облачные');
    expect(el('differences').querySelector('img')).toBeNull();
    const groups = [...el('differences').querySelectorAll(':scope > li > details')];
    expect(groups).toHaveLength(2);
    expect(groups.every(group => !group.open)).toBe(true);
    expect(groups.map(group => group.querySelector('summary').textContent)).toEqual(['Персонажи (2)', 'Календарь (1)']);
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
    el('save').click();
    await vi.waitFor(() => expect(el('private-dialog').open).toBe(true));
    expect(el('contacts-confirm').checked).toBe(false);
    el('private-cancel').click();
    await vi.waitFor(() => expect(el('save').disabled).toBe(false));
    await click('select-none');
    expect([...document.querySelectorAll('[data-standalone-private]')].some(input => input.checked)).toBe(false);
  });
  it('retains chosen categories, but never a private-export consent, after a save', async () => {
    const f = setup();
    document.querySelector('[data-standalone-private][value=email]').checked = true;
    el('contacts-confirm').checked = true;
    await click('save');
    expect(f.runtime.prepareSave).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['email'], contactsSourceConfirmed: true })
    );
    expect(document.querySelector('[data-standalone-private][value=email]').checked).toBe(true);
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
    expect(el('options').tagName).toBe('SECTION');
    expect(el('options').compareDocumentPosition(el('title')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el('options').contains(el('source'))).toBe(true);
    for (const id of ['remember', 'forget']) expect(el('key-dialog').contains(el(id))).toBe(true);
    expect(el('private-dialog').contains(el('contacts-confirm'))).toBe(true);
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
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, interval) => {
      if (interval === 15 * 60 * 1000) tick = fn;
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
    const dialog = document.querySelector('.cloud-key-dialog'),
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
    const dialog = document.querySelector('.cloud-key-dialog');
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

it('one save waits for Google same-account sign-in then re-prepares and saves without another click', async () => {
  const record = vi.fn();
  const runtime = {
    prepareSave: vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('destinations_unavailable'), {
          results: [{ provider: 'google', status: 'credential_refresh_pending' }]
        })
      )
      .mockResolvedValue({ results: [{ provider: 'google', status: 'checked' }], remoteCopies: 0 })
  };
  const f = setup({ record, runtime });
  const login = vi.fn(event => {
    event.detail.handled = true;
    expect(f.runtime.save).not.toHaveBeenCalled();
    expect(el('save').disabled).toBe(true);
    event.detail.complete(true);
  });
  document.getElementById('cloud-registration-panel').addEventListener('tf-cloud-connect-for-save', login);
  await click('save');
  expect(login).toHaveBeenCalledOnce();
  expect(f.password).not.toHaveBeenCalled(); // overridden preparation never requests a password
  expect(f.runtime.prepareSave).toHaveBeenCalledTimes(2);
  expect(f.runtime.save).toHaveBeenCalledOnce();
});

it('missing login handler does not hang and logs the reported reason, not a generic failure', async () => {
  const record = vi.fn();
  const f = setup({
    record,
    runtime: {
      prepareSave: vi.fn(async () => {
        throw Object.assign(new Error('destinations_unavailable'), {
          results: [{ provider: 'google', status: 'credential_refresh_pending' }]
        });
      })
    }
  });
  await click('save');
  expect(record).toHaveBeenCalledWith('google', 'standalone_save', 'standalone_credential_refresh_pending');
  expect(f.runtime.save).not.toHaveBeenCalled();
  expect(el('provider-results').textContent).toContain('предыдущее обновление');
});

describe('download-and-compare visible lifecycle', () => {
  const feedback = () => el('files').querySelector('.cloud-compare-feedback');
  const begin = async () => {
    await click('check');
    el('files').querySelector('button').click();
  };
  const done = () => vi.waitFor(() => expect(el('check').disabled).toBe(false));
  it('shows real stages and elapsed time with indeterminate progress, blocks duplicate clicks, then focuses the final review', async () => {
    const pending = Promise.withResolvers();
    let progress;
    const record = vi.fn();
    const f = setup({
      record,
      runtime: {
        review: vi.fn(input => {
          progress = input.onProgress;
          return pending.promise;
        })
      }
    });
    await click('check');
    vi.useFakeTimers();
    el('files').querySelector('button').click();
    await vi.waitFor(() => expect(f.runtime.review).toHaveBeenCalledOnce());
    expect(feedback().hidden).toBe(false);
    expect(feedback().textContent).toContain('Проверяем подключение');
    const bar = feedback().querySelector('progress');
    expect(bar.hidden).toBe(false);
    expect(bar.hasAttribute('value')).toBe(false);
    expect(el('check').disabled).toBe(true);
    expect(el('files').querySelector('button').disabled).toBe(true);
    el('files').querySelector('button').dispatchEvent(new Event('click'));
    expect(f.runtime.review).toHaveBeenCalledOnce();
    progress('download');
    expect(feedback().textContent).toContain('2 из 5 · Скачиваем');
    progress('PRIVATE_URL_AND_TOKEN');
    expect(feedback().textContent).not.toContain('PRIVATE_URL_AND_TOKEN');
    await vi.advanceTimersByTimeAsync(2100);
    expect(feedback().textContent).toContain('Прошло 2 с');
    for (const stage of ['verify', 'unlock', 'compare']) progress(stage);
    expect(feedback().textContent).toContain('5 из 5 · Сравниваем');
    pending.resolve(token());
    await done();
    expect(feedback().dataset.state).toBe('success');
    expect(feedback().textContent).toContain('Сравнение завершено');
    expect(feedback().textContent).toContain('Местные данные не заменены');
    expect(bar.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.activeElement).toBe(el('review'));
    expect(record).toHaveBeenCalledWith('google', 'standalone_compare', 'running');
    expect(record).toHaveBeenCalledWith('google', 'standalone_compare', 'success');
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it.each(['google_refresh_unconfirmed', 'credential_refresh_pending', 'remote_changed', 'account_changed'])(
    'shows %s beside the clicked button without a password prompt or retry or false ok',
    async code => {
      const record = vi.fn();
      const f = setup({
        record,
        runtime: {
          review: vi.fn(async () => {
            throw new Error(code);
          })
        }
      });
      await begin();
      await done();
      expect(f.password).not.toHaveBeenCalled();
      expect(f.runtime.review).toHaveBeenCalledOnce();
      expect(feedback().dataset.state).toBe('failed');
      expect(feedback().textContent).toContain(code);
      expect(feedback().querySelector('[role=alert]')).not.toBeNull();
      expect(el('review').hidden).toBe(true);
      expect(record).toHaveBeenLastCalledWith('google', 'standalone_compare', `standalone_${code}`);
      const trace = cloudDiagnosticSnapshot().trace.filter(row => row.stage === 'ui_compare');
      expect(trace.map(row => row.outcome)).toEqual(['start', 'failed']);
    }
  );
  it('keeps the exact safe transport diagnostic and never displays a raw exception', async () => {
    const record = vi.fn();
    const f = setup({
      record,
      runtime: {
        review: vi.fn(async () => {
          throw withCloudAccessDiagnostic(new Error('PRIVATE signed-url password token'), 'download_content_timeout');
        })
      }
    });
    await begin();
    await done();
    expect(feedback().textContent).toContain('download_content_timeout');
    expect(feedback().textContent).not.toContain('PRIVATE');
    expect(f.password).not.toHaveBeenCalled();
    expect(record).toHaveBeenLastCalledWith('google', 'standalone_compare', 'download_content_timeout');
  });
  it('asks for a password only on the explicit password-required code and finishes after the one retry', async () => {
    const review = vi
      .fn()
      .mockRejectedValueOnce(new Error('encryption_password_required'))
      .mockResolvedValueOnce(token());
    const f = setup({ runtime: { review } });
    await begin();
    await done();
    expect(f.password).toHaveBeenCalledExactlyOnceWith({ repeat: false });
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1][0].password).toBe('Ab3!xyZ7');
    expect(feedback().dataset.state).toBe('success');
  });
  it('reports password cancellation explicitly in the card, journal and diagnostics', async () => {
    const record = vi.fn();
    const f = setup({
      record,
      password: vi.fn(async () => null),
      runtime: {
        review: vi.fn(async () => {
          throw new Error('encryption_password_required');
        })
      }
    });
    await begin();
    await done();
    expect(feedback().dataset.state).toBe('cancelled');
    expect(feedback().textContent).toContain('Сравнение отменено');
    expect(f.runtime.review).toHaveBeenCalledOnce();
    expect(record).toHaveBeenLastCalledWith('google', 'standalone_compare', 'cancelled');
    expect(
      cloudDiagnosticSnapshot()
        .trace.filter(row => row.stage === 'ui_compare')
        .at(-1).outcome
    ).toBe('cancelled');
    expect(feedback().querySelector('progress').hidden).toBe(true);
  });
  it.each(['file_open_unavailable', 'credential_refresh_pending'])(
    'does not hide %s or start another password ceremony after the password retry',
    async code => {
      const review = vi
        .fn()
        .mockRejectedValueOnce(new Error('encryption_password_required'))
        .mockRejectedValueOnce(new Error(code));
      const f = setup({ runtime: { review } });
      await begin();
      await done();
      expect(f.password).toHaveBeenCalledOnce();
      expect(review).toHaveBeenCalledTimes(2);
      expect(feedback().textContent).toContain(code);
      expect(feedback().dataset.state).toBe('failed');
      expect(el('review').hidden).toBe(true);
    }
  );
  it('has an explicit no-differences result, and hides that old review if the next attempt fails', async () => {
    const same = { ...token(), comparison: { entries: [] }, privateChanges: [] };
    const review = vi.fn().mockResolvedValueOnce(same).mockRejectedValueOnce(new Error('remote_changed'));
    setup({ runtime: { review } });
    await begin();
    await done();
    expect(feedback().textContent).toContain('различий нет');
    expect(el('review-status').textContent).toContain('Сравнение завершено');
    el('files').querySelector('button').click();
    await done();
    expect(el('review').hidden).toBe(true);
    expect(feedback().dataset.state).toBe('failed');
  });
  it('cleans up the timer on dispose and ignores late progress/results instead of showing false success', async () => {
    const pending = Promise.withResolvers();
    let progress;
    const record = vi.fn();
    const f = setup({
      record,
      runtime: {
        review: vi.fn(input => {
          progress = input.onProgress;
          return pending.promise;
        })
      }
    });
    await click('check');
    vi.useFakeTimers();
    el('files').querySelector('button').click();
    await vi.waitFor(() => expect(f.runtime.review).toHaveBeenCalledOnce());
    f.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    progress('compare');
    pending.resolve(token());
    await vi.advanceTimersByTimeAsync(0);
    expect(el('review').hidden).toBe(true);
    expect(el('files').childNodes.length).toBe(0);
    expect(record).not.toHaveBeenCalledWith('google', 'standalone_compare', 'success');
    expect(record).toHaveBeenLastCalledWith('google', 'standalone_compare', 'cancelled');
  });
});

describe('remembered file parameters and password explanation', () => {
  it('restores the exact explicit choices on a new binding, never consent, a filename or a secret', async () => {
    const f = setup();
    const selectors = [
      '[data-standalone-destination][value=yandex]',
      '[data-standalone-private][value=email]',
      '[data-standalone-private][value=password]',
      '[data-standalone-setting][value=appearance]'
    ];
    for (const selector of selectors) {
      const input = document.querySelector(selector);
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const id of ['remember']) {
      el(id).checked = true;
      el(id).dispatchEvent(new Event('change', { bubbles: true }));
    }
    el('contacts-confirm').checked = true;
    el('password-risk').checked = true;
    el('source').value = 'file';
    el('source').dispatchEvent(new Event('change', { bubbles: true }));
    const saved = JSON.parse(localStorage.getItem('tf_cloud_file_options_v1'));
    expect(Object.keys(saved).sort()).toEqual([
      'backups',
      'destinations',
      'privateFields',
      'remember',
      'settings',
      'source',
      'version'
    ]);
    f.controller.dispose();
    document.body.innerHTML = new DOMParser()
      .parseFromString(html, 'text/html')
      .getElementById('cloud-registration-panel').outerHTML;
    setup({ chooseDestination: false });
    for (const selector of selectors) expect(document.querySelector(selector).checked).toBe(true);
    expect(el('source').value).toBe('file');
    expect(el('source-file-label').hidden).toBe(false);
    expect(el('source-file').files.length).toBe(0);
    for (const id of ['contacts-confirm', 'password-risk', 'backup-ack']) expect(el(id).checked).toBe(false);
    expect(el('remember').checked).toBe(true);
    expect(saved.backups).toBe(true);
    expect(el('show-backups')).toBeNull();
    el('save').click();
    await vi.waitFor(() => expect(el('private-dialog').open).toBe(true));
    expect(el('contacts-confirm').checked).toBe(false);
    el('private-cancel').click();
    await vi.waitFor(() => expect(el('save').disabled).toBe(false));
  });
  it('resets remembered parameters on factory reset, but not ordinary dispose', () => {
    const f = setup();
    const input = document.querySelector('[data-standalone-setting][value=planner]');
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('tf_cloud_file_options_v1')).not.toBeNull();
    document.defaultView.dispatchEvent(new Event('tf-factory-reset-started'));
    expect(localStorage.getItem('tf_cloud_file_options_v1')).toBeNull();
    f.controller.dispose();
  });
  it('ignores corrupt preferences and reports storage denial without preventing ordinary work', async () => {
    localStorage.setItem('tf_cloud_file_options_v1', '{broken');
    setup({ runtime: { encryptionStatus: () => 'unlocked' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('PRIVATE_STORAGE');
    });
    await click('check');
    expect(el('options-status').textContent).toContain('Не удалось запомнить');
    expect(el('encryption-status').textContent).toContain('повторный ввод пароля не нужен');
    expect(document.body.textContent).not.toContain('PRIVATE_STORAGE');
  });
  it.each([
    ['locked', 'Ключ закрыт'],
    ['not_created', 'При первом сохранении']
  ])('explains %s without showing or resetting a password', async (state, message) => {
    const f = setup({ runtime: { encryptionStatus: () => state } });
    await click('check');
    expect(el('encryption-status').textContent).toContain(message);
    expect(f.password).not.toHaveBeenCalled();
  });
});

describe('clear file options without comparison-time replacement consent', () => {
  it('shows privacy acknowledgements only for selected fields, resets them on scope changes', () => {
    setup();
    expect(el('consents').hidden).toBe(true);
    const email = document.querySelector('[data-standalone-private][value=email]');
    email.checked = true;
    email.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('consents').hidden).toBe(false);
    expect(el('password-risk-label').hidden).toBe(true);
    el('contacts-confirm').checked = true;
    const password = document.querySelector('[data-standalone-private][value=password]');
    password.checked = true;
    password.dispatchEvent(new Event('change', { bubbles: true }));
    expect(el('password-risk-label').hidden).toBe(false);
    expect(el('contacts-confirm').checked).toBe(false);
    el('select-none').click();
    expect(el('consents').hidden).toBe(true);
  });
  it('downloads and compares selected contacts/passwords without export or replacement consent, but blocks accepting them', async () => {
    const f = setup();
    for (const value of ['email', 'password']) {
      const input = document.querySelector(`[data-standalone-private][value=${value}]`);
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await compare();
    expect(f.runtime.review).toHaveBeenCalledWith(expect.objectContaining({ fields: ['email', 'password'] }));
    expect(el('contacts-confirm').checked).toBe(false);
    expect(el('password-risk').checked).toBe(false);
    el('accept').click();
    await vi.waitFor(() => expect(el('private-dialog').open).toBe(true));
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(f.runtime.save).not.toHaveBeenCalled();
    el('private-cancel').click();
    await vi.waitFor(() => expect(el('accept').disabled).toBe(false));
  });
  it('explains old Yandex authorization without hiding available legacy copies', async () => {
    setup({
      runtime: {
        check: vi.fn(async () => ({
          files: [file],
          results: [{ provider: 'yandex', status: 'checked', storageNotice: 'visible_permissions_required' }],
          pending: []
        }))
      }
    });
    await click('check');
    expect(el('provider-results').textContent).toContain('войдите в Яндекс заново');
    expect(el('files').querySelector('button').textContent).toBe('Скачать и сравнить');
  });
});

describe('cross-PC workspace redesign', () => {
  it('closes and reopens the same modal without declining, applying, uploading or downloading again', async () => {
    const f = setup();
    await compare();
    expect(el('review').open).toBe(true);
    expect(el('differences').querySelectorAll('.cloud-diff-card')).toHaveLength(3);
    el('review-close').click();
    expect(el('review').open).toBe(false);
    expect(el('reopen').hidden).toBe(false);
    el('reopen').click();
    expect(el('review').open).toBe(true);
    el('review').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(el('review').hidden).toBe(true);
    expect(f.runtime.review).toHaveBeenCalledOnce();
    expect(f.runtime.decline).not.toHaveBeenCalled();
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('does not cover the final replacement confirmation with a native modal, returns to review on cancellation', async () => {
    const confirm = vi.fn(async () => {
      expect(el('review').open).toBe(false);
      return false;
    });
    const f = setup({ confirm });
    await compare();
    await click('accept');
    expect(confirm).toHaveBeenCalledOnce();
    expect(el('review').open).toBe(true);
    expect(f.runtime.accept).not.toHaveBeenCalled();
  });
  it('requests selected private consent only at the action, never implicitly grants password risk', async () => {
    const f = setup();
    document.querySelector('[data-standalone-private][value=password]').checked = true;
    el('save').click();
    await vi.waitFor(() => expect(el('private-dialog').open).toBe(true));
    el('private-confirm').click();
    expect(f.runtime.prepareSave).not.toHaveBeenCalled();
    el('contacts-confirm').checked = true;
    el('private-confirm').click();
    expect(f.runtime.prepareSave).not.toHaveBeenCalled();
    el('password-risk').checked = true;
    el('private-confirm').click();
    await vi.waitFor(() => expect(el('save').disabled).toBe(false));
    expect(f.runtime.prepareSave).toHaveBeenCalledWith(
      expect.objectContaining({ contactsSourceConfirmed: true, acknowledgePasswordRisk: true, fields: ['password'] })
    );
    expect(f.runtime.save).toHaveBeenCalledOnce();
    expect(el('password-risk').checked).toBe(false);
  });
  it.each(['save', 'check'])(
    'shows immediate indeterminate progress and final result for %s, suppresses duplicate clicks',
    async kind => {
      const pending = Promise.withResolvers();
      const method = kind === 'save' ? 'prepareSave' : 'check';
      const f = setup({ runtime: { [method]: vi.fn(() => pending.promise) } });
      el(kind).click();
      await vi.waitFor(() => expect(f.runtime[method]).toHaveBeenCalledOnce());
      expect(el('operation').hidden).toBe(false);
      expect(el('operation').getAttribute('aria-busy')).toBe('true');
      expect(el('operation').querySelector('progress').hasAttribute('value')).toBe(false);
      el(kind).dispatchEvent(new Event('click'));
      expect(f.runtime[method]).toHaveBeenCalledOnce();
      if (kind === 'check')
        pending.resolve({
          files: [],
          unacceptedFiles: [],
          results: [{ provider: 'yandex', status: 'empty' }],
          pending: []
        });
      else pending.resolve({ results: [], remoteCopies: 0 });
      await vi.waitFor(() => expect(el(kind).disabled).toBe(false));
      expect(el('operation').querySelector('progress').hidden).toBe(true);
      expect(el('operation-message').textContent).toBe(el('status').textContent);
    }
  );
  it('shows a data-copy header badge only for unaccepted copies and opens the cloud section', async () => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<button id="cloud-copy-badge" hidden></button><button data-tab="settings"></button>'
    );
    const nav = vi.fn();
    document.querySelector('[data-tab=settings]').addEventListener('click', nav);
    const f = setup({
      runtime: {
        check: vi.fn(async () => ({
          files: [file],
          unacceptedFiles: [file],
          results: [
            { provider: 'google', status: 'checked' },
            { provider: 'yandex', status: 'checked' }
          ],
          pending: []
        }))
      }
    });
    await click('check');
    const badge = document.getElementById('cloud-copy-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.title).toContain('не обновление приложения');
    badge.click();
    expect(nav).toHaveBeenCalledOnce();
    expect(document.getElementById('cloud-registration-panel').open).toBe(true);
    f.runtime.check.mockResolvedValue({
      files: [file],
      unacceptedFiles: [],
      results: [
        { provider: 'google', status: 'checked' },
        { provider: 'yandex', status: 'checked' }
      ],
      pending: []
    });
    await click('check');
    expect(badge.hidden).toBe(true);
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('removes only the logged-out provider copies and notification without starting another cross-provider check', async () => {
    const f = setup();
    await click('check');
    window.dispatchEvent(new CustomEvent('tf-cloud-credential-removed', { detail: { provider: 'yandex' } }));
    expect(el('files').querySelectorAll('.cloud-copy-card')).toHaveLength(1);
    expect(el('files').textContent).toContain('Google Диск');
    expect(el('files').textContent).not.toContain('Яндекс Диск');
    expect(f.runtime.check).toHaveBeenCalledOnce();
  });
  it('persists disabled startup and reschedules an independent read-only interval, then cleans it up', async () => {
    localStorage.setItem('tf_cloud_auto_check_v1', JSON.stringify({ version: 1, startup: false, minutes: 0 }));
    const f = setup({ startup: true });
    expect(f.runtime.check).not.toHaveBeenCalled();
    vi.useFakeTimers();
    el('interval').value = '15';
    el('interval').dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(f.runtime.check).toHaveBeenCalledOnce();
    expect(f.runtime.save).not.toHaveBeenCalled();
    expect(f.runtime.accept).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('tf_cloud_auto_check_v1'))).toEqual({
      version: 1,
      startup: false,
      minutes: 15
    });
    f.controller.dispose();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(f.runtime.check).toHaveBeenCalledOnce();
    localStorage.removeItem('tf_cloud_auto_check_v1');
  });
});

it('keeps all IDs unique when legacy recovery is mounted alongside the new dialogs', () => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed
    .getElementById('cloud-registration-panel')
    .append(parsed.getElementById('cloud-legacy-template').content.cloneNode(true));
  const ids = [...parsed.querySelectorAll('[id]')].map(node => node.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
});
it('acknowledges identical copies on both providers in the header after keeping local data', async () => {
  document.body.insertAdjacentHTML('afterbegin', '<button id="cloud-copy-badge" hidden></button>');
  setup({
    runtime: {
      check: vi.fn(async () => ({
        files: [file],
        unacceptedFiles: [file],
        results: [
          { provider: 'google', status: 'checked' },
          { provider: 'yandex', status: 'checked' }
        ],
        pending: []
      }))
    }
  });
  await compare();
  expect(document.getElementById('cloud-copy-badge').hidden).toBe(false);
  await click('decline');
  expect(document.getElementById('cloud-copy-badge').hidden).toBe(true);
});

describe('Yandex folder assistant', () => {
  it('checks only the folder and creates an empty one only after a separate confirmation', async () => {
    const checkYandexFolder = vi
      .fn()
      .mockResolvedValueOnce({ status: 'folder_missing' })
      .mockResolvedValueOnce({ status: 'folder_created' });
    const f = setup({ runtime: { checkYandexFolder } });
    await click('yandex-folder-check');
    expect(checkYandexFolder).toHaveBeenCalledWith({ create: false });
    expect(el('yandex-folder-create').hidden).toBe(false);
    expect(f.runtime.check).not.toHaveBeenCalled();
    await click('yandex-folder-create');
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ okText: 'Создать пустую папку' }));
    expect(checkYandexFolder).toHaveBeenLastCalledWith({ create: true, confirmed: true });
    expect(el('yandex-folder-status').textContent).toContain('создана и проверена');
    expect(el('yandex-folder-create').hidden).toBe(true);
    expect(f.runtime.prepareSave).not.toHaveBeenCalled();
    expect(f.runtime.save).not.toHaveBeenCalled();
    expect(f.password).not.toHaveBeenCalled();
  });
  it('does not create on cancellation or retry an uncertain folder PUT automatically', async () => {
    const checkYandexFolder = vi.fn().mockResolvedValue({ status: 'folder_creation_unconfirmed' });
    const f = setup({ confirm: vi.fn(async () => false), runtime: { checkYandexFolder } });
    el('yandex-folder-create').hidden = false;
    await click('yandex-folder-create');
    expect(checkYandexFolder).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('отменено');
    await click('yandex-folder-check');
    expect(checkYandexFolder).toHaveBeenCalledOnce();
    expect(el('yandex-folder-create').hidden).toBe(true);
    expect(el('yandex-folder-help').textContent).toContain('Сначала проверьте');
    expect(f.runtime.save).not.toHaveBeenCalled();
  });
  it('shows actionable rights errors and exposes the existing sanitized report action', async () => {
    const checkYandexFolder = vi.fn(async () =>
      withCloudAccessDiagnostic({ status: 'folder_not_created' }, 'folder_forbidden')
    );
    setup({ runtime: { checkYandexFolder } });
    document.body.insertAdjacentHTML(
      'beforeend',
      '<details id="cloud-diagnostics-panel"><button id="cloud-diagnostics-copy"></button></details>'
    );
    const copied = vi.fn();
    document.getElementById('cloud-diagnostics-copy').addEventListener('click', copied);
    await click('yandex-folder-check');
    expect(el('yandex-folder-status').textContent).toContain('HTTP 403');
    expect(el('yandex-folder-help').textContent).toContain('старый токен');
    expect(el('copy-report').hidden).toBe(false);
    el('copy-report').click();
    expect(copied).toHaveBeenCalledOnce();
  });
  it('never labels a legacy pending receipt as a file saved to the ordinary root', async () => {
    setup({
      runtime: {
        save: vi.fn(async () => ({
          results: [{ provider: 'yandex', status: 'sent_verified', storageLocation: 'legacy' }]
        }))
      }
    });
    await click('save');
    expect(el('provider-results').textContent).toContain('прежний файл в папке приложения');
    expect(el('provider-results').textContent).not.toContain('Папка: Яндекс Диск → Твиноферма');
  });
  it('updates the ordinary folder hint only for a verified visible copy', async () => {
    setup({
      runtime: {
        save: vi.fn(async () => ({
          results: [{ provider: 'yandex', status: 'sent_verified', storageLocation: 'visible' }]
        }))
      }
    });
    await click('save');
    expect(el('provider-results').textContent).toContain('Папка: Яндекс Диск → Твиноферма');
    expect(el('yandex-folder-status').textContent).toContain('подтверждена обратным чтением');
  });
});

it('invalidates only the Yandex folder hint on logout/relogin without cross-provider requests', async () => {
  const f = setup({ runtime: { checkYandexFolder: vi.fn(async () => ({ status: 'folder_ready' })) } });
  await click('yandex-folder-check');
  window.dispatchEvent(new CustomEvent('tf-cloud-credential-removed', { detail: { provider: 'google' } }));
  expect(el('yandex-folder-status').textContent).toContain('найдена');
  window.dispatchEvent(new CustomEvent('tf-cloud-credential-removed', { detail: { provider: 'yandex' } }));
  expect(el('yandex-folder-status').textContent).toContain('после входа');
  expect(el('yandex-folder-create').hidden).toBe(true);
  expect(el('yandex-folder-status').parentElement.dataset.state).toBe('idle');
  expect(f.runtime.check).not.toHaveBeenCalled();
  expect(f.runtime.checkYandexFolder).toHaveBeenCalledOnce();
});
it('schedules custom minutes, refuses values below 15, and stops polling in manual mode', async () => {
  localStorage.setItem('tf_cloud_auto_check_v1', JSON.stringify({ version: 1, startup: false, minutes: 0 }));
  vi.useFakeTimers();
  const f = setup({ startup: true });
  expect([...el('interval').options].map(o => o.value)).toEqual(['0', '15', '30', '60', 'custom']);
  el('interval').value = 'custom';
  el('custom-interval').value = '17';
  el('interval').dispatchEvent(new Event('change'));
  expect(el('custom-interval-label').hidden).toBe(false);
  await vi.advanceTimersByTimeAsync(17 * 60000);
  expect(f.runtime.check).toHaveBeenCalledOnce();
  el('custom-interval').value = '14';
  el('custom-interval').dispatchEvent(new Event('change'));
  expect(JSON.parse(localStorage.getItem('tf_cloud_auto_check_v1')).minutes).toBe(17);
  expect(el('status').textContent).toContain('15');
  el('interval').value = '0';
  el('interval').dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(120 * 60000);
  expect(f.runtime.check).toHaveBeenCalledOnce();
  expect(el('custom-interval-label').hidden).toBe(true);
  expect(f.runtime.save).not.toHaveBeenCalled();
  expect(f.runtime.accept).not.toHaveBeenCalled();
});

it('keeps one independent dropdown per drive and downloads the selected older version, not latest', async () => {
  const older = {
    ...file,
    versionId: '22222222-2222-4222-8222-222222222222',
    sha256: 'b'.repeat(64),
    locations: file.locations.map(location => ({ ...location, modifiedAt: '2026-10-30T10:00:00Z' }))
  };
  const f = setup({ runtime: { check: vi.fn(async () => ({ files: [file, older], pending: [], results: [] })) } });
  await click('check');
  const cards = [...el('files').querySelectorAll('.cloud-copy-card')];
  expect(cards).toHaveLength(2);
  const google = cards[0].querySelector('select');
  const yandex = cards[1].querySelector('select');
  expect(google.options).toHaveLength(2);
  expect(yandex.options).toHaveLength(2);
  google.value = older.versionId;
  google.dispatchEvent(new Event('change', { bubbles: true }));
  expect(yandex.value).toBe(versionId);
  expect(google.selectedOptions[0].textContent).toMatch(/30\.10\.2026.*22222222/);
  cards[0].querySelector('button').click();
  await vi.waitFor(() => expect(f.runtime.review).toHaveBeenCalled());
  expect(f.runtime.review.mock.calls[0][0]).toMatchObject({
    provider: 'google',
    versionId: older.versionId,
    sha256: older.sha256
  });
});
it('keeps only key and auto-check settings in extras, with checks/results on the main page', () => {
  setup();
  expect(el('key-dialog').contains(el('startup'))).toBe(true);
  expect(el('key-dialog').contains(el('interval'))).toBe(true);
  expect(el('key-dialog').contains(el('files'))).toBe(false);
  expect(el('key-dialog').contains(el('check'))).toBe(false);
  for (const key of ['status', 'provider-results', 'files', 'reopen', 'operation', 'last-check'])
    expect(el('key-dialog').contains(el(key))).toBe(false);
  const help = [...el('panel').querySelectorAll('details')].find(
    item => item.querySelector('summary')?.textContent === 'Чем отличаются эти варианты?'
  );
  expect(help.closest('.cloud-source-card')).toBeNull();
});
it('opens a read-only diff but never enables replacement when strict schema/roundtrip checks refuse it', async () => {
  const f = setup({
    runtime: {
      review: vi.fn(async () => ({
        ...token(),
        replacementBlocked: 'setup/identities/roundtrip.dependencies.characters/reference'
      }))
    }
  });
  await click('check');
  el('files').querySelector('button').click();
  await vi.waitFor(() => expect(el('review-status').textContent).toContain('Сравнение только для чтения'));
  await vi.waitFor(() => expect(el('panel').getAttribute('aria-busy')).toBe('false'));
  expect(el('accept').disabled).toBe(true);
  el('accept').click();
  expect(f.runtime.accept).not.toHaveBeenCalled();
});

it('defaults to non-deleting reconciliation; explicit field choice and confirmation never call full replacement', async () => {
  const t = token();
  t.characterUpdates = {
    locals: [{ id: 'local', nick: 'Первый', fields: { level: 10 } }],
    records: [
      { id: 'cloud', nick: 'Первый', fields: { level: 20 }, matchedLocalId: 'local', suggestedLocalIds: ['local'] }
    ]
  };
  const f = setup({
    runtime: { review: vi.fn(async () => t), updateCharacters: vi.fn(async () => ({ status: 'applied' })) }
  });
  await compare();
  expect(el('character-updates').hidden).toBe(false);
  expect(el('full-replacement').open).toBe(false);
  expect(el('accept').closest('details')).toBe(el('full-replacement'));
  const apply = el('character-updates').querySelector('[data-character-update-apply]');
  expect(apply.disabled).toBe(true);
  el('character-updates').querySelector('input[value="level"]').click();
  el('character-updates').querySelector('[data-character-update-ack]').click();
  apply.click();
  await vi.waitFor(() =>
    expect(f.runtime.updateCharacters).toHaveBeenCalledWith(t, {
      confirmed: true,
      selections: [{ cloudId: 'cloud', localId: 'local', fields: ['level'] }]
    })
  );
  await vi.waitFor(() => expect(el('review').hidden).toBe(true));
  expect(f.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Обновить только выбранные поля персонажей?' })
  );
  expect(f.runtime.accept).not.toHaveBeenCalled();
  expect(f.runtime.save).not.toHaveBeenCalled();
  expect(el('status').textContent).toContain('Никто не удалён');
});
it('cancelling selective confirmation restores the comparison and resets acknowledgment without writing', async () => {
  const t = token();
  t.characterUpdates = {
    locals: [{ id: 'local', nick: 'Первый', fields: { level: 10 } }],
    records: [
      { id: 'cloud', nick: 'Первый', fields: { level: 20 }, matchedLocalId: 'local', suggestedLocalIds: ['local'] }
    ]
  };
  const f = setup({
    confirm: vi.fn(async () => false),
    runtime: { review: vi.fn(async () => t), updateCharacters: vi.fn() }
  });
  await compare();
  const host = el('character-updates');
  host.querySelector('input[value="level"]').click();
  host.querySelector('[data-character-update-ack]').click();
  host.querySelector('button').click();
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled());
  await vi.waitFor(() => expect(host.querySelector('[data-character-update-ack]').checked).toBe(false));
  expect(el('review').hidden).toBe(false);
  expect(f.runtime.updateCharacters).not.toHaveBeenCalled();
  expect(f.runtime.accept).not.toHaveBeenCalled();
});

it('private differences name their associated character and human field, without implying consent or revealing values', async () => {
  const t = token();
  t.privateChanges = [{ label: 'Мой персонаж', field: 'password', clears: false }];
  setup({ runtime: { review: vi.fn(async () => t) } });
  await compare();
  expect(el('review').textContent).toContain('Мой персонаж — Пароль');
  expect(el('review').textContent).toContain('перенос требует отдельного выбора и подтверждения');
  expect(el('review').textContent).not.toContain('Приватное поле password');
});
