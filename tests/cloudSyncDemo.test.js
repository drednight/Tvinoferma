// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogSources, registerLogSource } from '../demo/app/replica/js/core/logHub.js';
import { createDemoCloudLogSource } from '../demo/cloud-sync/logSource.js';
import { mountCloudSyncDemo } from '../demo/cloud-sync/view.js';
import { DemoDiskWorkflow } from '../demo/cloud-sync/workflow.js';

let root;
let demo;
let journal;
const $ = selector => root.querySelector(selector);
const click = selector => {
  const element = $(selector);
  expect(element, `Не найдена кнопка ${selector}`).not.toBeNull();
  element.click();
};
const change = (selector, checked = true) => {
  const element = $(selector);
  expect(element, `Не найден переключатель ${selector}`).not.toBeNull();
  element.checked = checked;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const openPanel = () => click('[data-cs-toggle]');
const checkDisk = () => click('[data-cs-check]');

function fakeModalSupport() {
  const prototype = HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close');
  const matches = Element.prototype.matches;
  Object.defineProperty(prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
      this.__testModal = true;
    }
  });
  Object.defineProperty(prototype, 'close', {
    configurable: true,
    value() {
      this.open = false;
      this.__testModal = false;
      this.dispatchEvent(new Event('close'));
    }
  });
  const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector) {
    if (selector === ':modal') return this.tagName === 'DIALOG' && this.open && this.__testModal === true;
    return matches.call(this, selector);
  });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.matches('[data-cloud-account-label], .tf-cloud-account-body')) return new DOMRect(10, 10, 200, 100);
    return rect.call(this);
  });
  return () => {
    rectSpy.mockRestore();
    spy.mockRestore();
    if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow);
    else delete prototype.showModal;
    if (originalClose) Object.defineProperty(prototype, 'close', originalClose);
    else delete prototype.close;
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="demo"></div>';
  root = document.getElementById('demo');
  journal = createDemoCloudLogSource();
  demo = mountCloudSyncDemo(root, {
    onLog: journal.add,
    onReset: journal.clear,
    openLog: journal.open,
    getLogs: journal.getEntries,
    subscribeLogs: journal.subscribe
  });
});

afterEach(() => {
  demo.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('макет выбора диска и входящих обновлений', () => {
  it('при каждом открытии страницы свёрнут и не содержит учебных виртуальных ПК', () => {
    expect($('[data-cs-panel]').open).toBe(false);
    expect(root.textContent).toContain('Синхронизация между ПК');
    expect(root.textContent).toContain('Только демонстрация');
    expect(root.textContent).toContain('Google Диск');
    expect(root.textContent).toContain('Яндекс Диск');
    expect(root.textContent).toContain('Вход планируется в системном браузере');
    expect(root.textContent).toContain('Если доступ истечёт или будет отозван');
    expect(root.textContent).toContain('Локальные данные при этом не удаляются');
    expect(root.textContent).not.toContain('Попробуйте на двух ПК');
    expect(root.querySelector('[data-cs-scenario]')).toBeNull();
    expect(root.querySelector('[data-cs-connect]')).toBeNull();
    openPanel();
    expect($('[data-cs-panel]').open).toBe(true);
    click('[data-cs-toggle]');
    expect($('[data-cs-panel]').open).toBe(false);
    demo.destroy();
    demo = mountCloudSyncDemo(root);
    expect($('[data-cs-panel]').open).toBe(false);
  });

  it('показывает пример проверки выбранного аккаунта без входа, сети, сохранения и журнала', async () => {
    const restore = fakeModalSupport();
    try {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const storage = vi.spyOn(Storage.prototype, 'setItem');
      openPanel();
      click('[data-cs-account-example]');
      let dialog = document.querySelector('.tf-cloud-account-dialog');
      expect(dialog.textContent).toContain('ВЫМЫШЛЕННЫЙ ПРИМЕР');
      expect(dialog.querySelector('[data-cloud-account-label]').textContent).toBe('primer@example.test');
      expect(dialog.querySelector('[data-cloud-account-confirm]').disabled).toBe(true);
      const checkbox = dialog.querySelector('[data-cloud-account-ack]');
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      dialog.querySelector('[data-cloud-account-confirm]').click();
      await vi.waitFor(() => expect(root.textContent).toContain('Пример подтверждён'));
      expect(root.textContent).toContain('Не подключён');
      expect(root.querySelector('[data-cs-connect]')).toBeNull();
      expect(journal.getEntries()).toEqual([]);

      change('[data-cs-provider="yandex"]');
      click('[data-cs-account-example]');
      dialog = document.querySelector('.tf-cloud-account-dialog');
      expect(dialog.textContent).toContain('Логин аккаунта Яндекса');
      expect(dialog.querySelector('[data-cloud-account-label]').textContent).toBe('primer-tvinoferma');
      dialog.querySelector('[data-cloud-account-cancel]').click();
      await vi.waitFor(() => expect(root.textContent).toContain('Пример подтверждения закрыт'));
      expect(journal.getEntries()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('при уничтожении или перерисовке макета убирает устаревшее окно примера', async () => {
    const restore = fakeModalSupport();
    try {
      openPanel();
      click('[data-cs-account-example]');
      const stale = document.querySelector('.tf-cloud-account-dialog');
      change('[data-cs-provider="yandex"]');
      expect(stale.isConnected).toBe(false);
      expect(stale.querySelector('[data-cloud-account-label]').textContent).toBe('');
      await Promise.resolve();
      expect(root.textContent).toContain('Для другого диска');
      click('[data-cs-account-example]');
      expect(document.querySelector('.tf-cloud-account-dialog')).not.toBeNull();
      demo.destroy();
      expect(document.querySelector('.tf-cloud-account-dialog')).toBeNull();
      await Promise.resolve();
      expect(root.innerHTML).toBe('');
      expect(journal.getEntries()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('даёт две отдельные кнопки и не показывает различия до проверки', () => {
    openPanel();
    expect($('[data-cs-upload]').textContent).toContain('Сохранить и отправить на диск');
    expect($('[data-cs-check]').textContent).toContain('Проверить обновления');
    expect($('[data-cs-auto="check"]').checked).toBe(true);
    expect($('[data-cs-auto="upload"]').checked).toBe(true);
    expect(root.textContent).toContain('не применяются без вашего выбора');
    expect(root.querySelector('[data-cs-diff]')).toBeNull();
    checkDisk();
    expect(root.querySelectorAll('[data-cs-diff]')).toHaveLength(6);
    expect(root.textContent).toContain('Отметка за 28 октября');
    expect(root.textContent).toContain('Прогресс с сайта');
    expect($('[data-cs-update]').disabled).toBe(true);
    expect(root.querySelectorAll('[data-cs-select]:checked')).toHaveLength(0);
  });

  it('после проверки показывает дату файла отдельно от времени проверки и локального сохранения', () => {
    demo.destroy();
    let now = Date.parse('2026-10-29T12:00:00Z');
    const example = new DemoDiskWorkflow({ now: () => now });
    demo = mountCloudSyncDemo(root, { exampleWorkflow: example });
    openPanel();
    expect(root.querySelector('[data-cs-review-times]')).toBeNull();
    checkDisk();
    expect($('[data-cs-file-date] time').getAttribute('datetime')).toBe('2026-10-29T10:00:00.000Z');
    expect($('[data-cs-checked-date] time').getAttribute('datetime')).toBe('2026-10-29T12:00:00.000Z');
    expect($('[data-cs-local-date] time').getAttribute('datetime')).toBe('2026-10-29T11:00:00.000Z');
    expect($('[data-cs-review-times]').textContent).toContain('Дата изменения по данным диска');
    expect($('[data-cs-file-date]').textContent).toContain('примерно 2 часа назад');
    expect($('[data-cs-review-times]').textContent).toContain('не доказывает, какая версия актуальнее');
    expect($('[data-cs-review-times]').textContent).toContain('часовому поясу этого ПК');
    now += 15 * 60 * 1000;
    checkDisk();
    expect($('[data-cs-file-date] time').getAttribute('datetime')).toBe('2026-10-29T10:00:00.000Z');
    expect($('[data-cs-checked-date] time').getAttribute('datetime')).toBe('2026-10-29T12:15:00.000Z');
  });

  it('сбрасывает даты просмотра при смене диска и отправке, не заменяя входящую версию исходящей', () => {
    demo.destroy();
    let now = Date.parse('2026-10-29T12:00:00Z');
    const example = new DemoDiskWorkflow({ now: () => now });
    demo = mountCloudSyncDemo(root, { exampleWorkflow: example });
    openPanel();
    checkDisk();
    change('[data-cs-provider="yandex"]');
    expect(demo.snapshot().reviewTimes).toBeNull();
    expect(root.querySelector('[data-cs-review-times]')).toBeNull();
    checkDisk();
    expect($('[data-cs-file-date] time').getAttribute('datetime')).toBe('2026-10-28T10:00:00.000Z');
    now += 5 * 60 * 1000;
    click('[data-cs-upload]');
    expect(root.querySelector('[data-cs-review-times]')).toBeNull();
    checkDisk();
    // Новая исходящая версия не заменяет старый файл с входящими изменениями.
    expect($('[data-cs-file-date] time').getAttribute('datetime')).toBe('2026-10-28T10:00:00.000Z');
    expect($('[data-cs-local-date] time').getAttribute('datetime')).toBe('2026-10-29T12:05:00.000Z');
    expect($('[data-cs-checked-date] time').getAttribute('datetime')).toBe('2026-10-29T12:05:00.000Z');
  });

  it('не выдумывает отсутствующую дату и предупреждает о заметном расхождении часов', () => {
    demo.destroy();
    const example = new DemoDiskWorkflow({ now: () => Date.parse('2026-10-29T12:00:00Z') });
    example.cloudModifiedAt.google = '<img src=x onerror=alert(1)>';
    demo = mountCloudSyncDemo(root, { exampleWorkflow: example });
    openPanel();
    checkDisk();
    expect($('[data-cs-file-date]').textContent).toContain('Дата недоступна');
    expect($('[data-cs-file-date]').querySelector('img')).toBeNull();
    expect(root.textContent).not.toContain('onerror');
    example.cloudModifiedAt.google = null;
    checkDisk();
    expect($('[data-cs-file-date]').textContent).toContain('Дата недоступна');
    expect(root.querySelector('.csc-time-warning')).toBeNull();
    example.cloudModifiedAt.google = '2026-10-29T12:06:00Z';
    checkDisk();
    expect($('.csc-time-warning').textContent).toContain('позже часов этого ПК');
    expect($('.csc-time-warning').textContent).toContain('по одной дате выбирать версию нельзя');
    example.cloudModifiedAt.google = '2026-10-29T15:05:00+03:00';
    checkDisk();
    expect(root.querySelector('.csc-time-warning')).toBeNull();
    example.cloudModifiedAt.google = '2026-10-29T15:05:00.001+03:00';
    checkDisk();
    expect($('.csc-time-warning').textContent).toContain('позже часов этого ПК');
  });

  it('объясняет запланированное поведение проверки и сохраняет открытую справку при сравнении', () => {
    openPanel();
    click('[data-cs-check-help-toggle]');
    expect($('[data-cs-check-help]').open).toBe(true);
    expect($('[data-cs-check-help]').textContent).toContain('В рабочей версии планируется');
    expect($('[data-cs-check-help]').textContent).toContain('не удалять данные на ПК');
    checkDisk();
    expect($('[data-cs-check-help]').open).toBe(true);
    click('[data-cs-check-help-toggle]');
    expect($('[data-cs-check-help]').open).toBe(false);
  });

  it('не меняет историческое время локальной копии после частичного выбора до новой проверки', () => {
    let now = Date.parse('2026-10-29T12:00:00Z');
    const example = new DemoDiskWorkflow({ now: () => now });
    example.check();
    example.select('task-new', true);
    now += 15 * 60 * 1000;
    expect(example.requestUpdate().status).toBe('updated');
    expect(example.snapshot().reviewTimes.localSavedAt).toBe('2026-10-29T11:00:00.000Z');
    example.check();
    expect(example.snapshot().reviewTimes.localSavedAt).toBe('2026-10-29T12:15:00.000Z');
  });

  it('отправка создаёт демонстрационную запись в отдельном источнике общего журнала', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    openPanel();
    click('[data-cs-upload]');
    expect(journal.getEntries()).toMatchObject([{ action: 'upload', provider: 'google', changes: [] }]);
    const source = getLogSources().find(item => item.id === 'cloud-sync-demo');
    expect(source.list()).toMatchObject([
      { title: 'Пример: отправка на диск', who: 'Google Диск', summary: 'Условная версия, настоящей отправки не было' }
    ]);
    expect($('.csc-history').textContent).toContain('Пример отправки');
    click('[data-cs-open-log]');
    expect(document.getElementById('modal-root').textContent).toContain('Синхронизация · пример');
    expect(document.getElementById('modal-root').textContent).toContain('Пример: отправка на диск');
    document.querySelector('#modal-root .tf-close').click();
    expect(fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('обновляет только выбранный пример, оставляет неотмеченные и пишет детальный журнал', () => {
    openPanel();
    checkDisk();
    change('[data-cs-select="task-status"]');
    expect($('[data-cs-update]').disabled).toBe(false);
    expect(root.textContent).toContain('Выбрано:');
    click('[data-cs-update]');
    expect(demo.snapshot().differences).toHaveLength(5);
    expect(demo.snapshot().differences.some(row => row.id === 'task-status')).toBe(false);
    expect(demo.snapshot().differences.some(row => row.id === 'task-new')).toBe(true);
    expect(demo.snapshot().differences.some(row => row.id === 'party-deleted')).toBe(true);
    expect(root.textContent).toContain('Неотмеченные различия остались без изменений');
    expect(journal.getEntries()).toMatchObject([
      { action: 'update', provider: 'google', changes: [{ section: 'Календарь', field: 'Отметка за 28 октября' }] }
    ]);
    const source = getLogSources().find(item => item.id === 'cloud-sync-demo');
    expect(source.list()[0]).toMatchObject({
      title: 'Пример: обновление с диска',
      summary: 'Выбрано изменений: 1'
    });
    source.open(source.list()[0]);
    expect(document.getElementById('modal-root').textContent).toContain('Отметка за 28 октября');
    expect(document.getElementById('modal-root').textContent).toContain('настоящих изменений и передачи не было');
    document.querySelector('#modal-root .tf-close').click();
    checkDisk();
    expect(root.querySelectorAll('[data-cs-diff]')).toHaveLength(5);
    expect($('[data-cs-select="task-new"]')).not.toBeNull();
  });

  it('удаление требует отдельного подтверждения; отмена и изменение выбора не применяют его', () => {
    openPanel();
    checkDisk();
    change('[data-cs-select="party-deleted"]');
    click('[data-cs-update]');
    expect(root.textContent).toContain('В выборе есть удаление: 1');
    expect(demo.snapshot().differences).toHaveLength(6);
    expect(journal.getEntries()).toHaveLength(0);
    click('[data-cs-cancel-delete]');
    expect(demo.snapshot().differences).toHaveLength(6);
    expect($('[data-cs-select="party-deleted"]').checked).toBe(true);
    click('[data-cs-update]');
    change('[data-cs-select="task-new"]');
    expect(root.querySelector('[data-cs-confirm-delete]')).toBeNull();
    expect(demo.snapshot().differences).toHaveLength(6);
    click('[data-cs-update]');
    click('[data-cs-confirm-delete]');
    expect(demo.snapshot().differences).toHaveLength(4);
    expect(journal.getEntries()[0].changes.map(item => item.kind)).toEqual(['added', 'deleted']);
  });

  it('защищает подтверждение удаления и при прямом вызове учебной модели', () => {
    const model = new DemoDiskWorkflow();
    model.check();
    model.select('party-deleted', true);
    expect(model.applySelected()).toMatchObject({ status: 'confirm-deletion' });
    expect(model.confirmDeletion()).toMatchObject({ status: 'nothing-selected' });
    expect(model.snapshot().differences).toHaveLength(6);
    model.requestUpdate();
    expect(model.confirmDeletion().status).toBe('updated');
    expect(model.snapshot().differences).toHaveLength(5);
  });

  it('обновление, в том числе удаление, не вызывает сеть или настоящее хранилище', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    openPanel();
    checkDisk();
    change('[data-cs-select="party-deleted"]');
    click('[data-cs-update]');
    click('[data-cs-confirm-delete]');
    click('[data-cs-reset]');
    expect(fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('предупреждает, если запись примера не попала в общий журнал', () => {
    demo.destroy();
    demo = mountCloudSyncDemo(root, {
      onLog: () => {
        throw new Error('журнал недоступен');
      }
    });
    openPanel();
    click('[data-cs-upload]');
    expect($('.csc-feedback').textContent).toContain('не удалось добавить в общий демо-журнал');
    expect(demo.snapshot().logs).toHaveLength(1);
  });

  it('переключение диска и отправка сбрасывают устаревший просмотр и выбор', () => {
    openPanel();
    checkDisk();
    change('[data-cs-select="task-new"]');
    change('[data-cs-provider="yandex"]');
    expect(demo.snapshot()).toMatchObject({ provider: 'yandex', checked: false, selected: [] });
    expect(root.querySelector('[data-cs-diff]')).toBeNull();
    expect(root.textContent).toContain('старый выбор сброшен');
    click('[data-cs-upload]');
    expect(journal.getEntries()[0]).toMatchObject({ provider: 'yandex', action: 'upload' });
    checkDisk();
    change('[data-cs-select="task-status"]');
    click('[data-cs-upload]');
    expect(demo.snapshot()).toMatchObject({ checked: false, selected: [] });
    expect(root.querySelector('[data-cs-update]')).toBeNull();
    checkDisk();
    expect($('[data-cs-select="task-status"]').checked).toBe(false);
  });

  it('фильтры не снимают выбор, показывают количество и сохраняют фокус', () => {
    openPanel();
    checkDisk();
    change('[data-cs-select="coin-balance"]');
    const calendar = $('[data-cs-filter="calendar"]');
    calendar.focus();
    calendar.click();
    expect(document.activeElement).toBe($('[data-cs-filter="calendar"]'));
    expect($('[data-cs-filter="calendar"]').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelectorAll('[data-cs-diff]')).toHaveLength(3);
    expect(root.textContent).toContain('скрыто фильтром: 1');
    expect(demo.snapshot().selected).toEqual(['coin-balance']);
    click('[data-cs-clear-all]');
    expect(demo.snapshot().selected).toEqual([]);
    expect($('[data-cs-update]').disabled).toBe(true);
  });

  it('выбирает и снимает все различия без применения и отдельно подтверждает удаление', () => {
    openPanel();
    checkDisk();
    expect($('[data-cs-select-all]').textContent).toBe('Выбрать все');
    expect($('[data-cs-clear-all]').textContent).toBe('Снять все');
    expect($('[data-cs-clear-all]').disabled).toBe(true);
    $('[data-cs-select-all]').focus();
    click('[data-cs-select-all]');
    expect(demo.snapshot().selected).toHaveLength(6);
    expect(root.querySelectorAll('[data-cs-select]:checked')).toHaveLength(6);
    expect($('[data-cs-select-all]').disabled).toBe(true);
    expect(document.activeElement).toBe($('[data-cs-clear-all]'));
    expect(journal.getEntries()).toHaveLength(0);
    click('[data-cs-update]');
    expect(demo.snapshot().differences).toHaveLength(6);
    expect(root.textContent).toContain('В выборе есть удаление: 1');
    expect($('.csc-confirm').textContent).toContain('Пати · Старый состав');
    expect($('.csc-confirm').textContent).toContain('все выбранные изменения');
    click('[data-cs-cancel-delete]');
    click('[data-cs-clear-all]');
    expect(demo.snapshot().selected).toEqual([]);
    expect($('[data-cs-clear-all]').disabled).toBe(true);
    expect($('[data-cs-update]').disabled).toBe(true);
    expect(demo.snapshot().differences).toHaveLength(6);
    expect(journal.getEntries()).toHaveLength(0);
  });

  it('массовый выбор не срабатывает до проверки и игнорирует неизвестные строки', () => {
    const model = new DemoDiskWorkflow();
    model.selectVisible(['task-new']);
    expect(model.snapshot().selected).toEqual([]);
    model.check();
    model.selectVisible(['task-new', 'несуществующая-запись']);
    expect(model.snapshot().selected).toEqual(['task-new']);
    model.clearSelection();
    expect(model.snapshot().selected).toEqual([]);
  });

  it('выбирает все показанные при фильтре, а снимает все, в том числе скрытые отметки', () => {
    openPanel();
    checkDisk();
    change('[data-cs-select="coin-balance"]');
    click('[data-cs-filter="calendar"]');
    expect(root.textContent).toContain('«Выбрать все» отмечает показанные различия');
    click('[data-cs-select-all]');
    expect(demo.snapshot().selected).toEqual(
      expect.arrayContaining(['coin-balance', 'task-new', 'event-new', 'task-status'])
    );
    expect(demo.snapshot().selected).toHaveLength(4);
    expect(demo.snapshot().selected).not.toContain('party-deleted');
    expect(root.textContent).toContain('скрыто фильтром: 1');
    click('[data-cs-filter="deleted"]');
    click('[data-cs-select-all]');
    expect(demo.snapshot().selected).toHaveLength(5);
    expect(root.textContent).toContain('скрыто фильтром: 4');
    click('[data-cs-update]');
    expect($('.csc-confirm').textContent).toContain('Пати · Старый состав');
    expect(demo.snapshot().differences).toHaveLength(6);
    click('[data-cs-clear-all]');
    expect(demo.snapshot().selected).toEqual([]);
    expect(root.querySelector('[data-cs-confirm-delete]')).toBeNull();
    expect(demo.snapshot().differences).toHaveLength(6);
    expect(journal.getEntries()).toHaveLength(0);
  });

  it('показывает пароль с созданным запасным ключом по умолчанию, без ввода секретов', () => {
    openPanel();
    expect($('[data-cs-key-primary="password"]').checked).toBe(true);
    expect($('[data-cs-key-primary="custom"]').checked).toBe(false);
    expect($('[data-cs-key-backup="generated"]').checked).toBe(true);
    expect($('[data-cs-key-backup="custom"]').checked).toBe(false);
    expect($('[data-cs-key-preview="primary"]').disabled).toBe(true);
    expect($('[data-cs-key-preview="primary"]').value).toBe('');
    expect($('[data-cs-key-preview="backup"]')).toBeNull();
    expect(root.textContent).toContain('ввод, создание, проверка и восстановление ключей в макете отключены');
  });

  it('независимо выбирает свои основной и запасной ключи и не принимает настоящие секреты', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    openPanel();
    $('[data-cs-key-primary="custom"]').focus();
    change('[data-cs-key-primary="custom"]');
    expect(document.activeElement).toBe($('[data-cs-key-primary="custom"]'));
    expect($('[data-cs-key-primary="custom"]').checked).toBe(true);
    expect($('[data-cs-key-backup="generated"]').checked).toBe(true);
    expect($('.csc-key-preview').textContent).toContain('Ваш основной ключ');
    change('[data-cs-key-backup="custom"]');
    expect($('[data-cs-key-backup="custom"]').checked).toBe(true);
    expect($('.csc-key-preview').textContent).toContain('Ваш запасной ключ');
    expect(root.querySelectorAll('[data-cs-key-preview]')).toHaveLength(2);
    for (const input of root.querySelectorAll('[data-cs-key-preview]')) {
      expect(input.type).toBe('password');
      expect(input.disabled).toBe(true);
      expect(input.value).toBe('');
    }
    expect(root.textContent).toContain('Основной и запасной секреты должны быть разными и надёжными');
    checkDisk();
    expect($('[data-cs-key-primary="custom"]').checked).toBe(true);
    expect($('[data-cs-key-backup="custom"]').checked).toBe(true);
    change('[data-cs-key-primary="password"]');
    expect($('[data-cs-key-primary="password"]').checked).toBe(true);
    expect($('[data-cs-key-backup="custom"]').checked).toBe(true);
    change('[data-cs-key-primary="custom"]');
    change('[data-cs-key-backup="generated"]');
    expect($('[data-cs-key-primary="custom"]').checked).toBe(true);
    expect($('[data-cs-key-backup="generated"]').checked).toBe(true);
    change('[data-cs-key-backup="custom"]');
    click('[data-cs-reset]');
    expect($('[data-cs-key-primary="password"]').checked).toBe(true);
    expect($('[data-cs-key-backup="generated"]').checked).toBe(true);
    expect($('[data-cs-key-preview="backup"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(journal.getEntries()).toEqual([]);
  });

  it('объясняет потерю обоих ключей и не выполняет перезапуск или удаление в макете', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    openPanel();
    expect($('[data-cs-key-loss]').open).toBe(false);
    $('[data-cs-key-loss-toggle]').focus();
    click('[data-cs-key-loss-toggle]');
    expect($('[data-cs-key-loss]').open).toBe(true);
    expect(document.activeElement).toBe($('[data-cs-key-loss-toggle]'));
    expect($('[data-cs-key-loss]').textContent).toContain('Старый файл на диске удалять не требуется');
    expect($('[data-cs-key-loss]').textContent).toContain('резервная копия и новая синхронизация');
    expect($('[data-cs-key-loss]').textContent).toContain('старую облачную копию расшифровать не получится');
    expect($('[data-cs-key-loss]').textContent).toContain('данные восстановить нельзя');
    expect($('[data-cs-key-loss-restart]').disabled).toBe(true);
    change('[data-cs-key-primary="custom"]');
    expect($('[data-cs-key-loss]').open).toBe(true);
    click('[data-cs-reset]');
    expect($('[data-cs-key-loss]').open).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(journal.getEntries()).toEqual([]);
  });

  it('контакты и пароли выключены и выбираются отдельно с предупреждением', () => {
    openPanel();
    for (const key of ['email', 'recoveryEmail', 'phone', 'password'])
      expect($(`[data-cs-secrets="${key}"]`).checked).toBe(false);
    change('[data-cs-secrets="email"]');
    expect($('[data-cs-secrets="email"]').checked).toBe(true);
    expect($('[data-cs-secrets="phone"]').checked).toBe(false);
    change('[data-cs-secrets="password"]');
    expect(root.textContent).toContain('отдельное подтверждение риска');
    expect(root.textContent).toContain('ключ восстановления хранится отдельно от диска');
    checkDisk();
    expect($('[data-cs-secrets="email"]').checked).toBe(true);
    expect($('[data-cs-secrets="password"]').checked).toBe(true);
  });

  it('очистка общего демо-журнала и сброс не затрагивают другие источники', () => {
    registerLogSource({
      id: 'unrelated-demo',
      title: 'Другой источник',
      list: () => [{ key: 'keep', title: 'Сохранить эту запись' }],
      open: () => {}
    });
    openPanel();
    click('[data-cs-upload]');
    const source = getLogSources().find(item => item.id === 'cloud-sync-demo');
    expect(source.list()).toHaveLength(1);
    source.clear();
    expect(source.list()).toHaveLength(0);
    expect($('.csc-history').textContent).toContain('После действий в примере');
    expect(demo.snapshot().logs).toHaveLength(0);
    click('[data-cs-upload]');
    change('[data-cs-provider="yandex"]');
    change('[data-cs-secrets="password"]');
    click('[data-cs-reset]');
    expect(journal.getEntries()).toHaveLength(0);
    expect(
      getLogSources()
        .find(item => item.id === 'unrelated-demo')
        .list()
    ).toHaveLength(1);
    expect(demo.snapshot()).toMatchObject({ provider: 'google', checked: false, selected: [], logs: [] });
    expect($('[data-cs-secrets="password"]').checked).toBe(false);
    expect($('[data-cs-panel]').open).toBe(true);
  });
});
