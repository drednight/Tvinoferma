// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCloudPublicationPanel } from '../js/modules/cloudSync/ui/cloudPublicationPanel.js';
import { clearCloudActivity, cloudActivity } from '../js/modules/cloudSync/cloudEventLog.js';

const html = readFileSync('index.html', 'utf8');
const byId = id => document.getElementById(id);
function changeProvider(value) {
  byId('cloud-registration-provider').value = value;
  byId('cloud-registration-provider').dispatchEvent(new Event('change', { bubbles: true }));
}
function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}
function setup(extra = {}) {
  let active = null;
  let onReport;
  const controller = {
    configuredProvider: vi.fn(() => active),
    enable: vi.fn(value => {
      active = value;
      return true;
    }),
    disable: vi.fn(() => {
      active = null;
      return true;
    }),
    runManual: vi.fn(async () => ({ status: 'sent_verified' })),
    dispose: vi.fn()
  };
  const controllerFactory = vi.fn(options => {
    onReport = options.report;
    return controller;
  });
  const confirm = vi.fn(async () => true);
  bindCloudPublicationPanel({ desktop: true, confirm, controllerFactory, ...extra });
  return { controller, confirm: extra.confirm || confirm, report: (...args) => onReport(...args) };
}
beforeEach(() => {
  localStorage.clear();
  clearCloudActivity();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = doc.getElementById('cloud-registration-panel').outerHTML;
});
afterEach(() => {
  document.body.innerHTML = '';
  clearCloudActivity();
  vi.restoreAllMocks();
});

describe('экспериментальная панель последующих сохранений', () => {
  it('в браузере отключает авто и ручную отправку, не подгружая native', () => {
    const loadNative = vi.fn();
    const f = setup({ desktop: false, loadNative });
    expect(byId('cloud-publication-auto').disabled).toBe(true);
    expect(byId('cloud-publication-send').disabled).toBe(true);
    expect(byId('cloud-publication-mode').textContent).toContain('только в настольной сборке');
    byId('cloud-publication-send').click();
    expect(loadNative).not.toHaveBeenCalled();
    expect(f.controller.runManual).not.toHaveBeenCalled();
  });

  it('включает только после отдельного согласия, показывает активный диск и выключает его', async () => {
    const f = setup();
    const checkbox = byId('cloud-publication-auto');
    expect(checkbox.checked).toBe(false);
    checkbox.click();
    await vi.waitFor(() => expect(f.controller.enable).toHaveBeenCalledWith('yandex'));
    expect(checkbox.checked).toBe(true);
    expect(byId('cloud-publication-mode').textContent).toContain('Яндекс Диск');
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('резервной копией'));
    changeProvider('google');
    expect(checkbox.checked).toBe(false);
    expect(byId('cloud-publication-mode').textContent).toContain('сейчас выбран другой диск');
    changeProvider('yandex');
    checkbox.click();
    await vi.waitFor(() => expect(f.controller.disable).toHaveBeenCalled());
    expect(checkbox.checked).toBe(false);
    expect(byId('cloud-publication-status').textContent).toContain('начатая операция может завершиться');
  });

  it('отмена или изменение выбранного диска в диалоге не включают автоотправку', async () => {
    const answer = deferred();
    const confirm = vi.fn(() => answer.promise);
    const f = setup({ confirm });
    byId('cloud-publication-auto').click();
    changeProvider('google');
    answer.resolve(true);
    await vi.waitFor(() => expect(byId('cloud-publication-auto').disabled).toBe(false));
    expect(f.controller.enable).not.toHaveBeenCalled();
    expect(byId('cloud-publication-auto').checked).toBe(false);
    expect(byId('cloud-publication-status').textContent).toContain('отменено');
  });

  it('ручная отправка требует подтверждения и использует выбранный диск, не включая авто', async () => {
    const f = setup();
    changeProvider('google');
    byId('cloud-publication-send').click();
    await vi.waitFor(() => expect(f.controller.runManual).toHaveBeenCalledWith('google'));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('пароли и контакты исключены'));
    expect(f.controller.enable).not.toHaveBeenCalled();
    expect(byId('cloud-publication-auto').checked).toBe(false);
  });

  it('показывает только безопасные предопределённые статусы и пишет коды без значений в журнал', () => {
    const f = setup();
    f.report('yandex', 'queue', 'deletions_need_review');
    expect(byId('cloud-publication-status').textContent).toContain('исчезновение ранее опубликованной записи');
    f.report('google', 'send', 'sent_verified');
    expect(byId('cloud-publication-status').textContent).toContain('сверен чтением');
    const log = JSON.stringify(cloudActivity());
    expect(log).toContain('publish');
    expect(log).toContain('queue');
    f.report('google', 'send', '<img src=x onerror=alert(1)>');
    expect(document.querySelector('#cloud-publication-status img')).toBeNull();
    expect(byId('cloud-publication-status').textContent).not.toContain('<img');
  });

  it('не выдаёт неподтверждённую запись разрешения за успешную настройку', async () => {
    const f = setup();
    f.controller.enable.mockReturnValue(false);
    byId('cloud-publication-auto').click();
    await vi.waitFor(() => expect(f.controller.enable).toHaveBeenCalled());
    expect(byId('cloud-publication-auto').checked).toBe(false);
    expect(byId('cloud-publication-status').textContent).toContain('Не удалось подтвердить');
  });
});
