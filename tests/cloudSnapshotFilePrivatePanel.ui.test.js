import { legacyCloudHtml } from './helpers/legacyCloudHtml.js';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindSnapshotFilePrivatePanel } from '../js/modules/cloudSync/ui/snapshotFilePrivatePanel.js';
const html = legacyCloudHtml(readFileSync('index.html', 'utf8'));
const el = id => document.getElementById(`cloud-file-private-${id}`);
const rows = [
  {
    characterId: '11111111-1111-4111-8111-111111111111',
    field: 'password',
    label: '<img src=x> Герой',
    selectable: true,
    clears: false,
    localPresent: true,
    cloudPresent: true
  },
  {
    characterId: '11111111-1111-4111-8111-111111111111',
    field: 'email',
    label: 'Герой',
    selectable: true,
    clears: true,
    localPresent: true,
    cloudPresent: false
  }
];
function setup(extra = {}) {
  const check = vi.fn(async () => ({ status: 'ready', remoteChanged: false, privateCarry: false, privateOrphans: 0 }));
  const prepareExport = vi.fn(async () => ({ status: 'private_export_review', rows, cancel: vi.fn() }));
  const checkPrivate = vi.fn(async () => ({ status: 'private_ready', rows, cancel: vi.fn() }));
  const upload = vi.fn(async () => ({ status: 'sent_verified' })),
    apply = vi.fn(async () => ({ status: 'applied' })),
    confirm = vi.fn(() => true);
  bindSnapshotFilePrivatePanel({
    desktop: true,
    save: vi.fn(async () => {}),
    prepareIdentities: vi.fn(() => ({ status: 'already_assigned' })),
    loadNative: async () => ({ invoke: vi.fn() }),
    check,
    prepareExport,
    checkPrivate,
    upload,
    apply,
    confirm,
    ...extra
  });
  return { check, prepareExport, checkPrivate, upload, apply, confirm, ...extra };
}
function consent() {
  for (const field of ['password', 'email'])
    document.querySelector(`[data-file-private-field="${field}"]`).checked = true;
  el('source').checked = el('risk').checked = true;
}
async function preview(action = 'prepare') {
  el(action).click();
  await vi.waitFor(() => expect(el('result').hidden).toBe(false));
  await vi.waitFor(() => expect(el(action).disabled).toBe(false));
}
beforeEach(() => {
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
});
describe('файловый ручной перенос контактов: интерфейс', () => {
  it('изначально свёрнут, категории и разрешения выключены; без opt-in не читает контакты', async () => {
    const f = setup();
    expect(document.getElementById('cloud-file-private').open).toBe(false);
    expect([...document.querySelectorAll('[data-file-private-field]')].every(box => !box.checked)).toBe(true);
    el('prepare').click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('Выберите категории'));
    expect(f.check).not.toHaveBeenCalled();
    expect(f.prepareExport).not.toHaveBeenCalled();
  });
  it('отдельно требует согласие на пароль', () => {
    const f = setup();
    consent();
    el('risk').checked = false;
    el('prepare').click();
    expect(f.prepareExport).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('риск передачи пароля');
  });
  it('показывает безопасные метки, выбор всех и снятие всех, без значений и HTML', async () => {
    setup();
    consent();
    await preview();
    expect(el('list').querySelector('img')).toBeNull();
    expect(el('list').textContent).toContain('ОЧИСТИТ');
    expect(el('send').disabled).toBe(true);
    el('all').click();
    expect(el('send').disabled).toBe(false);
    el('none').click();
    expect(el('send').disabled).toBe(true);
  });
  it('отправляет только отмеченные пары после подтверждения и сбрасывает разрешения', async () => {
    const f = setup();
    consent();
    await preview();
    const first = el('list').querySelector('input');
    first.checked = true;
    first.dispatchEvent(new Event('change'));
    el('send').click();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledTimes(1));
    expect(f.upload.mock.calls[0][0]).toMatchObject({
      confirmed: true,
      privateSelections: [{ characterId: rows[0].characterId, field: 'password' }]
    });
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('Все, кто имеет ключ набора'));
    await vi.waitFor(() => expect(el('source').checked).toBe(false));
    expect([...document.querySelectorAll('[data-file-private-field]')].every(box => !box.checked)).toBe(true);
  });
  it('без независимой копии не применяет контакты; применение не отправляет публичный файл', async () => {
    const f = setup();
    consent();
    await preview('check');
    el('all').click();
    expect(el('apply').disabled).toBe(true);
    el('backup').checked = true;
    el('backup').dispatchEvent(new Event('change'));
    el('apply').click();
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledTimes(1));
    expect(f.apply.mock.calls[0][0].independentBackupConfirmed).toBe(true);
    expect(f.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Публичные данные и принятая облачная база не обновятся')
    );
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('изменение диска во время согласия отменяет отправку и сбрасывает выбор', async () => {
    let approve;
    const f = setup({
      confirm: () =>
        new Promise(resolve => {
          approve = resolve;
        })
    });
    consent();
    await preview();
    el('all').click();
    el('send').click();
    await vi.waitFor(() => expect(approve).toBeTypeOf('function'));
    const disk = document.getElementById('cloud-registration-provider');
    disk.value = 'google';
    disk.dispatchEvent(new Event('change'));
    approve(true);
    await vi.waitFor(() => expect(el('prepare').disabled).toBe(false));
    expect(f.upload).not.toHaveBeenCalled();
    expect(el('source').checked).toBe(false);
  });
  it('смена категорий и фоновое сохранение уничтожают прежнюю подготовку', async () => {
    const f = setup();
    consent();
    await preview();
    document.querySelector('[data-file-private-field="email"]').dispatchEvent(new Event('change'));
    expect(el('result').hidden).toBe(true);
    consent();
    await preview();
    window.dispatchEvent(new Event('tf-persisted'));
    expect(el('result').hidden).toBe(true);
    expect(el('risk').checked).toBe(false);
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('в web не запускает native и не скрывает это сообщение после autosave', () => {
    const f = setup({ desktop: false });
    window.dispatchEvent(new Event('tf-persisted'));
    expect(el('prepare').disabled).toBe(true);
    expect(el('check').disabled).toBe(true);
    el('prepare').click();
    expect(f.check).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('настольным');
  });
  it('не выбирает контактный источник автоматически при конкурирующих файлах', async () => {
    const f = setup({ check: vi.fn(async () => ({ status: 'multiple_files' })) });
    consent();
    el('check').click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('Сначала явно выберите'));
    expect(f.checkPrivate).not.toHaveBeenCalled();
  });
  it('отдельно требует согласие пропуска старых приватных записей отсутствующих персонажей', async () => {
    const f = setup({
      check: vi.fn(async () => ({ status: 'ready', remoteChanged: false, privateOrphans: 1, privateCarry: true })),
      confirm: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    });
    consent();
    await preview();
    el('all').click();
    el('send').click();
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(el('prepare').disabled).toBe(false));
    expect(f.confirm.mock.calls[1][0]).toContain('не безвозвратное удаление');
    expect(f.upload).not.toHaveBeenCalled();
  });
});
