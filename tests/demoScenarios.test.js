// Демо остаётся отдельным прототипом: эти тесты проверяют его реальное поведение,
// а не наличие текста в файлах. Все задержки имитации управляются fake timers.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { closeModalRoot } from '../js/core/modalLifecycle.js';
import { getClassIconSrc } from '../js/core/constants.js';
import { CHARS, stripeCls } from '../demo/lab-data.js';
import { openScenario, openTransferSplit, openShopSplit, openCaravanSplit } from '../demo/scenarios.js';

const click = element => {
  expect(element).toBeTruthy();
  element.click();
};
const change = (element, value) => {
  expect(element).toBeTruthy();
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const input = (element, value) => {
  expect(element).toBeTruthy();
  element.value = String(value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};
const finish = async () => {
  await vi.runAllTimersAsync();
};
const content = dlg => dlg.el.textContent.replace(/\s+/g, ' ');
const scan = async dlg => {
  expect(dlg.body.getAttribute('aria-busy')).toBe('true');
  await finish();
  expect(dlg.body.getAttribute('aria-busy')).toBeNull();
  expect(content(dlg)).toContain('Демо-проверка');
};
const mode = (dlg, value) => {
  const radio = dlg.body.querySelector(`input[name^="tg-"][value="${value}"]`);
  click(radio);
};

describe('Лаборатория, вариант B', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  });
  afterEach(async () => {
    closeModalRoot(document.getElementById('modal-root'));
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('на странице остался только вариант B; иконки всех классов существуют', () => {
    const page = readFileSync('demo/tools-modals.html', 'utf8');
    const doc = new DOMParser().parseFromString(page, 'text/html');
    expect([...doc.querySelectorAll('[data-open-variant]')].map(b => b.dataset.openVariant)).toEqual(['split']);
    expect(doc.querySelectorAll('[data-script-pick]')).toHaveLength(4);
    for (const c of CHARS) expect(existsSync(`public/${getClassIconSrc(c.cls)}`), c.nick).toBe(true);
    expect(new Set(CHARS.map(stripeCls))).toEqual(new Set(['st-online', 'st-offline', 'st-checking']));
    expect(readFileSync('demo/tools-modals.css', 'utf8')).toMatch(/\.promo-list\[hidden\]\s*\{\s*display:\s*none/);
  });

  it.each([
    ['transfer', openTransferSplit],
    ['shop', openShopSplit],
    ['caravan', openCaravanSplit]
  ])('%s: ручной выбор открывается отдельно и применяется только после сохранения', async (_, open) => {
    const dlg = open();
    expect(dlg.el.querySelector('.sp-container')).toBeTruthy();
    expect(dlg.foot.querySelector('[data-act="start"]')).toBeNull();
    await scan(dlg);
    const parties = () => dlg.body.querySelector('[data-tg-parties]');
    const manual = () => dlg.body.querySelector('[data-tg-manual]');
    expect(parties().hidden).toBe(true);
    expect(manual().hidden).toBe(true);
    mode(dlg, 'party');
    expect(parties().hidden).toBe(false);
    expect(manual().hidden).toBe(true);
    expect(parties().querySelectorAll('[data-party]')).toHaveLength(2);

    mode(dlg, 'manual');
    const picker = document.querySelector('.cp-dialog');
    expect(picker).toBeTruthy();
    expect(picker.querySelectorAll('[data-picker-id]')).toHaveLength(CHARS.length);
    expect(picker.querySelectorAll('.char-class-ico')).toHaveLength(CHARS.length);
    expect(dlg.el.inert).toBe(true);
    expect(dlg.body.querySelector('input[value="party"]').checked).toBe(true);
    expect(parties().hidden).toBe(false); // план не меняется до сохранения
    click(picker.querySelector('[data-picker-save]'));
    expect(document.querySelector('.cp-dialog')).toBeNull();
    expect(dlg.el.inert).toBe(false);
    expect(dlg.body.querySelector('input[value="manual"]').checked).toBe(true);
    expect(parties().hidden).toBe(true);
    expect(manual().hidden).toBe(false);
    expect(manual().textContent).toContain('Выбрано: 6');
    expect(manual().querySelectorAll('input')).toHaveLength(0);

    mode(dlg, 'all');
    expect(parties().hidden).toBe(true);
    expect(manual().hidden).toBe(true);
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    await scan(dlg);
  });

  it('передача: полный список, обязательные сервер и получатель, общий аккаунт один раз', async () => {
    const dlg = openTransferSplit();
    await scan(dlg);
    expect(content(dlg)).toContain('Камень светлого духа');
    expect(content(dlg)).toContain('Подарок акции');
    expect(dlg.foot.querySelector('[data-act="start"]').disabled).toBe(true);
    for (const id of ['c1', 'c2']) {
      change(dlg.body.querySelector(`[data-server="${id}"]`), '1');
      change(dlg.body.querySelector(`[data-recipient="${id}"]`), '1_1_1');
    }
    expect(dlg.body.querySelector('[data-transfer-result="c1"]').textContent).toContain('Готово');
    expect(dlg.body.querySelector('[data-transfer-result="c2"]').textContent).toContain('Тот же аккаунт');
    expect(dlg.foot.querySelector('[data-act="start"]').disabled).toBe(false);
    click(dlg.foot.querySelector('[data-act="dry"]'));
    await finish();
    expect(content(dlg)).toContain('ничего не передано');
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    await finish();
    expect(content(dlg)).toContain('Камень светлого духа'); // пробный запуск не меняет пример
  });

  it('подарки: восемь настоящих названий, описания, расчёт по аккаунту и остаток', async () => {
    const dlg = openShopSplit();
    await scan(dlg);
    expect(dlg.body.querySelectorAll('[data-item]')).toHaveLength(8);
    expect(content(dlg)).toContain('Камень светлого духа');
    expect(content(dlg)).toContain('инкрустации экипировки');
    expect(dlg.body.querySelector('[data-item="focus"]').disabled).toBe(true);
    expect(content(dlg)).toContain('Звеномир');
    expect(content(dlg)).toContain('Тихомир'); // один общий аккаунт
    expect(dlg.body.querySelectorAll('[data-shop-sum="acc:site-1"]')).toHaveLength(1);
    const light = dlg.body.querySelector('[data-qty="acc:site-4|light"]');
    input(light, 1); // 40 монет при балансе 15
    input(dlg.body.querySelector('[data-qty="acc:site-4|valor"]'), 2); // 10 за штуку
    expect(dlg.body.querySelector('[data-calc="acc:site-4|light"]').textContent).toContain('купится 0 из 1');
    expect(dlg.body.querySelector('[data-calc="acc:site-4|valor"]').textContent).toContain('купится 1 из 2');
    expect(dlg.body.querySelector('[data-shop-sum="acc:site-4"]').textContent).toContain('Останется: 5');
    expect(dlg.body.querySelector('[data-qty="acc:site-4|light"]')).toBe(light); // курсор не теряется при вводе
    expect(dlg.foot.querySelector('[data-act="start"]').disabled).toBe(false);
    click(dlg.foot.querySelector('[data-act="dry"]'));
    await finish();
    expect(content(dlg)).toContain('баланс не изменён');
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    await finish();
    expect(content(dlg)).toContain('15 мон.');
  });

  it('подарки: реальный (демо) запуск меняет только пример и требует обновления', async () => {
    const dlg = openShopSplit();
    await scan(dlg);
    input(dlg.body.querySelector('[data-qty="acc:site-4|valor"]'), 1);
    click(dlg.foot.querySelector('[data-act="start"]'));
    click(document.querySelector('.tf-confirm-overlay [data-act="ok"]'));
    await finish();
    expect(content(dlg)).toContain('осталось 5 мон.');
    expect(dlg.foot.querySelector('[data-act="start"]').disabled).toBe(true);
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    await finish();
    const row = dlg.body.querySelector('[data-shop-sum="acc:site-4"]').closest('tr');
    expect(row.textContent).toContain('5 мон.');
    expect(row.textContent).toContain('не хватает монет');
  });

  it('демо-покупка: имитация ошибки, таблица и повтор только невыполненного аккаунта', async () => {
    const dlg = openShopSplit();
    await scan(dlg);
    input(dlg.body.querySelector('[data-qty="acc:site-4|valor"]'), 1);
    click(dlg.body.querySelector('[data-demo-fail]'));
    click(dlg.foot.querySelector('[data-act="start"]'));
    click(document.querySelector('.tf-confirm-overlay [data-act="ok"]'));
    await finish();
    expect(content(dlg)).toContain('Демо-ошибка до покупки');
    expect(dlg.foot.querySelector('[data-act="retry"]')).toBeTruthy();
    click(dlg.foot.querySelector('[data-act="report"]'));
    expect(document.querySelectorAll('.tf-dialog')).toHaveLength(2);
    expect([...document.querySelectorAll('.tf-dialog')].at(-1).textContent).toContain('Таблица действий');
    click(document.querySelector('[data-sr-close]'));
    click(dlg.foot.querySelector('[data-act="retry"]'));
    click(document.querySelector('.tf-confirm-overlay [data-act="ok"]'));
    await finish();
    expect(content(dlg)).toContain('В демо куплено 1 шт.');
    expect(dlg.foot.querySelector('[data-act="retry"]')).toBeNull();
    click(dlg.foot.querySelector('[data-act="report"]'));
    expect(document.querySelectorAll('.sr-table tbody tr').length).toBeGreaterThanOrEqual(2);
  });

  it('демо-караван: повтор не открывает уже выполненные сундуки', async () => {
    const dlg = openCaravanSplit();
    await scan(dlg);
    click(dlg.body.querySelector('[data-demo-fail]'));
    click(dlg.foot.querySelector('[data-act="start"]'));
    click(document.querySelector('.tf-confirm-overlay [data-act="ok"]'));
    await finish();
    expect(dlg.foot.querySelector('[data-act="retry"]')).toBeTruthy();
    click(dlg.foot.querySelector('[data-act="retry"]'));
    click(document.querySelector('.tf-confirm-overlay [data-act="ok"]'));
    await finish();
    click(dlg.foot.querySelector('[data-act="report"]'));
    expect([...document.querySelectorAll('.tf-dialog')].at(-1).textContent).toContain('Сундук №пример');
  });

  it('дополнительное окно описания закрывается по Escape, родитель остаётся', async () => {
    const dlg = openShopSplit();
    await scan(dlg);
    click(dlg.body.querySelector('[data-info="camp"]'));
    expect(document.querySelectorAll('#modal-root .modal-overlay')).toHaveLength(2);
    expect(document.querySelector('#modal-root .modal-overlay:last-child').textContent).toContain('показатель защиты');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelectorAll('#modal-root .modal-overlay')).toHaveLength(1);
    expect(dlg.el.isConnected).toBe(true);
  });

  it('караван: пробное открытие не меняет инвентарь; повторное чтение доступно', async () => {
    const dlg = openCaravanSplit();
    await scan(dlg);
    expect(content(dlg)).toContain('К открытию: 2');
    expect(content(dlg)).toContain('Общий инвентарь');
    click(dlg.foot.querySelector('[data-act="dry"]'));
    await finish();
    expect(content(dlg)).toContain('ничего не открыто');
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    await finish();
    expect(content(dlg)).toContain('К открытию: 2');
  });

  it('передача: после демо-операции обновление учитывает общий инвентарь', async () => {
    const dlg = openTransferSplit();
    await scan(dlg);
    for (const id of ['c1', 'c2']) {
      change(dlg.body.querySelector(`[data-server="${id}"]`), '1');
      change(dlg.body.querySelector(`[data-recipient="${id}"]`), '1_1_1');
    }
    click(dlg.foot.querySelector('[data-act="start"]'));
    click(document.querySelector('.tf-confirm-overlay [data-act="ok"]'));
    await finish();
    expect(content(dlg)).toContain('Передано в демо');
    expect(dlg.foot.querySelector('[data-act="start"]').disabled).toBe(true);
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    await finish();
    const first = dlg.body.querySelector('[data-server="c1"]').closest('tr');
    const second = dlg.body.querySelector('[data-server="c2"]').closest('tr');
    expect(first.textContent).toContain('Нет предметов к передаче');
    expect(second.textContent).toContain('Нет предметов к передаче');
  });

  it('промокоды: ручной выбор открывается в том же окне, сохранение пересчитывает план', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="lab-tools-replica"></div>');
    await import('../demo/tools-modals.js');
    click(document.querySelector('[data-replica="promo"]'));
    const parent = document.querySelector('.sp-container').closest('.modal-overlay');
    const manual = () => parent.querySelector('[data-tg-manual]');
    const parties = () => parent.querySelector('[data-tg-parties]');
    expect(manual().hidden).toBe(true);
    expect(parties().hidden).toBe(true);
    click(parent.querySelector('input[name="tg-sp"][value="manual"]'));
    let picker = document.querySelector('.cp-dialog');
    expect(picker).toBeTruthy();
    click(picker.querySelector('[data-picker-none]'));
    click(picker.querySelector('[data-picker-id="c3"]'));
    click(picker.querySelector('[data-picker-save]'));
    expect(manual().hidden).toBe(false);
    expect(manual().textContent).toContain('Выбрано: 1');
    expect(parent.querySelector('#sp-chars').textContent).toBe('1');
    expect(parent.querySelector('#sp-table').textContent).toContain('Радовика');
    expect(parent.querySelector('#sp-table').textContent).not.toContain('Звеномир');
    click(parent.querySelector('[data-tg-edit]'));
    picker = document.querySelector('.cp-dialog');
    expect(picker.querySelector('[data-picker-id="c3"]').checked).toBe(true);
    click(picker.querySelector('[data-picker-cancel]'));
    click(parent.querySelector('input[name="tg-sp"][value="party"]'));
    expect(manual().hidden).toBe(true);
    expect(parties().hidden).toBe(false);
    click(parent.querySelector('.tf-dialog-foot [data-act="refresh"]'));
    await finish();
    expect(parent.querySelector('#sp-status').textContent).toContain('Демо-проверка статусов завершена');
  });

  it('отмена выбора сохраняет предыдущую пати, повторное нажатие открывает окно, закрытие родителя убирает его', async () => {
    const dlg = openTransferSplit();
    await scan(dlg);
    mode(dlg, 'party');
    const before = dlg.body.querySelector('[data-table]').textContent;
    mode(dlg, 'manual');
    click(document.querySelector('.cp-dialog [data-picker-id="c3"]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dlg.body.querySelector('input[value="party"]').checked).toBe(true);
    expect(dlg.body.querySelector('[data-tg-parties]').hidden).toBe(false);
    expect(dlg.body.querySelector('[data-table]').textContent).toBe(before);

    mode(dlg, 'manual');
    click(document.querySelector('.cp-dialog [data-picker-save]'));
    expect(dlg.body.querySelector('input[value="manual"]').checked).toBe(true);
    mode(dlg, 'manual'); // радио уже выбрано, но выбор можно открыть снова
    expect(document.querySelector('.cp-dialog')).toBeTruthy();
    dlg.close();
    expect(document.querySelectorAll('#modal-root .modal-overlay')).toHaveLength(0);
  });

  it('ячейки состояния заполняются персонажами и для общего аккаунта сохраняют разные статусы', async () => {
    const dlg = openShopSplit();
    await scan(dlg);
    const cells = [...dlg.body.querySelectorAll('.sc-character-cell')];
    expect(cells.length).toBeGreaterThan(1);
    const shared = cells.find(cell => cell.querySelectorAll('.sc-character').length > 1);
    expect(shared.style.getPropertyValue('--sc-cell-min-height')).toBe('112px');
    const mixed = cells.find(cell => cell.querySelector('.st-online') && cell.querySelector('.st-offline'));
    expect(mixed).toBeTruthy();
    expect(mixed.querySelectorAll('.sc-character-stack > .sc-character')).toHaveLength(2);
    const css = readFileSync('demo/tools-modals.css', 'utf8');
    expect(css).toMatch(/\.promo-table td\.sc-character-cell\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.sc-character-stack\s*\{[^}]*inset:\s*0/);
  });

  it('остановка и закрытие во время проверки не запускают действия', async () => {
    const dlg = openTransferSplit();
    click(dlg.foot.querySelector('[data-act="stop"]'));
    await finish();
    expect(content(dlg)).toContain('Проверка остановлена');
    expect(dlg.foot.querySelector('[data-act="start"]').disabled).toBe(true);
    click(dlg.foot.querySelector('[data-act="refresh"]'));
    dlg.close();
    await finish();
    expect(document.querySelector('#modal-root .modal-overlay')).toBeNull();
    expect(openScenario('unknown')).toBeNull();
  });
});
