// Раздел «Инструменты»: скрипты и управление окнами игры переехали из круглой кнопки «+».
// Проверяем и разметку (пункт меню, страница, место панели парсеров), и поведение:
// FAB больше не содержит скриптов, а раздел запускает их по одному клику.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const runScriptAction = vi.fn(async () => {});
vi.mock('../js/core/uiActions.js', () => ({ runScriptAction: a => runScriptAction(a) }));
vi.mock('../js/modules/launcher/runningWindows.js', () => ({
  runningWindows: () => [
    {
      pid: 4242,
      nick: 'ДР8',
      cls: 'Жрец',
      title: 'ДР8 — Жрец',
      known: true,
      charId: 'c1',
      uptimeMs: 130000,
      elevated: false,
      partyIds: []
    }
  ],
  onRunningWindows: () => () => {},
  refreshRunningWindows: vi.fn(async () => [])
}));

const html = () => readFileSync('index.html', 'utf8');

describe('разметка раздела «Инструменты»', () => {
  it('пункт меню стоит шестым, после «Руны», и у него свой горячий ключ', () => {
    const doc = new DOMParser().parseFromString(html(), 'text/html');
    const tabs = [...doc.querySelectorAll('.next-nav [data-tab]')].map(b => b.dataset.tab);
    expect(tabs).toEqual(['today', 'characters', 'parties', 'marathons', 'runes', 'finance', 'tools']);
    // «Настройки» живёт отдельно, внизу, и теперь это Ctrl+8 — седьмым стали «Инструменты»
    const settings = doc.querySelector('.next-settings-tab');
    expect(settings.title).toBe('Ctrl+8');
    expect(doc.querySelector('.next-nav [data-tab="finance"]').title).toBe('Ctrl+6');
    expect(doc.querySelector('.next-nav [data-tab="tools"]').title).toBe('Ctrl+7');
  });

  it('страница раздела есть и в ней панель состояния парсеров', () => {
    const doc = new DOMParser().parseFromString(html(), 'text/html');
    expect(doc.querySelector('[data-section="tools"] #tools-root')).not.toBeNull();
    // Диагностика уехала из настроек: это инструмент, а не настройка
    expect(doc.querySelector('#settings-sync #parser-health-panel')).toBeNull();
    expect(doc.querySelector('[data-section="tools"] #parser-health-panel')).not.toBeNull();
  });

  it('круглая кнопка «+» больше не содержит скриптов и окон игры', () => {
    const src = html();
    const fab = src.slice(
      src.indexOf('<div class="fab-container"'),
      src.indexOf('<!-- ====', src.indexOf('<div class="fab-container"'))
    );
    expect(fab).not.toContain('data-script-action');
    expect(fab).not.toContain('fab-scripts-submenu');
    expect(fab).not.toContain('game-windows');
    // Зато осталось то, для чего FAB и нужен: создание
    expect(fab).toContain('data-fab-action="create-party"');
    expect(fab).toContain('data-fab-action="create-character"');
    expect(fab).toContain('data-fab-action="folder"');
    expect(fab).toContain('data-fab-action="marathon"');
  });
});

describe('содержимое раздела', () => {
  let root;
  beforeEach(async () => {
    vi.resetModules();
    runScriptAction.mockClear();
    document.body.innerHTML = '<div class="page active" data-section="tools"><div id="tools-root"></div></div>';
    root = document.getElementById('tools-root');
    const { bindTools, renderTools } = await import('../js/modules/tools/index.js');
    bindTools();
    renderTools();
  });

  it('все скрипты видны сразу списком, без второго нажатия', () => {
    const ids = [...root.querySelectorAll('[data-script-action]')].map(b => b.dataset.scriptAction);
    expect(ids).toEqual([
      'check-auth',
      'update-balance',
      'update-marathons',
      'promo',
      'transfer',
      'shop',
      'caravan',
      'close-game'
    ]);
    // Под каждым — что именно он сделает
    expect(root.querySelectorAll('.tools-card-body small').length).toBe(8);
  });

  it('скрипты разделены на две зоны: проверки и операции', () => {
    const groups = [...root.querySelectorAll('.tools-group')];
    expect(groups.length).toBe(2);

    const titles = groups.map(g => g.querySelector('.tools-group-head h4').textContent.trim());
    expect(titles).toEqual(['Проверки', 'Операции']);

    const checkCards = groups[0].querySelectorAll('[data-script-action]');
    const actionCards = groups[1].querySelectorAll('[data-script-action]');
    expect([...checkCards].map(c => c.dataset.scriptAction)).toEqual([
      'check-auth',
      'update-balance',
      'update-marathons'
    ]);
    expect([...actionCards].map(c => c.dataset.scriptAction)).toEqual([
      'promo',
      'transfer',
      'shop',
      'caravan',
      'close-game'
    ]);
  });

  it('тип скрипта виден по модификатору карточки, без чипа', () => {
    // Чип «Проверка/Действие» повторял заголовок группы и наезжал на длинные названия,
    // поэтому тип теперь несут только модификаторы: по ним красится левая полоса и ховер.
    expect(root.querySelector('.tools-chip')).toBeNull();
    expect(root.querySelector('[data-script-action="check-auth"]').classList).toContain('tools-card--check');
    expect(root.querySelector('[data-script-action="update-balance"]').classList).toContain('tools-card--check');
    expect(root.querySelector('[data-script-action="promo"]').classList).toContain('tools-card--action');
    expect(root.querySelector('[data-script-action="close-game"]').classList).toContain('tools-card--action');
    // Все восемь карточек размечены, ни одна не осталась без типа
    expect(root.querySelectorAll('.tools-card--check').length).toBe(3);
    expect(root.querySelectorAll('.tools-card--action').length).toBe(5);
  });

  it('клик по карточке запускает скрипт с её id', async () => {
    root.querySelector('[data-script-action="promo"]').click();
    await vi.waitFor(() => expect(runScriptAction).toHaveBeenCalledWith('promo'));
  });

  it('у каждого скрипта подпись объясняет, что он сделает', () => {
    // Подпись «Передать предметы с сайта в игру» обещала не то, что делает скрипт:
    // он переносит с сайта все предметы, а не выбранные.
    expect(root.querySelectorAll('.tools-card-body small').length).toBe(8);
    const hints = Object.fromEntries(
      [...root.querySelectorAll('.tools-card')].map(c => [c.dataset.scriptAction, c.title])
    );
    expect(hints.transfer).toBe('Передать все предметы с сайта');
    expect(hints['check-auth']).toContain('вход');
    expect(hints['close-game']).toContain('окн');
  });

  it('окна игры показаны списком с закрытием конкретного окна', () => {
    const box = root.querySelector('[data-tools-windows]');
    expect(box.textContent).toContain('ДР8');
    expect(box.textContent).toContain('работает 2 мин');
    const close = box.querySelector('[data-tools-act="close-one-window"]');
    expect(close.dataset.pid).toBe('4242');
  });

  it('есть кнопки показать все окна и закрыть все', () => {
    expect(root.querySelector('[data-tools-act="pick-windows"]')).not.toBeNull();
    expect(root.querySelector('[data-tools-act="close-all-windows"]')).not.toBeNull();
  });
});
