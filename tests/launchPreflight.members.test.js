// tests/launchPreflight.members.test.js
// Выбор состава прямо в окне «Проверка перед запуском».
//
// Что здесь проверяется и почему это не лишнее:
//   1. Строки списка: готовые — с чекбоксом, проблемные и уже запущенные — без
//      него (обещать отметку там, где запустить нельзя, значит просить кликнуть
//      впустую);
//   2. `applyPreflightDrops` — снимает отмеченное, но не теряет того, кого починили
//      между кругами окна. Это регресс на реализацию «список отмеченных»: второй
//      круг после «Исправить и запустить» запускал бы только тех, кто был готов
//      с самого начала;
//   3. Кнопка «Запустить» обещает ровно то, что останется: подпись пересчитывается
//      по отметкам, а при нуле кнопка выключена — «Запустить (0)» была бы ловушкой.

import { describe, it, expect, beforeEach } from 'vitest';
import { preflightMemberRows, applyPreflightDrops } from '../js/modules/launcher/preflight.js';
import { openPreflight } from '../js/modules/launcher/preflightDialog.js';

const char = (id, nick, extra = {}) => ({ id, nick, class: 'Воин', ...extra });
const preOf = (over = {}) => ({
  total: 3,
  toLaunch: [char('a', 'Аа'), char('b', 'Бб')],
  alreadyRunning: [{ char: char('c', 'Вв') }],
  noGc: [char('d', 'Гг')],
  noSavedLogin: [],
  siteNoLogin: [],
  problems: ['noGc'],
  runningKnown: true,
  decorate: true,
  unknownClients: 0,
  adminMismatch: false,
  elevatedClients: 0,
  ...over
});

describe('строки списка состава в окне проверок', () => {
  it('готовые — с отметкой, проблемные и запущенные — без, с причиной', () => {
    const rows = preflightMemberRows(preOf());
    expect(rows.map(r => `${r.id}:${r.kind}:${r.checked ? 'on' : 'off'}`)).toEqual([
      'a:ready:on',
      'b:ready:on',
      'd:blocked:off',
      'c:running:off'
    ]);
    expect(rows.find(r => r.id === 'd').note).toContain('GameCenter');
    expect(rows.find(r => r.id === 'c').note).toContain('уже запущено');
  });

  it('снятые вручную приходят в окне отмеченными обратное', () => {
    const rows = preflightMemberRows(preOf(), { droppedIds: ['b'] });
    expect(rows.find(r => r.id === 'a').checked).toBe(true);
    expect(rows.find(r => r.id === 'b').checked).toBe(false);
  });
});

describe('применение ручных снятий', () => {
  it('снимает отмеченное и возвращает снятых отдельным списком', () => {
    const pre = preOf();
    const res = applyPreflightDrops(pre, ['b']);
    expect(res.toLaunch.map(c => c.id)).toEqual(['a']);
    expect(res.manualSkips.map(c => c.id)).toEqual(['b']);
  });

  it('после «Исправить и запустить» починенный остаётся в запуске', () => {
    // Первый круг: Гг без GameCenter, снят Бб.
    const first = applyPreflightDrops(preOf(), ['b']);
    expect(first.toLaunch.map(c => c.id)).toEqual(['a']);
    // Человек указал GameCenter для Гг — второй круг показывает уже другой список
    // готовых. Отметки «кого оставить» первого круга его бы потеряли.
    const second = preOf({ toLaunch: [char('a', 'Аа'), char('b', 'Бб'), char('d', 'Гг')], noGc: [], problems: [] });
    expect(applyPreflightDrops(second, ['b']).toLaunch.map(c => c.id)).toEqual(['a', 'd']);
  });

  it('пустой список снятий ничего не меняет, неизвестный id игнорируется', () => {
    const pre = preOf();
    expect(applyPreflightDrops(pre, []).toLaunch.length).toBe(2);
    expect(applyPreflightDrops(pre, ['нет-такого']).toLaunch.length).toBe(2);
    expect(applyPreflightDrops(pre, ['нет-такого']).manualSkips).toEqual([]);
  });
});

describe('окно проверок: отметки и обещание кнопки', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
  });
  const dlg = () => document.querySelector('.tf-dialog');
  const launchButton = () => document.querySelector('[data-act="launch"]');

  it('показывает список, снимает отметку и пересчитывает подпись кнопки', async () => {
    const pending = openPreflight(preOf());
    expect(dlg()).toBeTruthy();
    expect(dlg().querySelector('.prl-members')).toBeTruthy();
    // Гг выпал по проверкам — поэтому «остальных», а не «всех»: кнопка с самого
    // начала обещает ровно то, что сделает.
    expect(launchButton().textContent).toBe('▶ Запустить остальных (2)');

    const box = dlg().querySelector('.prl-mcheck[value="b"]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    // Снятие отметки видно в подписи: (2) → (1).
    expect(launchButton().textContent).toBe('▶ Запустить остальных (1)');

    launchButton().click();
    expect(await pending).toEqual({ action: 'launch', droppedIds: ['b'] });
  });

  it('при нуле отмеченных кнопка выключена — пустой запуск невозможен', async () => {
    const pending = openPreflight(preOf());
    for (const box of dlg().querySelectorAll('.prl-mcheck')) {
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(launchButton().disabled).toBe(true);
    expect(launchButton().title).toContain('отметьте');

    document.querySelector('[data-act="all"]').click();
    expect(launchButton().disabled).toBe(false);
    launchButton().click();
    expect(await pending).toEqual({ action: 'launch', droppedIds: [] });
  });

  it('«только этот» снимает всех остальных и запускает сразу', async () => {
    const pending = openPreflight(preOf());
    dlg().querySelector('[data-solo-id="b"]').click();
    expect(await pending).toEqual({ action: 'launch', droppedIds: ['a'] });
  });

  it('когда готов один — списка нет, и ответ не пустой', async () => {
    const pending = openPreflight(preOf({ toLaunch: [char('a', 'Аа')], noGc: [], problems: [] }));
    expect(dlg().querySelector('.prl-members')).toBeNull();
    launchButton().click();
    expect(await pending).toEqual({ action: 'launch', droppedIds: [] });
  });

  it('когда снимать нечего, подпись кнопки без «остальных»', async () => {
    const pending = openPreflight(preOf({ noGc: [], alreadyRunning: [], problems: [] }));
    expect(launchButton().textContent).toBe('▶ Запустить (2)');
    document.querySelector('[data-act="cancel"]').click();
    expect(await pending).toBeNull();
  });

  it('«Исправить и запустить» уносит и отметки: ответ — fix со списком снятых', async () => {
    const pending = openPreflight(preOf(), { gameCenters: [{ id: 'gc-1', name: 'Папка' }] });
    const box = dlg().querySelector('.prl-mcheck[value="a"]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-act="fix"]').click();
    expect(await pending).toEqual({ action: 'fix', droppedIds: ['a'] });
  });
});
