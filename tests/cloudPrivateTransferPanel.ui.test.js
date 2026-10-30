import { readFileSync } from 'node:fs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { bindPrivateTransferPanel } from '../js/modules/cloudSync/ui/privateTransferPanel.js';
import { state } from '../js/core/state.js';
const html = readFileSync('index.html', 'utf8');
const id = '22222222-2222-4222-8222-222222222222';
const pin = { versionId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) };
const el = id => document.getElementById(id);
const box = field => document.querySelector(`[data-private-field="${field}"]`);
function toggle(input, checked = true) {
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function review() {
  return {
    status: 'ready_for_review',
    checkedAt: '2026-10-30T10:30:00.000Z',
    localSavedAt: null,
    versions: [{ pin, observedHead: true, modifiedAt: null }],
    comparePrivate: vi.fn(() => [
      {
        characterId: id,
        field: 'phone',
        label: 'Герой <img src=x onerror=alert(1)>',
        selectable: true,
        clears: false,
        localPresent: true,
        cloudPresent: true
      },
      {
        characterId: id,
        field: 'email',
        label: 'Герой',
        selectable: true,
        clears: true,
        localPresent: true,
        cloudPresent: false
      },
      {
        characterId: '33333333-3333-4333-8333-333333333333',
        field: 'phone',
        label: 'Другой',
        selectable: false,
        clears: false,
        localPresent: false,
        cloudPresent: true
      }
    ])
  };
}
function setup(options = {}) {
  const commit = vi.fn(async () => ({ status: 'queued' }));
  const cancel = vi.fn();
  const stagePublication =
    options.stagePublication ||
    vi.fn(async () => ({ status: 'private_publication_review', characterCount: 2, fields: ['phone'], commit, cancel }));
  const applyCommit = vi.fn(async () => ({ status: 'applied', backup: 'state.backup-private.json' }));
  const stageApply = options.stageApply || vi.fn(() => ({ commit: applyCommit, cancel: vi.fn() }));
  const check = options.check || vi.fn(async () => review());
  const confirm = options.confirm || vi.fn(() => true);
  bindPrivateTransferPanel({
    desktop: options.desktop !== false,
    check,
    stagePublication,
    stageApply,
    confirm,
    loadNative: async () => ({ invoke: vi.fn() })
  });
  return { commit, cancel, stagePublication, applyCommit, stageApply, check, confirm };
}
function allow(field = 'phone') {
  toggle(box(field));
  toggle(el('cloud-private-source'));
}
async function incoming(f) {
  allow();
  el('cloud-private-check').click();
  await vi.waitFor(() => expect(el('cloud-private-incoming').hidden).toBe(false));
  expect(el('cloud-private-version').value).toBe('');
  el('cloud-private-version').value = '0';
  el('cloud-private-version').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(el('cloud-private-list').querySelectorAll('input')).toHaveLength(3));
}
beforeEach(() => {
  delete state.settings.cloudSyncPendingMerge;
  delete state.settings.cloudSyncPendingApply;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
});
describe('отдельные разрешения ручной передачи контактов', () => {
  it('изначально не выбирает категории и не сохраняет разрешения', () => {
    setup();
    expect([...document.querySelectorAll('#cloud-private-panel input')].every(input => !input.checked)).toBe(true);
  });
  it('на сайте не разрешает нативную подготовку и проверку', () => {
    setup({ desktop: false });
    expect(el('cloud-private-prepare').disabled).toBe(true);
    expect(el('cloud-private-check').disabled).toBe(true);
  });
  it('не готовит пароль без независимого подтверждения риска', async () => {
    const f = setup();
    el('cloud-private-prepare').click();
    expect(f.stagePublication).not.toHaveBeenCalled();
    allow('password');
    el('cloud-private-prepare').click();
    expect(f.stagePublication).not.toHaveBeenCalled();
    expect(el('cloud-private-status').textContent).toContain('отдельно подтвердите риск');
  });
  it('готовит только выбранную категорию и сбрасывает галочки после подтверждения партии', async () => {
    const f = setup();
    allow();
    el('cloud-private-prepare').click();
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalledOnce());
    expect(f.stagePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'yandex',
        fields: ['phone'],
        contactsSourceConfirmed: true,
        acknowledgePasswordRisk: false
      })
    );
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('включая архив'));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('автоматически в неё НЕ добавляются'));
    expect(box('phone').checked).toBe(false);
    expect(el('cloud-private-source').checked).toBe(false);
    expect(el('cloud-private-status').textContent).toContain('в общей очереди');
    expect(el('cloud-private-status').textContent).not.toContain('отправлены');
  });
  it('отмена подготовки не записывает очередь', async () => {
    const f = setup({ confirm: vi.fn(() => false) });
    allow();
    el('cloud-private-prepare').click();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalled());
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('смена провайдера в подтверждении отменяет прежнее намерение', async () => {
    let release;
    const confirm = vi.fn(() => new Promise(resolve => (release = resolve)));
    const f = setup({ confirm });
    allow();
    el('cloud-private-prepare').click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    el('cloud-registration-provider').value = 'google';
    el('cloud-registration-provider').dispatchEvent(new Event('change'));
    release(true);
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalled());
    expect(f.commit).not.toHaveBeenCalled();
    expect(box('phone').checked).toBe(false);
  });
  it('не выводит исходную ошибку с секретом при отказе', async () => {
    setup({
      stagePublication: vi.fn(async () => {
        throw Error('PRIVATE_PASSWORD_DO_NOT_SHOW');
      })
    });
    allow();
    el('cloud-private-prepare').click();
    await vi.waitFor(() => expect(el('cloud-private-status').textContent).toContain('не подготовлена'));
    expect(document.body.textContent).not.toContain('PRIVATE_PASSWORD_DO_NOT_SHOW');
  });
});
describe('закрытое сравнение и выбор отдельных полей', () => {
  it('разделяет дату файла и проверки, не выбирает версию и показывает XSS-безопасные признаки очистки', async () => {
    const f = setup();
    await incoming(f);
    expect(el('cloud-private-times').textContent).toContain('Источник: Яндекс Диск');
    expect(el('cloud-private-times').textContent).toContain('Локальное сохранение: неизвестно');
    expect(el('cloud-private-times').textContent).toContain('Часовой пояс');
    expect(el('cloud-private-version').textContent).toContain('файл: неизвестно');
    expect(el('cloud-private-list').querySelector('img')).toBeNull();
    expect(el('cloud-private-list').textContent).toContain('ОЧИСТИТ');
    expect(el('cloud-private-list').querySelectorAll('input')[2].disabled).toBe(true);
    expect([...el('cloud-private-list').querySelectorAll('input')].every(input => !input.checked)).toBe(true);
  });
  it('не применяет контакты без отдельной копии прежних значений vault', async () => {
    const f = setup();
    await incoming(f);
    el('cloud-private-list').querySelector('input').checked = true;
    el('cloud-private-apply').click();
    expect(f.stageApply).not.toHaveBeenCalled();
    expect(el('cloud-private-status').textContent).toContain('копия state может не содержать');
  });
  it('после повторной проверки головы применяет только отмеченную пару и не включает обратную автоотправку', async () => {
    const f = setup();
    await incoming(f);
    toggle(el('cloud-private-backup'));
    el('cloud-private-list').querySelector('input').checked = true;
    el('cloud-private-apply').click();
    await vi.waitFor(() => expect(f.applyCommit).toHaveBeenCalledOnce());
    expect(f.check).toHaveBeenCalledTimes(2);
    expect(f.stageApply).toHaveBeenCalledWith(
      expect.objectContaining({
        pin,
        selections: [{ characterId: id, field: 'phone' }],
        independentBackupConfirmed: true
      })
    );
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('НЕ старые значения vault'));
    expect(el('cloud-private-status').textContent).toContain('не замена отдельной копии vault');
    expect(el('cloud-private-source').checked).toBe(false);
    expect(el('cloud-private-backup').checked).toBe(false);
  });
  it('изменение выбора пока открыто подтверждение не применяет другую пару', async () => {
    let release;
    const confirm = vi.fn(() => new Promise(resolve => (release = resolve)));
    const f = setup({ confirm });
    await incoming(f);
    toggle(el('cloud-private-backup'));
    const inputs = el('cloud-private-list').querySelectorAll('input');
    inputs[0].checked = true;
    el('cloud-private-apply').click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    inputs[0].checked = false;
    inputs[1].checked = true;
    release(true);
    await vi.waitFor(() => expect(el('cloud-private-status').textContent).toContain('отменено'));
    expect(f.stageApply).not.toHaveBeenCalled();
    expect(f.check).toHaveBeenCalledOnce();
  });
  it('не применяет старую выбранную версию, если при повторной проверке пришла новая голова', async () => {
    const fresh = review();
    fresh.versions[0].pin = { ...pin, sha256: 'b'.repeat(64) };
    const f = setup({ check: vi.fn().mockResolvedValueOnce(review()).mockResolvedValueOnce(fresh) });
    await incoming(f);
    toggle(el('cloud-private-backup'));
    el('cloud-private-list').querySelector('input').checked = true;
    el('cloud-private-apply').click();
    await vi.waitFor(() => expect(el('cloud-private-status').textContent).toContain('Источники изменились'));
    expect(f.stageApply).not.toHaveBeenCalled();
  });
  it('не применяет устаревший показ после местного сохранения во время диалога', async () => {
    let release;
    const confirm = vi.fn(() => new Promise(resolve => (release = resolve)));
    const f = setup({ confirm });
    await incoming(f);
    toggle(el('cloud-private-backup'));
    el('cloud-private-list').querySelector('input').checked = true;
    el('cloud-private-apply').click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    const old = state.settings.ui.theme;
    state.settings.ui.theme = old === 'light' ? 'dark' : 'light';
    release(true);
    await vi.waitFor(() => expect(el('cloud-private-status').textContent).toContain('данные изменились'));
    expect(f.stageApply).not.toHaveBeenCalled();
    state.settings.ui.theme = old;
  });
  it('ограничивает DOM первыми 1000 полями и не выбирает скрытые записи', async () => {
    const checked = review();
    const row = checked.comparePrivate()[0];
    checked.comparePrivate.mockReturnValue(
      Array.from({ length: 1001 }, (_, i) => ({ ...row, characterId: `id-${i}` }))
    );
    setup({ check: vi.fn(async () => checked) });
    allow();
    el('cloud-private-check').click();
    await vi.waitFor(() => expect(el('cloud-private-incoming').hidden).toBe(false));
    el('cloud-private-version').value = '0';
    el('cloud-private-version').dispatchEvent(new Event('change'));
    expect(el('cloud-private-list').querySelectorAll('input')).toHaveLength(1000);
    expect(el('cloud-private-status').textContent).toContain('первые 1000');
    expect(el('cloud-private-version').classList.contains('input')).toBe(true);
    expect([...el('cloud-private-list').querySelectorAll('input')].every(input => !input.checked)).toBe(true);
  });
});
