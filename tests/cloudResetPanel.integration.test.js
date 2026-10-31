// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('index.html', 'utf8');
const panel = new DOMParser().parseFromString(html, 'text/html').getElementById('cloud-registration-panel')?.outerHTML;
const SLOT = '01234567-89ab-4cde-8f01-23456789abcd';
const CLIENT = '0123456789abcdef0123456789abcdef';
const byId = id => document.getElementById(`cloud-connection-${id}`);
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
let bind;
let beginReset;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = `<main>${panel}</main>`;
  ({ bindCloudRegistrationCheck: bind } = await import('../js/modules/cloudSync/ui/registrationCheckPanel.js'));
  ({ beginCloudCredentialReset: beginReset } = await import('../js/modules/cloudSync/credentialResetCoordination.js'));
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
async function mount(extra) {
  bind({
    doc: document,
    desktop: true,
    loadNative: async () => ({ invoke: async () => {}, openBrowser: async () => {} }),
    readBinding: async () => ({ status: 'empty' }),
    readDataset: async () => 'empty',
    ...extra
  });
  byId('inspect').click();
  await vi.waitFor(() => expect(byId('inspect').disabled).toBe(false));
  document.getElementById('cloud-registration-client').value = CLIENT;
}

describe('панель доступа и барьер сброса в одном окне', () => {
  it('не даёт сбросить данные во время входа и не запускает новый вход под барьером', async () => {
    const gate = deferred();
    const enroll = vi.fn(() => gate.promise);
    await mount({ enroll });
    byId('approve').click();
    byId('start').click();
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledOnce());
    expect(() => beginReset()).toThrow('операции с облачным доступом');
    gate.resolve({ status: 'declined' });
    await vi.waitFor(() => expect(byId('approve').disabled).toBe(false));
    const release = beginReset();
    byId('approve').click();
    byId('start').click();
    expect(enroll).toHaveBeenCalledOnce();
    expect(byId('progress').textContent).toContain('выполняется сброс');
    release();
    byId('start').click();
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledTimes(2));
  });

  it('не даёт сбросить данные, пока локальное забывание ещё выполняется', async () => {
    const gate = deferred();
    const forget = vi.fn(() => gate.promise);
    await mount({
      readBinding: async () => ({ status: 'ready', binding: { slotId: SLOT, clientId: CLIENT, accountKey: 'fake' } }),
      forget
    });
    byId('forget-approve').click();
    byId('forget').click();
    await vi.waitFor(() => expect(forget).toHaveBeenCalledOnce());
    expect(() => beginReset()).toThrow();
    gate.resolve('forgotten');
    await vi.waitFor(() => expect(byId('progress').textContent).toContain('Локальный доступ забыт'));
    const release = beginReset();
    release();
  });

  it('не снимает блокировку сброса после неопределённой установки', async () => {
    await mount({
      enroll: async args => {
        args.onProgress('installing');
        return { status: 'installation_uncertain' };
      }
    });
    byId('approve').click();
    byId('start').click();
    await vi.waitFor(() => expect(byId('progress').textContent).toContain('не подтверждён'));
    expect(() => beginReset()).toThrow('неподтверждённые результаты');
  });
});
