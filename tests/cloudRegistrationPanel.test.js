import { legacyAccessHtml } from './helpers/legacyAccessHtml.js';
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCloudRegistrationCheck } from '../js/modules/cloudSync/ui/registrationCheckPanel.js';

const html = legacyAccessHtml(readFileSync('index.html', 'utf8'));
const source = new DOMParser().parseFromString(html, 'text/html').getElementById('cloud-registration-panel')?.outerHTML;
const clientId = '0123456789abcdef0123456789abcdef';
function byId(id) {
  return document.getElementById(id === 'provider' ? 'cloud-login-provider' : `cloud-registration-${id}`);
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
  const readBinding = vi.fn(async () => ({ status: 'empty' }));
  const readDataset = vi.fn(async () => 'empty');
  const enroll = vi.fn(async () => ({ status: 'installed' }));
  const forget = vi.fn(async () => 'forgotten');
  const confirmAccount = vi.fn(async () => true);
  bindCloudRegistrationCheck({
    doc: document,
    desktop: true,
    loadNative,
    check,
    readBinding,
    readDataset,
    enroll,
    forget,
    confirmAccount,
    ...extra
  });
  return {
    invoke,
    openBrowser,
    loadNative: extra.loadNative || loadNative,
    check: extra.check || check,
    readBinding: extra.readBinding || readBinding,
    readDataset: extra.readDataset || readDataset,
    enroll: extra.enroll || enroll,
    forget: extra.forget || forget,
    confirmAccount: extra.confirmAccount || confirmAccount
  };
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
    const preview = new DOMParser()
      .parseFromString(demoHtml, 'text/html')
      .getElementById('demo-registration-preview')?.outerHTML;
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

describe('настоящие настройки: диагностика, доступ и экспериментальный обмен файлами', () => {
  it('свёрнута по умолчанию, содержит предупреждения и отдельную экспериментальную отправку', () => {
    const s = bind();
    expect(byId('panel').open).toBe(false);
    expect(byId('panel').textContent).toContain('Обмен файлами — экспериментальный режим');
    expect(byId('panel').textContent).toContain(
      'Отсутствующие записи удаляются только при явно подтверждённой полной замене'
    );
    expect(byId('panel').textContent).toContain('Прежние облачные версии сохраняются');
    expect(byId('panel').textContent).toContain(
      'Несколько одновременных облачных версий автоматически не объединяются'
    );
    expect(byId('panel').textContent).toContain('Настоящие диски и два Windows-ПК ещё требуют приёмки');
    expect(document.getElementById('cloud-standalone-check')).toBeTruthy();
    expect(document.getElementById('cloud-standalone-save')).toBeTruthy();
    expect(document.getElementById('cloud-legacy-exchange')).toBeNull();
    expect(byId('panel').textContent).toContain('не сохраняет токены');
    expect(byId('panel').textContent).toContain('сохранить выданное разрешение');
    expect(byId('client-hint').textContent).toContain('не Client Secret');
    expect(byId('yandex-hint').hidden).toBe(false);
    expect(byId('yandex-hint').textContent).toContain('http://127.0.0.1:37181/oauth/cloud/callback');
    expect(byId('yandex-hint').textContent).toContain('cloud_api:disk.app_folder');
    expect(byId('google-hint').hidden).toBe(true);
    expect(document.getElementById('cloud-publication-send')).toBeNull();
    expect(document.getElementById('cloud-publication-auto')).toBeNull();
    expect(document.getElementById('cloud-review-check')).toBeNull();
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
    expect(byId('status').textContent).toContain('не сохраняет и не изменяет доступ');
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

const SLOT = '01234567-89ab-4cde-8f01-23456789abcd';
const PRIVATE = 'FAKE_PRIVATE_TOKEN_OR_ACCOUNT';
function connection(id) {
  return document.getElementById(`cloud-connection-${id}`);
}
function ready() {
  return { status: 'ready', binding: { slotId: SLOT, clientId, accountKey: PRIVATE } };
}
async function inspectConnection() {
  connection('inspect').click();
  await vi.waitFor(() => expect(connection('inspect').disabled).toBe(false));
}
function approveInput(id) {
  const control = connection(id);
  expect(control.disabled).toBe(false);
  control.click();
}

describe('экспериментальный локальный доступ в настройках', () => {
  it('не начинает OAuth, пока не проверены обе локальные записи и пользователь явно не согласился', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const s = bind();
    expect(connection('start').disabled).toBe(true);
    connection('start').click();
    expect(s.readBinding).not.toHaveBeenCalled();
    expect(s.enroll).not.toHaveBeenCalled();
    await inspectConnection();
    expect(s.readBinding).toHaveBeenCalledOnce();
    expect(s.readDataset).toHaveBeenCalledOnce();
    expect(connection('local').textContent).toContain('не доказывает');
    expect(connection('start').disabled).toBe(true);
    approveInput('approve');
    expect(connection('start').disabled).toBe(false);
    byId('client').value = 'this is NOT a client secret';
    connection('start').click();
    expect(connection('progress').textContent).toContain('Проверьте формат');
    expect(s.enroll).not.toHaveBeenCalled();
    byId('client').value = ` ${clientId} `;
    connection('start').click();
    await vi.waitFor(() => expect(s.enroll).toHaveBeenCalledOnce());
    expect(s.enroll.mock.calls[0][0]).toMatchObject({
      provider: 'yandex',
      clientId,
      firstConnectionConfirmed: true,
      invoke: s.invoke,
      openBrowser: s.openBrowser,
      confirmAccount: s.confirmAccount
    });
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('Доступ сохранён'));
    expect(connection('progress').textContent).toContain('сохранить полный файл или проверить файлы другого ПК');
    expect(connection('progress').textContent).not.toContain('набор данных ещё нужно подключить');
    expect(connection('approve').checked).toBe(false);
    expect(storage).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it('при открытии проверяет локальные данные, а при смене диска требует новую проверку и новое согласие', async () => {
    const s = bind();
    byId('panel').open = true;
    await vi.waitFor(() => expect(s.readDataset).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(connection('approve').disabled).toBe(false));
    approveInput('approve');
    byId('provider').value = 'google';
    byId('provider').dispatchEvent(new Event('change'));
    expect(connection('approve').checked).toBe(false);
    expect(connection('start').disabled).toBe(true);
    await vi.waitFor(() => expect(s.readDataset).toHaveBeenCalledTimes(2));
    expect(s.readBinding.mock.calls[0][0].provider).toBe('yandex');
    expect(s.readBinding.mock.calls[1][0].provider).toBe('google');
    expect(connection('approve').disabled).toBe(false);
  });

  it.each([
    ['empty', 'ready', 'привязка набора без доступной'],
    ['empty', 'blocked', 'привязка набора без доступной'],
    ['ready', 'ready', 'Локальное удаление заблокировано'],
    ['ready', 'blocked', 'Локальное удаление заблокировано']
  ])('запрещает вход и удаление при account=%s, dataset=%s', async (account, dataset, message) => {
    const s = bind({
      readBinding: vi.fn(async () => (account === 'empty' ? { status: 'empty' } : ready())),
      readDataset: vi.fn(async () => dataset)
    });
    await inspectConnection();
    expect(connection('local').textContent).toContain(message);
    expect(connection('approve').disabled).toBe(true);
    expect(connection('start').disabled).toBe(true);
    expect(connection('forget-approve').disabled).toBe(true);
    expect(connection('forget').disabled).toBe(true);
    connection('start').click();
    connection('forget').click();
    expect(s.enroll).not.toHaveBeenCalled();
    expect(s.forget).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it.each(['pending', 'blocked'])('не обходит локальное состояние %s', async value => {
    const s = bind({ readBinding: vi.fn(async () => ({ status: value })) });
    await inspectConnection();
    expect(s.readDataset).not.toHaveBeenCalled();
    expect(connection('start').disabled).toBe(true);
    expect(connection('forget').disabled).toBe(true);
    expect(connection('local').textContent).toContain('Не удаляйте');
  });

  it('при ошибке проверки не считает локальную запись отсутствующей и скрывает детали', async () => {
    const s = bind({
      readDataset: vi.fn(async () => {
        throw new Error(PRIVATE);
      })
    });
    await inspectConnection();
    expect(connection('local').textContent).toContain('не означает, что она отсутствует');
    expect(connection('approve').disabled).toBe(true);
    expect(connection('start').disabled).toBe(true);
    expect(s.enroll).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it('забывает только проверенный slot после отдельного согласия', async () => {
    const s = bind({ readBinding: vi.fn(async () => ready()) });
    await inspectConnection();
    expect(connection('local').textContent).toContain('облачные файлы и синхронизация не проверялись');
    expect(connection('forget').disabled).toBe(true);
    approveInput('forget-approve');
    connection('forget').click();
    await vi.waitFor(() => expect(s.forget).toHaveBeenCalledOnce());
    expect(s.forget.mock.calls[0][0]).toEqual({ provider: 'yandex', slotId: SLOT, invoke: s.invoke, confirmed: true });
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('Локальный доступ забыт'));
    expect(connection('local').textContent).toContain('Облачные файлы, ключи и разрешение у сервиса не изменялись');
    expect(connection('forget').disabled).toBe(true);
    expect(connection('forget-approve').checked).toBe(false);
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it.each(['blocked', 'mismatch'])('не заявляет об удалении, если backend ответил %s', async reply => {
    const s = bind({ readBinding: vi.fn(async () => ready()), forget: vi.fn(async () => reply) });
    await inspectConnection();
    approveInput('forget-approve');
    connection('forget').click();
    await vi.waitFor(() => expect(s.forget).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(connection('local').textContent).toContain('Ничего не удалено'));
    expect(connection('forget').disabled).toBe(true);
  });

  it('ошибка загрузки моста до удаления не объявляется начавшейся записью', async () => {
    let loads = 0;
    const invoke = vi.fn();
    const loadNative = vi.fn(async () => {
      if (++loads > 1) throw new Error(PRIVATE);
      return { invoke, openBrowser: vi.fn() };
    });
    const s = bind({ loadNative, readBinding: vi.fn(async () => ready()) });
    await inspectConnection();
    approveInput('forget-approve');
    connection('forget').click();
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('Локальная запись не изменялась'));
    expect(s.forget).not.toHaveBeenCalled();
    expect(connection('forget-approve').disabled).toBe(false);
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it('неповторяет удаление с неизвестным исходом даже после повторного чтения', async () => {
    const forget = vi.fn(async () => {
      throw new Error(PRIVATE);
    });
    const s = bind({ readBinding: vi.fn(async () => ready()), forget });
    await inspectConnection();
    approveInput('forget-approve');
    connection('forget').click();
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('не подтверждён'));
    expect(s.forget).toHaveBeenCalledOnce();
    await inspectConnection();
    expect(connection('local').textContent).toContain('всё ещё неизвестен');
    expect(connection('forget-approve').disabled).toBe(true);
    expect(connection('start').disabled).toBe(true);
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it('отмена до записи не показывает поздний результат и блокирует параллельную диагностику', async () => {
    const gate = deferred();
    let signal;
    const s = bind({
      enroll: vi.fn(input => {
        signal = input.signal;
        return gate.promise;
      })
    });
    await inspectConnection();
    byId('client').value = clientId;
    approveInput('approve');
    connection('start').click();
    await vi.waitFor(() => expect(s.enroll).toHaveBeenCalledOnce());
    expect(byId('start').disabled).toBe(true);
    submit();
    expect(s.check).not.toHaveBeenCalled();
    connection('cancel').click();
    expect(signal.aborted).toBe(true);
    expect(connection('progress').textContent).toContain('Ожидание входа отменено');
    gate.resolve({ status: 'installed' });
    await vi.waitFor(() => expect(byId('start').disabled).toBe(false));
    expect(connection('progress').textContent).not.toContain('Доступ сохранён');
  });

  it('после начала записи отмена не скрывает её успешный исход', async () => {
    const gate = deferred();
    let signal;
    const s = bind({
      enroll: vi.fn(input => {
        signal = input.signal;
        input.onProgress('installing');
        return gate.promise;
      })
    });
    await inspectConnection();
    byId('client').value = clientId;
    approveInput('approve');
    connection('start').click();
    await vi.waitFor(() => expect(s.enroll).toHaveBeenCalledOnce());
    connection('cancel').click();
    expect(signal.aborted).toBe(true);
    expect(connection('progress').textContent).toContain('может завершиться после отмены');
    gate.resolve({ status: 'installed' });
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('Доступ сохранён'));
    expect(connection('start').disabled).toBe(true);
  });

  it('не позволяет повторить неизвестную установку, даже если локальное чтение показывает пусто', async () => {
    const s = bind({
      enroll: vi.fn(async input => {
        input.onProgress('installing');
        return { status: 'installation_uncertain' };
      })
    });
    await inspectConnection();
    byId('client').value = clientId;
    approveInput('approve');
    connection('start').click();
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('не подтверждён'));
    expect(s.enroll).toHaveBeenCalledOnce();
    await inspectConnection();
    expect(connection('local').textContent).toContain('всё ещё неизвестен');
    expect(connection('approve').disabled).toBe(true);
    expect(connection('start').disabled).toBe(true);
    connection('start').click();
    expect(s.enroll).toHaveBeenCalledOnce();
  });

  it('браузер не предлагает локальное сохранение и не обращается к native', () => {
    const s = bind({ desktop: false });
    expect(connection('inspect').disabled).toBe(true);
    expect(connection('start').disabled).toBe(true);
    expect(connection('forget').disabled).toBe(true);
    connection('inspect').click();
    connection('start').click();
    expect(s.loadNative).not.toHaveBeenCalled();
    expect(s.enroll).not.toHaveBeenCalled();
    expect(s.forget).not.toHaveBeenCalled();
  });
});

describe('безопасная причина OAuth в интерфейсе', () => {
  it.each(['token', 'identity'])('показывает этап %s и фиксированный код без исходного ответа', async stage => {
    bind({ check: vi.fn(async () => ({ status: 'failed', diagnostic: { stage, code: 'invalid_client' } })) });
    byId('client').value = clientId;
    submit();
    await vi.waitFor(() => expect(byId('status').textContent).toContain(stage + '/invalid_client'));
    expect(byId('status').textContent).not.toContain('Проверьте Client ID, разрешения приложения');
  });
  it('не показывает произвольный текст вместо кода', async () => {
    bind({ check: vi.fn(async () => ({ status: 'failed', diagnostic: { stage: 'token', code: 'PRIVATE_TOKEN' } })) });
    byId('client').value = clientId;
    submit();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('Не удалось проверить регистрацию'));
    expect(document.body.textContent).not.toContain('PRIVATE_TOKEN');
  });
});

describe('обычный вход без диагностического квеста', () => {
  it('одна кнопка сама проверяет локальную запись и запускает сохранение, без разового теста и checkbox', async () => {
    const s = bind();
    byId('client').value = clientId;
    connection('simple').click();
    connection('simple').click();
    await vi.waitFor(() => expect(s.enroll).toHaveBeenCalledOnce());
    expect(s.readBinding).toHaveBeenCalledOnce();
    expect(s.check).not.toHaveBeenCalled();
    expect(s.enroll.mock.calls[0][0]).toMatchObject({
      firstConnectionConfirmed: true,
      confirmAccount: s.confirmAccount
    });
    expect(document.getElementById('cloud-registration-advanced').open).toBe(false);
  });
  it.each(['pending', 'blocked'])('не запускает вход и не показывает новый набор при %s', async status => {
    const s = bind({ readBinding: vi.fn(async () => ({ status })) });
    byId('client').value = clientId;
    connection('simple').click();
    await vi.waitFor(() => expect(s.readBinding).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(connection('simple').disabled).toBe(false));
    expect(s.enroll).not.toHaveBeenCalled();
    expect(document.getElementById('cloud-setup-title')).toBeNull();
    expect(document.getElementById('cloud-file-panel')).toBeNull();
  });
  it('без Client ID открывает разовую настройку Яндекса, не браузер', async () => {
    const s = bind();
    connection('simple').click();
    await vi.waitFor(() => expect(document.getElementById('cloud-registration-advanced').open).toBe(true));
    expect(s.enroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byId('client'));
  });
  it('подставляет готовый Google client из native, не запрашивая секрет в форме', async () => {
    const google = '123-example.apps.googleusercontent.com';
    const invoke = vi.fn(async () => ({ status: 'ready', clientId: google }));
    const s = bind({ loadNative: async () => ({ invoke, openBrowser: vi.fn() }) });
    byId('provider').value = 'google';
    byId('provider').dispatchEvent(new Event('change'));
    connection('simple').click();
    await vi.waitFor(() => expect(s.enroll).toHaveBeenCalledOnce());
    expect(s.enroll.mock.calls[0][0].clientId).toBe(google);
    expect(invoke).toHaveBeenCalledWith('cloud_google_client_read', {});
    expect(document.querySelector('[name="client_secret"]')).toBeNull();
  });
  it('без Google JSON не пытается обменять код без секрета, открывает импорт', async () => {
    const s = bind({
      loadNative: async () => ({ invoke: vi.fn(async () => ({ status: 'empty' })), openBrowser: vi.fn() })
    });
    byId('provider').value = 'google';
    byId('provider').dispatchEvent(new Event('change'));
    connection('simple').click();
    await vi.waitFor(() => expect(connection('progress').textContent).toContain('Desktop JSON'));
    expect(s.enroll).not.toHaveBeenCalled();
    expect(document.getElementById('cloud-registration-advanced').open).toBe(true);
  });
  it('импорт передаёт JSON только native, очищает выбор файла и не сохраняет секрет в Web Storage', async () => {
    const google = '123-example.apps.googleusercontent.com';
    const invoke = vi.fn(async () => ({ status: 'ready', clientId: google }));
    bind({ loadNative: async () => ({ invoke, openBrowser: vi.fn() }) });
    byId('provider').value = 'google';
    byId('provider').dispatchEvent(new Event('change'));
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const input = document.getElementById('cloud-google-import');
    const json = JSON.stringify({ installed: { client_id: google, client_secret: 'FAKE_DESKTOP_CONFIG_SECRET' } });
    Object.defineProperty(input, 'files', {
      value: [{ size: json.length, text: async () => json }],
      configurable: true
    });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('cloud_google_client_import', { json }));
    await vi.waitFor(() => expect(byId('client').value).toBe(google));
    expect(input.value).toBe('');
    expect(storage).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('FAKE_DESKTOP_CONFIG_SECRET');
  });
  it('не открывает прежний файловый обмен при входе в ранее привязанный аккаунт', async () => {
    const s = bind({ readBinding: vi.fn(async () => ready()), readDataset: vi.fn(async () => 'ready') });
    connection('simple').click();
    await vi.waitFor(() => expect(connection('simple').hidden).toBe(true));
    expect(document.getElementById('cloud-file-panel')).toBeNull();
    expect(connection('simple').hidden).toBe(true);
    expect(s.enroll).not.toHaveBeenCalled();
    expect(document.getElementById('cloud-setup-new')).toBeNull();
    expect(byId('client').value).toBe(clientId);
  });
});

describe('Google JSON import failures are actionable and never expose file contents', () => {
  it.each([
    [JSON.stringify({ web: { client_secret: 'FAKE_ONLY_SECRET' } }), null, 'Это OAuth-клиент Web'],
    [
      JSON.stringify({
        installed: { client_id: '123-example.apps.googleusercontent.com', client_secret: 'FAKE_ONLY_SECRET' }
      }),
      'oauth_client_config_client_changed',
      'другому OAuth-приложению'
    ],
    [
      JSON.stringify({
        installed: { client_id: '123-example.apps.googleusercontent.com', client_secret: 'FAKE_ONLY_SECRET' }
      }),
      'PRIVATE_SIGNED_URL_FAKE_ONLY_SECRET',
      'Импорт не подтверждён'
    ]
  ])('reports a safe reason without echoing input/IPC error', async (json, rejection, expected) => {
    const invoke = vi.fn(async () => {
      throw rejection;
    });
    bind({ loadNative: async () => ({ invoke, openBrowser: vi.fn() }) });
    byId('provider').value = 'google';
    byId('provider').dispatchEvent(new Event('change'));
    const input = document.getElementById('cloud-google-import');
    expect(input.closest('details').id).toBe('cloud-registration-panel');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ size: json.length, text: async () => json }]
    });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.getElementById('cloud-google-config-status').textContent).toContain(expected)
    );
    expect(document.body.textContent).not.toContain('FAKE_ONLY_SECRET');
    if (!rejection) expect(invoke).not.toHaveBeenCalled();
  });
});

describe('production login without legacy access controls', () => {
  it.each([
    ['empty', 'empty'],
    ['ready', 'empty'],
    ['ready', 'ready'],
    ['pending', 'ready']
  ])('%s with dataset %s: login works without check/save/delete controls', async (status, dataset) => {
    const parsed = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
    expect(document.getElementById('cloud-connection-inspect')).toBeNull();
    expect(document.getElementById('cloud-connection-start')).toBeNull();
    expect(document.getElementById('cloud-connection-forget')).toBeNull();
    byId('provider').value = 'google';
    byId('client').value = '12345-fake.apps.googleusercontent.com';
    const binding = {
      slotId: '01234567-89ab-4cde-8f01-23456789abcd',
      clientId: byId('client').value,
      accountKey: 'fake-account'
    };
    const s = bind({
      readBinding: vi.fn(async () => ({ status, ...(status === 'ready' ? { binding } : {}) })),
      readDataset: vi.fn(async () => dataset),
      loadNative: async () => ({
        invoke: vi.fn(async () => ({ status: 'ready', clientId: binding.clientId })),
        openBrowser: vi.fn()
      })
    });
    const choices = [...document.querySelectorAll('[data-standalone-destination]')].map(input => input.checked);
    if (status === 'empty') connection('simple').click();
    else {
      byId('provider').value = 'yandex';
      document.getElementById('cloud-registration-panel').dispatchEvent(new Event('tf-cloud-reconnect-google'));
    }
    await vi.waitFor(() => expect(s.enroll).toHaveBeenCalledOnce());
    expect(byId('provider').value).toBe('google');
    expect([...document.querySelectorAll('[data-standalone-destination]')].map(input => input.checked)).toEqual(
      choices
    );
    expect(s.enroll.mock.calls[0][0]).toMatchObject({
      provider: 'google',
      ...(status === 'empty' ? {} : { reconnect: true })
    });
  });
});
