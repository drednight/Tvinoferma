// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCloudRegistrationCheck } from '../js/modules/cloudSync/ui/registrationCheckPanel.js';

const html = readFileSync('index.html', 'utf8');
const source = html.match(/<details class="panel fold cloud-registration"[\s\S]*?<\/details>/)?.[0];
const clientId = '0123456789abcdef0123456789abcdef';
function byId(id) {
  return document.getElementById(`cloud-registration-${id}`);
}
function submit() {
  byId('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function bind(extra = {}) {
  const invoke = vi.fn();
  const openBrowser = vi.fn();
  const loadNative = vi.fn(async () => ({ invoke, openBrowser }));
  const check = vi.fn(async () => ({
    status: 'checked',
    scope: 'request_bound',
    label: { kind: 'login', value: 'fake-login' }
  }));
  bindCloudRegistrationCheck({ doc: document, desktop: true, loadNative, check, ...extra });
  return { invoke, openBrowser, loadNative: extra.loadNative || loadNative, check: extra.check || check };
}
beforeEach(() => {
  expect(source).toBeTruthy();
  document.body.innerHTML = `<main>${source}</main>`;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('демо показывает состояние реализации без подключения', () => {
  it('отдельный пример свёрнут, поле и кнопки отключены, сетевая политика демо не ослаблена', () => {
    const demoHtml = readFileSync('demo/app/index.html', 'utf8');
    const preview = demoHtml.match(
      /<details class="panel fold cloud-registration" id="demo-registration-preview"[\s\S]*?<\/details>/
    )?.[0];
    expect(preview).toBeTruthy();
    document.body.innerHTML = `<main>${preview}</main>`;
    expect(document.getElementById('demo-registration-preview').open).toBe(false);
    expect(document.getElementById('demo-registration-preview').textContent).toContain('Здесь только пример');
    expect(document.getElementById('demo-registration-client').disabled).toBe(true);
    expect(document.getElementById('demo-registration-provider').disabled).toBe(true);
    expect([...document.querySelectorAll('#demo-registration-preview button')].every(button => button.disabled)).toBe(
      true
    );
    expect(document.querySelector('#demo-registration-preview form')).toBeNull();
    expect(demoHtml).toContain("connect-src 'none'");
  });
});

describe('настоящие настройки: только диагностика, не синхронизация', () => {
  it('свёрнута по умолчанию, содержит предупреждения и отдельные отключённые будущие действия', () => {
    const s = bind();
    expect(byId('panel').open).toBe(false);
    expect(byId('panel').textContent).toContain('Синхронизация пока не работает');
    expect(byId('panel').textContent).toContain('не сохраняет токены');
    expect(byId('panel').textContent).toContain('сохранить выданное разрешение');
    expect(byId('client-hint').textContent).toContain('не Client Secret');
    expect(byId('yandex-hint').hidden).toBe(false);
    expect(byId('yandex-hint').textContent).toContain('http://127.0.0.1:37181/oauth/cloud/callback');
    expect(byId('yandex-hint').textContent).toContain('cloud_api:disk.app_folder');
    expect(byId('google-hint').hidden).toBe(true);
    const future = document.querySelectorAll('.cloud-registration-future button');
    expect([...future].map(button => button.textContent)).toEqual(['Отправить на диск', 'Проверить обновления']);
    expect([...future].every(button => button.disabled)).toBe(true);
    expect(byId('cancel').hidden).toBe(true);
    expect(s.loadNative).not.toHaveBeenCalled();
  });

  it('браузер не вызывает native и честно сообщает о недоступности', () => {
    const s = bind({ desktop: false });
    expect(byId('start').disabled).toBe(true);
    expect(byId('status').textContent).toContain('только в настольном приложении');
    byId('client').value = clientId;
    submit();
    expect(s.loadNative).not.toHaveBeenCalled();
    expect(s.check).not.toHaveBeenCalled();
  });

  it('не принимает пароль/секрет вместо публичного ID и не сохраняет ввод', () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const s = bind();
    byId('client').value = 'this is NOT a client secret';
    submit();
    expect(byId('status').textContent).toContain('Проверьте формат');
    expect(s.loadNative).not.toHaveBeenCalled();
    expect(s.check).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  });

  it('показывает результат и метку только текстом; при смене диска очищает её', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const s = bind();
    byId('client').value = ` ${clientId} `;
    submit();
    await vi.waitFor(() => expect(byId('account').hidden).toBe(false));
    expect(s.check).toHaveBeenCalledTimes(1);
    expect(s.check.mock.calls[0][0]).toMatchObject({ provider: 'yandex', clientId });
    expect(byId('account-value').textContent).toBe('fake-login');
    expect(byId('account-value').tagName).toBe('BDI');
    expect(byId('status').textContent).toContain('Доступ к файлам не проверялся');
    expect(byId('status').textContent).toContain('диск не подключён');
    expect(storage).not.toHaveBeenCalled();
    byId('provider').value = 'google';
    byId('provider').dispatchEvent(new Event('change', { bubbles: true }));
    expect(byId('account').hidden).toBe(true);
    expect(byId('account-value').textContent).toBe('');
    expect(byId('yandex-hint').hidden).toBe(true);
    expect(byId('google-hint').hidden).toBe(false);
    expect(byId('google-hint').textContent).toContain('Desktop app');
    expect(byId('google-hint').textContent).toContain('https://www.googleapis.com/auth/drive.file');
  });

  it('не превращает переданную метку в HTML даже если тестовый backend повреждён', async () => {
    const check = vi.fn(async () => ({
      status: 'checked',
      scope: 'reported',
      label: { kind: 'login', value: '<img src=x onerror=alert(1)>' }
    }));
    bind({ check });
    byId('client').value = clientId;
    submit();
    await vi.waitFor(() => expect(byId('account').hidden).toBe(false));
    expect(byId('account-value').querySelector('img')).toBeNull();
    expect(byId('account-value').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('честно показывает неподтверждённые права и отсутствие метки', async () => {
    bind({ check: vi.fn(async () => ({ status: 'checked', scope: 'unverified', label: null })) });
    byId('client').value = clientId;
    submit();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('права не удалось подтвердить'));
    expect(byId('status').textContent).toContain('не сообщил отображаемую метку');
    expect(byId('account').hidden).toBe(true);
  });

  it('отмена блокирует повторный запуск и не показывает поздний результат', async () => {
    const gate = deferred();
    let signal;
    const s = bind({
      check: vi.fn(input => {
        signal = input.signal;
        return gate.promise;
      })
    });
    byId('client').value = clientId;
    submit();
    await vi.waitFor(() => expect(s.check).toHaveBeenCalledTimes(1));
    expect(byId('start').disabled).toBe(true);
    expect(byId('cancel').hidden).toBe(false);
    submit();
    expect(s.check).toHaveBeenCalledTimes(1);
    byId('cancel').click();
    expect(signal.aborted).toBe(true);
    expect(byId('status').textContent).toContain('сервис мог сохранить разрешение');
    gate.resolve({ status: 'checked', scope: 'reported', label: { kind: 'login', value: 'late-result' } });
    await vi.waitFor(() => expect(byId('start').disabled).toBe(false));
    expect(byId('account').hidden).toBe(true);
    expect(byId('panel').textContent).not.toContain('late-result');
  });

  it('ошибка загрузки нативного моста не раскрывает исходное сообщение', async () => {
    bind({
      loadNative: vi.fn(async () => {
        throw new Error('PRIVATE_ERROR');
      })
    });
    byId('client').value = clientId;
    submit();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('Не удалось запустить'));
    expect(byId('panel').textContent).not.toContain('PRIVATE_ERROR');
    expect(byId('start').disabled).toBe(false);
  });
});
