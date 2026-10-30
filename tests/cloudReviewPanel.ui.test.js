import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCloudReviewPanel } from '../js/modules/cloudSync/ui/cloudReviewPanel.js';

const html = readFileSync('index.html', 'utf8');
const pin = { versionId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) };
const ids = {
  incoming: '22222222-2222-4222-8222-222222222222',
  changed: '33333333-3333-4333-8333-333333333333'
};
function review(provider = 'yandex', content = 'Обычное значение') {
  return {
    status: 'ready_for_review',
    provider,
    datasetId: '44444444-4444-4444-8444-444444444444',
    checkedAt: '2026-10-30T10:30:00.000Z',
    localSavedAt: null,
    versions: [{ pin, modifiedAt: '2026-10-29T12:00:00.000Z', observedHead: true }],
    compare: () => ({
      pin,
      cloudModifiedAt: '2026-10-29T12:00:00.000Z',
      cloudRecord: () => ({ fields: { notes: content } }),
      differences: {
        entries: [
          {
            section: 'characters',
            kind: 'only_cloud',
            id: ids.incoming,
            type: 'character',
            label: '<img src=x onerror=alert(1)>',
            changes: []
          },
          {
            section: 'planner',
            kind: 'changed',
            id: ids.changed,
            type: 'plannerEntry',
            label: 'Задача',
            changes: [
              { path: ['title'], local: { present: true, value: 'Старое' }, cloud: { present: true, value: content } }
            ]
          },
          {
            section: 'characters',
            kind: 'only_local',
            id: '55555555-5555-4555-8555-555555555555',
            label: 'Только локально',
            changes: []
          },
          {
            section: 'finance',
            kind: 'settings_changed',
            changes: [{ path: ['goldRate'], local: { present: true, value: 1 }, cloud: { present: true, value: 2 } }]
          },
          { section: 'planner', kind: 'identity_review', label: 'Клан', changes: [] }
        ],
        uncomparedSettings: ['appearance']
      }
    })
  };
}
const el = id => document.getElementById(id);
function click(id) {
  el(id).click();
}
function change(id, value) {
  el(id).value = value;
  el(id).dispatchEvent(new Event('change', { bubbles: true }));
}
function setup(options = {}) {
  const check = options.check || vi.fn(async () => review());
  const commit = vi.fn(async () => ({ status: 'applied', backup: 'state.backup-safe.json' }));
  const cancel = vi.fn();
  const stage = options.stage || vi.fn(() => ({ commit, cancel }));
  const confirm = options.confirm || vi.fn(() => true);
  bindCloudReviewPanel({
    desktop: options.desktop !== false,
    check,
    stage,
    ...(options.useDefaultConfirmation ? {} : { confirm }),
    ...(options.prepareIdentities ? { prepareIdentities: options.prepareIdentities } : {}),
    ...(options.reconcile ? { reconcile: options.reconcile } : {}),
    loadNative: async () => ({ invoke: vi.fn() })
  });
  return { check, stage, confirm, commit, cancel };
}
async function openComparison() {
  click('cloud-review-check');
  await vi.waitFor(() => expect(el('cloud-review-result').hidden).toBe(false));
  expect(el('cloud-review-version').value).toBe('');
  change('cloud-review-version', '0');
}

beforeEach(() => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
});

describe('интерфейс проверенного сравнения', () => {
  it('раздельно показывает даты, часовой пояс и явный выбор версии, текст данных не становится HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const f = setup({ check: vi.fn(async () => review('yandex', hostile)) });
    await openComparison();
    expect(f.check).toHaveBeenCalledOnce();
    expect(el('cloud-review-times').textContent).toContain('Яндекс Диск');
    expect(el('cloud-review-times').textContent).toContain('Проверено:');
    expect(el('cloud-review-times').textContent).toContain('Локальное сохранение: неизвестно');
    expect(el('cloud-review-times').textContent).toContain('Часовой пояс:');
    expect(el('cloud-review-summary').textContent).toContain('Дата файла на диске:');
    expect(el('cloud-review-summary').textContent).toContain('не сравнивались');
    expect(el('cloud-review-list').textContent).toContain(hostile);
    expect(el('cloud-review-list').querySelector('img')).toBeNull();
    expect(el('cloud-review-list').textContent).toContain('только на этом ПК, не удаляется');
    expect(el('cloud-review-list').textContent).toContain('облачные поля заменят местные');
    expect(el('cloud-review-list').textContent).toContain('требуется сопоставить');
    const boxes = [...el('cloud-review-list').querySelectorAll('input[type=checkbox]')];
    expect(boxes).toHaveLength(3);
    expect(boxes.every(box => !box.checked)).toBe(true);
    click('cloud-review-select-all');
    expect(boxes.every(box => box.checked)).toBe(true);
    click('cloud-review-select-none');
    expect(boxes.every(box => !box.checked)).toBe(true);
  });

  it('только для полного совпадения предлагает отдельное подтверждение принятой основы', async () => {
    const value = review();
    const originalCompare = value.compare;
    value.compare = () => ({ ...originalCompare(), differences: { entries: [], uncomparedSettings: [] } });
    const reconcile = vi.fn(async () => ({ status: 'reconciled', backup: 'state.backup-accept.json' }));
    const f = setup({ check: vi.fn(async () => value), reconcile });
    const event = vi.fn();
    window.addEventListener('tf-cloud-reconciled', event, { once: true });
    await openComparison();
    expect(el('cloud-review-reconcile').hidden).toBe(false);
    click('cloud-review-reconcile');
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('полное совпадение'));
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ provider: 'yandex', pin, confirmed: true }));
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('Полное совпадение подтверждено'));
    expect(event).toHaveBeenCalledOnce();
  });

  it('показывает, почему нельзя принять основу без ранее подтверждённых локальных версий', async () => {
    const value = review();
    const originalCompare = value.compare;
    value.compare = () => ({ ...originalCompare(), differences: { entries: [], uncomparedSettings: [] } });
    const reconcile = vi.fn(async () => ({ status: 'local_lineage_not_ancestor' }));
    setup({ check: vi.fn(async () => value), reconcile });
    await openComparison();
    click('cloud-review-reconcile');
    await vi.waitFor(() =>
      expect(el('cloud-review-status').textContent).toContain('не входят в выбранную облачную ветвь')
    );
    expect(el('cloud-review-result').hidden).toBe(false);
  });

  it('не предлагает согласование при различиях или нескольких наблюдаемых ветвях', async () => {
    const value = review();
    setup({ check: vi.fn(async () => value) });
    await openComparison();
    expect(el('cloud-review-reconcile').hidden).toBe(true);
  });

  it('отмена ничего не записывает, подтверждение применяет лишь выбранное и обновляет приложение', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const f = setup({ confirm });
    await openComparison();
    const boxes = [...el('cloud-review-list').querySelectorAll('input[type=checkbox]')];
    boxes[1].checked = true;
    boxes[2].checked = true;
    click('cloud-review-apply');
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('неотправленные локальные правки'));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('разрешения конфликтов пока нет'));
    expect(f.commit).not.toHaveBeenCalled();
    expect(el('cloud-review-status').textContent).toContain('отменено');
    const event = vi.fn();
    window.addEventListener('tf-cloud-applied', event, { once: true });
    click('cloud-review-apply');
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalledWith({ confirmed: true }));
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('сохранены'));
    expect(f.stage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pin,
        selectedRecords: [{ section: 'planner', id: ids.changed }],
        selectedSettings: [],
        includeFinanceSettings: true
      })
    );
    expect(el('cloud-review-result').hidden).toBe(true);
    expect(event).toHaveBeenCalledOnce();
  });

  it('использует окно приложения с отменой в фокусе, без системного confirm', async () => {
    const f = setup({ useDefaultConfirmation: true });
    await openComparison();
    click('cloud-review-select-all');
    click('cloud-review-apply');
    const modal = document.querySelector('.tf-confirm-overlay');
    expect(modal).toBeTruthy();
    expect(modal.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(document.activeElement).toBe(modal.querySelector('[data-act="cancel"]'));
    modal.querySelector('[data-act="cancel"]').click();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('не применяет выбранную версию при смене диска во время окна подтверждения', async () => {
    let release;
    const approval = new Promise(resolve => {
      release = resolve;
    });
    const f = setup({ confirm: () => approval });
    await openComparison();
    click('cloud-review-select-all');
    click('cloud-review-apply');
    change('cloud-registration-provider', 'google');
    release(true);
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(f.commit).not.toHaveBeenCalled();
    expect(el('cloud-review-result').hidden).toBe(true);
  });

  it('готовит локальные ID только после подтверждения и сообщения о копии', async () => {
    const commit = vi.fn(async () => ({ status: 'applied', backup: 'state.backup-ids.json' }));
    const cancel = vi.fn();
    const prepareIdentities = vi.fn(() => ({ status: 'prepared', operation: { selectedCount: 3, commit, cancel } }));
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    setup({ prepareIdentities, confirm });
    click('cloud-review-identities');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0][0]).toContain('пароли в хранилище Windows');
    click('cloud-review-identities');
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith({ confirmed: true }));
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('Облачный диск не изменялся'));
    expect(el('cloud-review-status').textContent).toContain('state.backup-ids.json');
  });

  it('не позволяет выбрать запись, которая слишком велика для полного просмотра', async () => {
    setup({ check: vi.fn(async () => review('google', 'x'.repeat(30_000))) });
    change('cloud-registration-provider', 'google');
    await openComparison();
    const boxes = [...el('cloud-review-list').querySelectorAll('input[type=checkbox]')];
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[1].disabled).toBe(true);
    click('cloud-review-select-all');
    expect(boxes[0].checked).toBe(false);
    expect(boxes[2].checked).toBe(true);
    expect(el('cloud-review-list').textContent).toContain('выбор заблокирован');
  });

  it('смена диска отменяет ожидающую проверку и не показывает её поздний ответ', async () => {
    let finish;
    const check = vi.fn(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    setup({ check });
    click('cloud-review-check');
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    const signal = check.mock.calls[0][0].signal;
    change('cloud-registration-provider', 'google');
    expect(signal.aborted).toBe(true);
    finish(review());
    await vi.waitFor(() => expect(el('cloud-review-check').disabled).toBe(false));
    expect(el('cloud-review-result').hidden).toBe(true);
    expect(el('cloud-review-status').textContent).toContain('другой диск');
  });

  it('при запуске проверяет оба уже настроенных диска, не выбирает файл и не применяет данные', async () => {
    const check = vi.fn(async options =>
      options.provider === 'yandex' ? { status: 'binding_missing' } : review('google')
    );
    const f = setup({ check });
    window.dispatchEvent(new CustomEvent('tf-cloud-startup-check'));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('Google Диск'));
    expect(check.mock.calls.map(call => call[0].provider)).toEqual(['yandex', 'google']);
    expect(f.stage).not.toHaveBeenCalled();
    expect(el('cloud-review-result').hidden).toBe(true);
  });

  it('не сообщает о найденных версиях второго диска, когда список пуст', async () => {
    const check = vi.fn(async options =>
      options.provider === 'yandex' ? { status: 'binding_missing' } : { ...review('google'), versions: [] }
    );
    setup({ check });
    window.dispatchEvent(new CustomEvent('tf-cloud-startup-check'));
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('подтверждённых версий не найдено'));
    expect(el('cloud-review-status').textContent).not.toContain('найдены проверенные версии');
  });

  it('сообщает о неподтверждённой автоматической проверке второго диска', async () => {
    const check = vi.fn(async options =>
      options.provider === 'yandex' ? { status: 'binding_missing' } : { status: 'queue_not_ready' }
    );
    setup({ check });
    window.dispatchEvent(new CustomEvent('tf-cloud-startup-check'));
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('Google Диск'));
    expect(el('cloud-review-status').textContent).toContain('журнал');
  });

  it('в браузерной версии проверка и автоматический запуск отключены', () => {
    const f = setup({ desktop: false });
    expect(el('cloud-review-check').disabled).toBe(true);
    click('cloud-review-check');
    window.dispatchEvent(new CustomEvent('tf-cloud-startup-check'));
    expect(f.check).not.toHaveBeenCalled();
    expect(el('cloud-review-status').textContent).toContain('настольном');
  });
});
