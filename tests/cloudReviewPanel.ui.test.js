import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCloudReviewPanel } from '../js/modules/cloudSync/ui/cloudReviewPanel.js';
import { state } from '../js/core/state.js';
import { addPendingConservativeMerge } from '../js/modules/cloudSync/pendingConservativeMerge.js';

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
    ...(options.merge ? { merge: options.merge } : {}),
    ...(options.cancelMerge ? { cancelMerge: options.cancelMerge } : {}),
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
  delete state.settings.cloudSyncPendingMerge;
  delete state.settings.cloudSyncPendingApply;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.getElementById('cloud-registration-panel').outerHTML;
});

describe('интерфейс проверенного сравнения', () => {
  it('показывает проверенную отметку удаления без кнопки выбора или автоматического удаления', async () => {
    const value = review();
    const baseCompare = value.compare;
    value.compare = () => ({
      ...baseCompare(),
      localRecord: () => ({ fields: { title: 'Местное <img src=x>' } }),
      differences: {
        entries: [
          { section: 'planner', id: ids.changed, kind: 'marked_cloud_deletion', label: 'Событие', changes: [] }
        ],
        uncomparedSettings: []
      }
    });
    const f = setup({ check: vi.fn(async () => value) });
    await openComparison();
    expect(el('cloud-review-list').textContent).toContain('в проверенной истории диска есть отметка удаления');
    expect(el('cloud-review-list').textContent).toContain('применение удаления пока недоступно');
    expect(el('cloud-review-list').textContent).toContain('Местное <img src=x>');
    expect(el('cloud-review-list').querySelector('img')).toBeNull();
    expect(el('cloud-review-list').querySelector('input[type=checkbox]')).toBeNull();
    click('cloud-review-select-all');
    click('cloud-review-apply');
    expect(f.stage).not.toHaveBeenCalled();
  });
  it('предлагает подтверждённое удаление отдельно с предупреждением о потере местных правок', async () => {
    const value = review();
    const baseCompare = value.compare;
    value.compare = () => ({
      ...baseCompare(),
      localRecord: () => ({ fields: { title: 'Местная задача' } }),
      differences: {
        entries: [
          {
            section: 'planner',
            id: ids.changed,
            kind: 'marked_cloud_deletion',
            deletionSelectable: true,
            label: 'Задача',
            changes: []
          }
        ],
        uncomparedSettings: []
      }
    });
    const f = setup({ check: vi.fn(async () => value) });
    await openComparison();
    const box = el('cloud-review-list').querySelector('input[type=checkbox]');
    expect(box.checked).toBe(false);
    expect(el('cloud-review-list').textContent).toContain('включая местные правки');
    click('cloud-review-select-all');
    click('cloud-review-apply');
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalled());
    expect(f.stage).toHaveBeenCalledWith(
      expect.objectContaining({ selectedRecords: [], selectedPlannerDeletions: [ids.changed] })
    );
    expect(f.confirm).toHaveBeenCalledWith(
      expect.stringContaining('удалят записи с этого ПК вместе с местными правками')
    );
  });

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
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('не разрешает конфликты'));
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

function pendingMarker() {
  return {
    version: 1,
    operationId: '77777777-7777-4777-8777-777777777777',
    provider: 'yandex',
    datasetId: '44444444-4444-4444-8444-444444444444',
    basePin: { versionId: '88888888-8888-4888-8888-888888888888', sha256: 'b'.repeat(64) },
    targetPin: pin,
    previousBase: null,
    queueRevisionId: '99999999-9999-4999-8999-999999999999',
    pendingPin: null,
    pendingPhase: null,
    retainedIntents: [],
    settingsSelections: ['appearance'],
    localHash: 'c'.repeat(64),
    mergedHash: 'd'.repeat(64)
  };
}
function mergeableReview() {
  const value = review();
  const originalCompare = value.compare;
  value.compare = () => {
    const result = originalCompare();
    return { ...result, differences: { entries: [result.differences.entries[1]], uncomparedSettings: [] } };
  };
  return value;
}

describe('интерфейс ограниченного объединения', () => {
  it('показывает отдельный выбор удаления при объединении и предупреждает о местных правках', async () => {
    const value = review();
    const prior = value.compare;
    value.compare = () => ({
      ...prior(),
      localRecord: () => ({ fields: { title: 'Местная задача' } }),
      differences: {
        entries: [
          {
            section: 'planner',
            id: ids.changed,
            kind: 'marked_cloud_deletion',
            deletionSelectable: true,
            label: 'Задача <img src=x>',
            changes: []
          }
        ],
        uncomparedSettings: []
      }
    });
    const merge = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'conflicts',
        reviewHash: 'c'.repeat(64),
        conflicts: [{ section: 'planner', id: ids.changed, path: ['deletion'], reason: 'cloud-planner-deletion' }]
      })
      .mockResolvedValueOnce({ status: 'merged', backup: 'backup.json' });
    const f = setup({ check: vi.fn(async () => value), merge });
    await openComparison();
    click('cloud-review-merge');
    await vi.waitFor(() => expect(el('cloud-review-conflicts').hidden).toBe(false));
    expect(el('cloud-review-conflict-list').textContent).toContain('вместе с местными правками');
    expect(el('cloud-review-conflict-list').querySelector('img')).toBeNull();
    expect(el('cloud-review-list').querySelector('input').checked).toBe(false);
    el('cloud-review-list').querySelector('input').checked = true;
    click('cloud-review-resolve');
    await vi.waitFor(() => expect(merge).toHaveBeenCalledTimes(2));
    expect(merge.mock.calls[1][0].resolution.cloudRecords).toEqual([{ section: 'planner', id: ids.changed }]);
    expect(f.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('без галочки местная запись сохраняется, но согласование останавливается')
    );
  });

  it('оставляет объединение доступным после применения удаления даже при полном совпадении', async () => {
    const value = review();
    const prior = value.compare;
    value.compare = () => ({ ...prior(), differences: { entries: [], uncomparedSettings: [] } });
    state.settings.cloudSyncPendingApply = {
      version: 1,
      events: [
        {
          provider: 'yandex',
          datasetId: value.datasetId,
          pin,
          records: [{ section: 'planner', id: ids.changed }],
          settings: [],
          financeSettings: false
        }
      ]
    };
    setup({ check: vi.fn(async () => value) });
    await openComparison();
    expect(el('cloud-review-merge').hidden).toBe(false);
    expect(el('cloud-review-reconcile').hidden).toBe(false);
  });

  it('ясно предупреждает, что объединение всех поддерживаемых изменений не зависит от галочек', async () => {
    const merge = vi.fn(async () => ({ status: 'merged', backup: 'backup.json', newerHeadObserved: false }));
    const f = setup({ check: vi.fn(async () => mergeableReview()), merge });
    const applied = vi.fn();
    const reconciled = vi.fn();
    window.addEventListener('tf-cloud-applied', applied, { once: true });
    window.addEventListener('tf-cloud-reconciled', reconciled, { once: true });
    await openComparison();
    expect(el('cloud-review-merge').hidden).toBe(false);
    expect(el('cloud-review-list').querySelector('input').checked).toBe(false);
    click('cloud-review-merge');
    await vi.waitFor(() => expect(merge).toHaveBeenCalledOnce());
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('независимо от галочек'));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('а не по названиям или позициям'));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('теги и списки навигации'));
    expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('Конфликтующие списки требуют выбора стороны'));
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'yandex', pin, confirmed: true, settingsSelections: [] })
    );
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('Само объединение не отправляло'));
    expect(applied).toHaveBeenCalledOnce();
    expect(reconciled).toHaveBeenCalledOnce();
  });

  it('отмена и конфликт не очищают просмотр и не сообщают об успехе', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const merge = vi.fn(async () => ({ status: 'conflicts', conflictCount: 2 }));
    setup({ check: vi.fn(async () => mergeableReview()), merge, confirm });
    await openComparison();
    click('cloud-review-merge');
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('отменено'));
    expect(merge).not.toHaveBeenCalled();
    click('cloud-review-merge');
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('Конфликтов: 2'));
    expect(el('cloud-review-result').hidden).toBe(false);
  });

  it.each([true, false])('после показа конфликта явно использует выбранную сторону записи: облако=%s', async cloud => {
    const conflict = { section: 'planner', id: ids.changed, path: ['fields', 'title'], reason: 'field' };
    const merge = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'conflicts',
        conflictCount: 1,
        reviewHash: 'b'.repeat(64),
        conflicts: [conflict]
      })
      .mockResolvedValueOnce({ status: 'merged', backup: 'backup.json', newerHeadObserved: false });
    const f = setup({ check: vi.fn(async () => mergeableReview()), merge });
    await openComparison();
    click('cloud-review-merge');
    await vi.waitFor(() => expect(el('cloud-review-conflicts').hidden).toBe(false));
    expect(el('cloud-review-conflict-list').textContent).toContain('Задача');
    expect(el('cloud-review-conflict-list').textContent).toContain('title');
    el('cloud-review-list').querySelector('input').checked = cloud;
    click('cloud-review-resolve');
    await vi.waitFor(() => expect(merge).toHaveBeenCalledTimes(2));
    expect(f.confirm).toHaveBeenLastCalledWith(expect.stringContaining('в неотмеченных остаются местные'));
    expect(f.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('изменения внутри них с другой стороны могут быть потеряны')
    );
    expect(f.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('Изменение шаблона не меняет уже созданные марафоны')
    );
    expect(merge.mock.calls[1][0].resolution).toEqual({
      reviewHash: 'b'.repeat(64),
      cloudRecords: cloud ? [{ section: 'planner', id: ids.changed }] : [],
      cloudSettings: [],
      cloudFinanceSettings: false
    });
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('объединены'));
    expect(el('cloud-review-conflicts').hidden).toBe(true);
  });

  it('не разрешает неподдерживаемый конфликт порядка и устаревший показ очищает', async () => {
    const merge = vi.fn().mockResolvedValueOnce({
      status: 'conflicts',
      conflictCount: 1,
      reviewHash: 'c'.repeat(64),
      conflicts: [{ section: 'planner', path: ['order'], reason: 'concurrent-order' }]
    });
    setup({ check: vi.fn(async () => mergeableReview()), merge });
    await openComparison();
    click('cloud-review-merge');
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('нельзя безопасно разрешить'));
    expect(el('cloud-review-conflicts').hidden).toBe(true);
    click('cloud-review-resolve');
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('не отправляет изменённый выбор, пока открыто подтверждение разрешения конфликтов', async () => {
    const conflict = { section: 'planner', id: ids.changed, path: ['fields', 'title'], reason: 'field' };
    const merge = vi.fn(async () => ({
      status: 'conflicts',
      conflictCount: 1,
      reviewHash: 'd'.repeat(64),
      conflicts: [conflict]
    }));
    let release;
    const wait = new Promise(resolve => {
      release = resolve;
    });
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(wait);
    setup({ check: vi.fn(async () => mergeableReview()), merge, confirm });
    await openComparison();
    click('cloud-review-merge');
    await vi.waitFor(() => expect(el('cloud-review-conflicts').hidden).toBe(false));
    const box = el('cloud-review-list').querySelector('input');
    box.checked = true;
    click('cloud-review-resolve');
    box.checked = false; // Даже внешний скрипт во время окна не должен подменить выбор.
    release(true);
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('отменено'));
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('после перезапуска показывает намерение и продолжает с сохранёнными настройками, а не с текущими галочками', async () => {
    state.settings = addPendingConservativeMerge(state.settings, pendingMarker());
    const merge = vi.fn(async () => {
      delete state.settings.cloudSyncPendingMerge;
      return { status: 'merged', backup: 'backup.json', newerHeadObserved: true };
    });
    setup({ merge });
    expect(el('cloud-review-merge-pending').hidden).toBe(false);
    expect(el('cloud-review-merge-pending-message').textContent).toContain('Яндекс Диск');
    expect(el('cloud-review-merge-resume').disabled).toBe(false);
    click('cloud-review-merge-resume');
    await vi.waitFor(() => expect(merge).toHaveBeenCalledOnce());
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ pin, settingsSelections: ['appearance'], confirmed: true })
    );
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('более поздняя версия'));
    expect(el('cloud-review-merge-pending').hidden).toBe(true);
  });

  it('предлагает отмену только для выбранного диска и показывает отказ после переноса очереди', async () => {
    state.settings = addPendingConservativeMerge(state.settings, pendingMarker());
    const cancelMerge = vi.fn(async () => ({ status: 'already_anchored' }));
    setup({ cancelMerge });
    change('cloud-registration-provider', 'google');
    expect(el('cloud-review-merge-cancel').disabled).toBe(true);
    expect(el('cloud-review-merge-pending-message').textContent).toContain('Выберите этот диск');
    change('cloud-registration-provider', 'yandex');
    click('cloud-review-merge-cancel');
    await vi.waitFor(() => expect(el('cloud-review-status').textContent).toContain('отмена небезопасна'));
    expect(cancelMerge).toHaveBeenCalledOnce();
    expect(el('cloud-review-merge-pending').hidden).toBe(false);
  });

  it('повреждённая отметка не скрывается и отключает действия по ней', () => {
    state.settings.cloudSyncPendingMerge = { version: 100 };
    setup();
    expect(el('cloud-review-merge-pending').hidden).toBe(false);
    expect(el('cloud-review-merge-pending-message').textContent).toContain('повреждена');
    expect(el('cloud-review-merge-resume').disabled).toBe(true);
    expect(el('cloud-review-merge-cancel').disabled).toBe(true);
  });
});
