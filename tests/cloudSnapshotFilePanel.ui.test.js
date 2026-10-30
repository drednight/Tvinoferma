import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindSnapshotFilePanel } from '../js/modules/cloudSync/ui/snapshotFilePanel.js';
const html = readFileSync('index.html', 'utf8');
const el = id => document.getElementById(`cloud-file-${id}`);
const view = extra => ({
  status: 'ready',
  provider: 'google',
  pin: { versionId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) },
  checkedAt: '2026-10-31T10:00:00Z',
  modifiedAt: '2026-10-30T12:00:00Z',
  localSavedAt: null,
  localChanged: true,
  remoteChanged: false,
  matches: false,
  pending: null,
  privateCarry: false,
  differences: {
    entries: [{ section: 'planner', kind: 'only_local', label: '<img src=x> Личная задача', changes: [] }],
    uncomparedSettings: []
  },
  ...extra
});
function setup(overrides = {}) {
  const check = overrides.check || vi.fn(async () => view());
  const replace = vi.fn(async () => ({ status: 'applied' }));
  const upload = vi.fn(async () => ({ status: 'sent_verified' }));
  const confirm = overrides.confirm || vi.fn(() => true);
  bindSnapshotFilePanel({
    desktop: true,
    save: vi.fn(async () => {}),
    prepareIdentities: vi.fn(() => ({ status: 'already_assigned' })),
    check,
    replace,
    upload,
    resume: vi.fn(),
    loadNative: async () => ({ invoke: vi.fn() }),
    confirm,
    ...overrides
  });
  return { check, replace, upload, confirm };
}
async function compare() {
  el('check').click();
  await vi.waitFor(() => expect(el('result').hidden).toBe(false));
  await vi.waitFor(() => expect(el('check').disabled).toBe(false));
}
beforeEach(() => {
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
  document.getElementById('cloud-registration-provider').value = 'google';
});
describe('обмен полным файлом — интерфейс', () => {
  it('только скачивает и показывает удаления, даты и безопасный текст', async () => {
    const f = setup();
    await compare();
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(el('list').textContent).toContain('будет удалено');
    expect(el('list').querySelector('img')).toBeNull();
    expect(el('times').textContent).toContain('Часовой пояс');
  });
  it('показывает поля до замены, не интерпретируя содержимое как HTML', async () => {
    setup({
      check: vi.fn(async () =>
        view({
          differences: {
            entries: [
              {
                section: 'characters',
                kind: 'changed',
                label: 'Герой',
                changes: [
                  {
                    path: ['fields', 'notes'],
                    local: { present: true, value: 'Старая' },
                    cloud: { present: true, value: '<script>new</script>' }
                  }
                ]
              }
            ]
          }
        })
      )
    });
    await compare();
    expect(el('list').textContent).toContain('Заметка: Старая → <script>new</script>');
    expect(el('list').querySelector('script')).toBeNull();
  });
  it('требует подтверждение полной замены, включая отсутствующие записи', async () => {
    const f = setup();
    await compare();
    el('apply').click();
    await vi.waitFor(() => expect(f.replace).toHaveBeenCalledTimes(1));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('будут удалены'));
    expect(f.replace.mock.calls[0][0].confirmed).toBe(true);
  });
  it('предупреждает перед отправкой поверх непринятого облачного файла', async () => {
    const f = setup({ check: vi.fn(async () => view({ remoteChanged: true })) });
    el('upload').click();
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledTimes(1));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('не принимал'));
    expect(f.upload.mock.calls[0][0].overwriteConfirmed).toBe(true);
  });
  it('не принимает подтверждение после смены диска', async () => {
    let approve;
    const f = setup({
      confirm: () =>
        new Promise(resolve => {
          approve = resolve;
        })
    });
    await compare();
    el('apply').click();
    await vi.waitFor(() => expect(approve).toBeTypeOf('function'));
    const provider = document.getElementById('cloud-registration-provider');
    provider.value = 'yandex';
    provider.dispatchEvent(new Event('change'));
    approve(true);
    await vi.waitFor(() => expect(el('check').disabled).toBe(false));
    expect(f.replace).not.toHaveBeenCalled();
    expect(el('result').hidden).toBe(true);
  });
  it('не переносит ранее переданные секреты без второго согласия', async () => {
    const f = setup({
      check: vi.fn(async () => view({ privateCarry: true })),
      confirm: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    });
    el('upload').click();
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(el('upload').disabled).toBe(false));
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('в браузерном предпросмотре не выполняет native действия', () => {
    const f = setup({ desktop: false });
    expect(el('check').disabled).toBe(true);
    el('upload').click();
    expect(f.check).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('настольном');
  });
  it('после местного сохранения сбрасывает старое сравнение, не отправляя данные', async () => {
    const f = setup();
    await compare();
    window.dispatchEvent(new Event('tf-persisted'));
    expect(el('result').hidden).toBe(true);
    expect(el('apply').disabled).toBe(true);
    expect(el('status').textContent).toContain('новое местное сохранение');
    expect(f.upload).not.toHaveBeenCalled();
  });
});
