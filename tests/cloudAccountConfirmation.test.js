// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createCloudAccountConfirmation } from '../js/modules/cloudSync/ui/confirmCloudAccount.js';
import { createGoogleEnrollmentAttempt } from '../js/modules/cloudSync/providers/oauthCredentialEnrollment.js';

const googleClient = '123456789-test_client.apps.googleusercontent.com';
const yandexClient = '0123456789abcdef0123456789abcdef';
const accountKey = 'FAKE_PRIVATE_ACCOUNT_123';
const access = 'FAKE_PRIVATE_ACCESS_123';
const refresh = 'FAKE_PRIVATE_REFRESH_123';
const email = 'fake_private+account@example.test';
const login = 'fake.private-login_123';
const googleLabel = Object.freeze({ kind: 'email', value: email });
let controllers;
let originalShow;
let originalClose;
let originalMatches;

function controller() {
  const item = new AbortController();
  controllers.push(item);
  return item;
}
function args(overrides = {}) {
  return { provider: 'google', clientId: googleClient, label: googleLabel, signal: controller().signal, ...overrides };
}
function current() {
  return document.querySelector('dialog.tf-cloud-account-dialog');
}
function acknowledge(dialog = current()) {
  const checkbox = dialog.querySelector('[data-cloud-account-ack]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}
function simulatedTokenLease() {
  return {
    summary: {
      provider: 'google',
      operation: 'code',
      expiresAt: 3_700_000,
      refreshExpiresAt: null,
      refreshAvailable: true,
      scope: 'reported'
    },
    takeSecrets: () => ({ accessToken: access, refreshToken: refresh }),
    discard: () => {}
  };
}

beforeEach(() => {
  controllers = [];
  document.body.innerHTML = '<button id="opener">Открыть пример</button><main id="app"></main>';
  document.getElementById('opener').focus();
  // jsdom не предоставляет настоящий top layer. Это только имитация API;
  // поведение showModal, клавиатуры и inert дополнительно проверяется в Chromium.
  originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  originalMatches = Element.prototype.matches;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
      this.__testModal = true;
      this.querySelector('[autofocus]')?.focus();
    }
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false;
      this.__testModal = false;
      this.dispatchEvent(new Event('close'));
    }
  });
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector) {
    if (selector === ':modal') return this.tagName === 'DIALOG' && this.open && this.__testModal === true;
    return originalMatches.call(this, selector);
  });
  // jsdom не вычисляет геометрию: имитируем видимую метку и область прокрутки.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.matches('[data-cloud-account-label], .tf-cloud-account-body')) return new DOMRect(10, 10, 200, 100);
    return rect.call(this);
  });
});

afterEach(async () => {
  for (const item of controllers) item.abort();
  await Promise.resolve();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else delete HTMLDialogElement.prototype.showModal;
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else delete HTMLDialogElement.prototype.close;
});

describe('отключённое окно сверки учётной записи', () => {
  it('показывает всю метку текстом и сначала выбирает отмену; согласие требует отдельной галочки', async () => {
    const confirm = createCloudAccountConfirmation();
    const pending = confirm(args());
    const dialog = current();
    const value = dialog.querySelector('[data-cloud-account-label]');
    const checkbox = dialog.querySelector('[data-cloud-account-ack]');
    const ok = dialog.querySelector('[data-cloud-account-confirm]');
    const cancel = dialog.querySelector('[data-cloud-account-cancel]');
    expect(dialog.matches(':modal')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toContain('Google Диска');
    expect(dialog.getAttribute('aria-describedby')).toContain('account');
    expect(value.textContent).toBe(email);
    expect(value.tagName).toBe('BDI');
    expect(value.getAttribute('dir')).toBe('ltr');
    expect(dialog.textContent).toContain('системном браузере');
    expect(dialog.textContent).toContain('Если она отличается');
    expect(dialog.textContent).not.toContain(access);
    expect(dialog.textContent).not.toContain(accountKey);
    expect(checkbox.checked).toBe(false);
    expect(ok.disabled).toBe(true);
    expect(document.activeElement).toBe(cancel);
    ok.click();
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    acknowledge(dialog);
    expect(ok.disabled).toBe(false);
    ok.click();
    await expect(pending).resolves.toBe(true);
    expect(current()).toBeNull();
    expect(value.textContent).toBe('');
    expect(document.body.textContent).not.toContain(email);
  });

  it('безопасно показывает символы в email как текст, не как HTML или атрибут', async () => {
    const label = { kind: 'email', value: "user&tag+foo'bar@example.test" };
    const pending = createCloudAccountConfirmation()(args({ label }));
    const dialog = current();
    const value = dialog.querySelector('[data-cloud-account-label]');
    expect(value.textContent).toBe(label.value);
    expect(value.innerHTML).toContain('&amp;');
    expect(value.children).toHaveLength(0);
    expect(
      [...dialog.querySelectorAll('*')].every(node =>
        [...node.attributes].every(attr => !attr.value.includes(label.value))
      )
    ).toBe(true);
    dialog.querySelector('[data-cloud-account-cancel]').click();
    await expect(pending).resolves.toBe(false);
  });

  it('длинную корректную метку не сокращает и не подменяет', async () => {
    const longEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(longEmail.length).toBe(254);
    const pending = createCloudAccountConfirmation()(args({ label: { kind: 'email', value: longEmail } }));
    const value = current().querySelector('[data-cloud-account-label]');
    expect(value.textContent).toBe(longEmail);
    expect(value.textContent).not.toContain('…');
    current().querySelector('[data-cloud-account-cancel]').click();
    await expect(pending).resolves.toBe(false);
  });

  it('показывает логин Яндекса именно как логин и явно помечает пример', async () => {
    const confirm = createCloudAccountConfirmation({ example: true });
    const pending = confirm(
      args({ provider: 'yandex', clientId: yandexClient, label: { kind: 'login', value: login } })
    );
    const dialog = current();
    expect(dialog.textContent).toContain('ВЫМЫШЛЕННЫЙ ПРИМЕР');
    expect(dialog.textContent).toContain('никакой аккаунт не подключится');
    expect(dialog.textContent).toContain('Логин аккаунта Яндекса');
    expect(dialog.querySelector('[data-cloud-account-label]').textContent).toBe(login);
    expect(dialog.textContent).not.toContain(`${login}@`);
    acknowledge(dialog);
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).resolves.toBe(true);
  });

  it.each([
    [null],
    [{ kind: 'login', value: 'not-an-email' }],
    [{ kind: 'email', value: 'fake@example.test\u202eATTACK' }],
    [{ kind: 'email', value: '<img src=x>@example.test' }],
    [{ kind: 'email', value: email, extra: access }]
  ])('не открывает окно при отсутствующей или неподходящей метке: %#', async label => {
    const pending = createCloudAccountConfirmation()(args({ label }));
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBeNull();
  });

  it('не исполняет getter метки и не принимает лишние данные, в том числе токены', async () => {
    const getter = vi.fn(() => email);
    const suspicious = { kind: 'email' };
    Object.defineProperty(suspicious, 'value', { enumerable: true, get: getter });
    await expect(createCloudAccountConfirmation()(args({ label: suspicious }))).rejects.toThrow(
      'Не удалось подтвердить'
    );
    expect(getter).not.toHaveBeenCalled();
    await expect(createCloudAccountConfirmation()(args({ accessToken: access }))).rejects.toThrow(
      'Не удалось подтвердить'
    );
    await expect(createCloudAccountConfirmation()(args({ provider: 'other' }))).rejects.toThrow(
      'Не удалось подтвердить'
    );
    await expect(createCloudAccountConfirmation()(args({ clientId: 'bad' }))).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBeNull();
  });

  it('не делает fallback на немодальное окно, если showModal или :modal недоступны', async () => {
    delete HTMLDialogElement.prototype.showModal;
    await expect(createCloudAccountConfirmation()(args())).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBeNull();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.open = true;
        this.__testModal = false;
      }
    });
    await expect(createCloudAccountConfirmation()(args())).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBeNull();
  });

  it('скрывает детали ошибки открытия, не вызывает сеть, журналы или хранилища', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const fetch = vi.spyOn(globalThis, 'fetch');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        throw new Error(`PRIVATE_ERROR ${email} ${access}`);
      }
    });
    let message;
    try {
      await createCloudAccountConfirmation()(args());
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('Не удалось подтвердить');
    for (const secret of [email, access, 'PRIVATE_ERROR']) expect(message).not.toContain(secret);
    expect(current()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('при ошибке закрытия не выдаёт успех и всё равно очищает метку и DOM', async () => {
    const confirm = createCloudAccountConfirmation();
    const pending = confirm(args());
    const dialog = current();
    const value = dialog.querySelector('[data-cloud-account-label]');
    acknowledge(dialog);
    Object.defineProperty(dialog, 'close', {
      configurable: true,
      value() {
        throw new Error(`private ${email}`);
      }
    });
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    expect(dialog.isConnected).toBe(false);
    expect(value.textContent).toBe('');
    const next = confirm(args());
    current().querySelector('[data-cloud-account-cancel]').click();
    await expect(next).resolves.toBe(false);
  });

  it('Esc и явная отмена возвращают false и освобождают слот', async () => {
    const confirm = createCloudAccountConfirmation();
    const first = confirm(args());
    const event = new Event('cancel', { bubbles: false, cancelable: true });
    current().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await expect(first).resolves.toBe(false);
    expect(current()).toBeNull();
    const second = confirm(args());
    current().querySelector('[data-cloud-account-cancel]').click();
    await expect(second).resolves.toBe(false);
  });

  it('отмена signal убирает окно и не даёт позднему нажатию подтвердить', async () => {
    const signal = controller();
    const confirm = createCloudAccountConfirmation();
    const pending = confirm(args({ signal: signal.signal }));
    const dialog = current();
    acknowledge(dialog);
    const ok = dialog.querySelector('[data-cloud-account-confirm]');
    signal.abort();
    expect(current()).toBeNull();
    ok.click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    const second = confirm(args());
    current().querySelector('[data-cloud-account-cancel]').click();
    await expect(second).resolves.toBe(false);
  });

  it('уже отменённый или поддельный signal не открывает окно', async () => {
    const cancelled = controller();
    cancelled.abort();
    await expect(createCloudAccountConfirmation()(args({ signal: cancelled.signal }))).rejects.toThrow();
    const fake = { aborted: false, addEventListener() {}, removeEventListener() {} };
    await expect(createCloudAccountConfirmation()(args({ signal: fake }))).rejects.toThrow();
    expect(current()).toBeNull();
  });

  it('несколько factory не показывают одновременно разные аккаунты в одном документе', async () => {
    const first = createCloudAccountConfirmation()(args());
    const dialog = current();
    const second = createCloudAccountConfirmation()(args({ label: { kind: 'email', value: 'another@example.test' } }));
    await expect(second).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBe(dialog);
    expect(dialog.querySelector('[data-cloud-account-label]').textContent).toBe(email);
    dialog.querySelector('[data-cloud-account-cancel]').click();
    await expect(first).resolves.toBe(false);
    const third = createCloudAccountConfirmation()(args());
    current().querySelector('[data-cloud-account-cancel]').click();
    await expect(third).resolves.toBe(false);
  });

  it('не подтверждает изменённую или удалённую метку, даже до обработки MutationObserver', async () => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    acknowledge(dialog);
    const value = dialog.querySelector('[data-cloud-account-label]');
    value.textContent = 'other@example.test';
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBeNull();
  });

  it.each([
    [
      'display:none',
      node => {
        node.style.display = 'none';
      }
    ],
    [
      'visibility:hidden',
      node => {
        node.style.visibility = 'hidden';
      }
    ],
    [
      'opacity:0',
      node => {
        node.style.opacity = '0';
      }
    ],
    [
      'aria-hidden',
      node => {
        node.setAttribute('aria-hidden', 'true');
      }
    ],
    [
      'ellipsis',
      node => {
        node.style.textOverflow = 'ellipsis';
      }
    ],
    [
      'nowrap',
      node => {
        node.style.whiteSpace = 'nowrap';
      }
    ]
  ])('блокирует скрытую или обрезанную метку: %s', async (_name, hide) => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    acknowledge(dialog);
    hide(dialog.querySelector('[data-cloud-account-label]'));
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    expect(current()).toBeNull();
  });

  it('не принимает вертикально обрезанную метку', async () => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    acknowledge(dialog);
    const value = dialog.querySelector('[data-cloud-account-label]');
    Object.defineProperty(value, 'clientHeight', { value: 20 });
    Object.defineProperty(value, 'scrollHeight', { value: 50 });
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
  });

  it('при изменении инструкции или структуры метки не считает старое согласие действительным', async () => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    acknowledge(dialog);
    dialog.querySelector('.tf-cloud-account-body p').textContent = 'Подтверждение не требуется';
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    const next = createCloudAccountConfirmation()(args());
    const value = current().querySelector('[data-cloud-account-label]');
    const span = document.createElement('span');
    span.textContent = email;
    value.replaceChildren(span);
    await expect(next).rejects.toThrow('Не удалось подтвердить');
  });

  it('просит прокрутить метку в видимую область, если её нет на экране', async () => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    const value = dialog.querySelector('[data-cloud-account-label]');
    const bounds = vi.spyOn(value, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, -200, 200, 100));
    acknowledge(dialog);
    dialog.querySelector('[data-cloud-account-confirm]').click();
    expect(current()).toBe(dialog);
    expect(dialog.querySelector('[role="status"]').hidden).toBe(false);
    expect(dialog.textContent).toContain('Прокрутите окно');
    bounds.mockReturnValue(new DOMRect(10, 10, 200, 100));
    dialog.querySelector('[data-cloud-account-confirm]').click();
    await expect(pending).resolves.toBe(true);
  });

  it('отмена при удалении окна из документа не оставляет устаревшее подтверждение', async () => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    dialog.remove();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
    expect(dialog.querySelector('[data-cloud-account-label]').textContent).toBe('');
  });

  it('повторно проверяет галочку и модальность при нажатии', async () => {
    const pending = createCloudAccountConfirmation()(args());
    const dialog = current();
    const checkbox = dialog.querySelector('[data-cloud-account-ack]');
    const ok = dialog.querySelector('[data-cloud-account-confirm]');
    acknowledge(dialog);
    checkbox.checked = false;
    ok.click();
    expect(current()).toBe(dialog);
    checkbox.checked = true;
    dialog.__testModal = false;
    ok.click();
    await expect(pending).rejects.toThrow('Не удалось подтвердить');
  });

  it('с fake-enrollment получает только метку и не устанавливает до явного подтверждения', async () => {
    const installer = { installIfAbsent: vi.fn(async () => 'installed'), verifyInstallation: vi.fn(async () => true) };
    const previewAccount = vi.fn(async () => ({ accountKey, label: googleLabel }));
    const attempt = createGoogleEnrollmentAttempt({
      clientId: googleClient,
      tokenResponse: simulatedTokenLease(),
      previewAccount,
      confirmAccount: createCloudAccountConfirmation(),
      installer,
      cryptoSource: webcrypto,
      now: () => 100_000
    });
    const pending = attempt.complete();
    await vi.waitFor(() => expect(current()).not.toBeNull());
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(access);
    expect(document.body.textContent).not.toContain(refresh);
    expect(document.body.textContent).not.toContain(accountKey);
    acknowledge();
    current().querySelector('[data-cloud-account-confirm]').click();
    expect(await pending).toEqual({ status: 'installed' });
    expect(previewAccount).toHaveBeenCalledTimes(2);
    expect(installer.installIfAbsent).toHaveBeenCalledOnce();
    expect(JSON.stringify(installer.installIfAbsent.mock.calls[0])).not.toContain(email);
    expect(document.body.textContent).not.toContain(email);
  });

  it('отмена enrollment закрывает окно и не вызывает installer', async () => {
    const installer = { installIfAbsent: vi.fn(async () => 'installed'), verifyInstallation: vi.fn(async () => true) };
    const attempt = createGoogleEnrollmentAttempt({
      clientId: googleClient,
      tokenResponse: simulatedTokenLease(),
      previewAccount: async () => ({ accountKey, label: googleLabel }),
      confirmAccount: createCloudAccountConfirmation(),
      installer,
      cryptoSource: webcrypto,
      now: () => 100_000
    });
    const pending = attempt.complete();
    await vi.waitFor(() => expect(current()).not.toBeNull());
    const dialog = current();
    acknowledge(dialog);
    const ok = dialog.querySelector('[data-cloud-account-confirm]');
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(current()).toBeNull();
    ok.click();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });
});
