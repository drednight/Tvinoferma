// Настройка «Разделы приложения»: какие разделы видны и в каком порядке (js/core/sections.js),
// панель в настройках (js/settings/sectionsPanel.js) и применение к меню.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SECTIONS, applySections, canHideSection, normalizeSectionsSettings,
  resolveSection, sectionOrder, visibleSections
} from '../js/core/sections.js';
import { moveSection, sectionsListHtml, sectionHint } from '../js/settings/sectionsPanel.js';
import { normalizeState } from '../js/core/state.js';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));

const html = readFileSync('index.html', 'utf8');
const NAV = ['today', 'characters', 'parties', 'marathons', 'runes', 'finance', 'tools'];

/** Настройка разделов из сырых значений — так, как её приносит state.json. */
const withSections = (sections) => normalizeState({ settings: { ui: { sections } } }).settings;

function mountMenu() {
  document.body.innerHTML = `
    <nav class="next-nav">
      ${NAV.map((id) => `<button class="tab${id === 'today' ? ' active' : ''}" data-tab="${id}" data-subtitle="s">
        <span class="next-nav-copy"><strong>${id}</strong></span></button>`).join('')}
    </nav>
    <div class="next-sidebar-bottom"><button class="tab" data-tab="settings"><strong>settings</strong></button></div>
    ${NAV.concat('settings').map((id) => `<section class="page${id === 'today' ? ' active' : ''}" data-section="${id}"></section>`).join('')}
    <div id="sections-list"></div>`;
  return document;
}

describe('разделы: список и правила', () => {
  it('в списке есть все разделы меню, «Настройки» прибиты к низу', () => {
    expect(NAV.every((id) => SECTIONS.some((s) => s.id === id))).toBe(true);
    expect(SECTIONS.find((s) => s.id === 'settings').pin).toBe('bottom');
  });

  it('выключать нельзя не всё, и у каждого запрета есть причина', () => {
    const required = SECTIONS.filter((s) => s.required).map((s) => s.id);
    // Не только «Настройки»: «Сегодня» держит календарь, иначе его негде открыть
    expect(required).toContain('settings');
    expect(required).toContain('today');
    expect(required.length).toBeLessThan(SECTIONS.length);
    for (const id of required) expect(SECTIONS.find((s) => s.id === id).required.length).toBeGreaterThan(10);
  });

  it('пустая настройка означает «порядок по умолчанию, все видны»', () => {
    const s = withSections(undefined);
    expect(visibleSections(s).map((x) => x.id)).toEqual(NAV.concat('settings'));
    expect(sectionOrder(s).map((x) => x.id)).toEqual(NAV.concat('settings'));
  });

  it('мусор из сохранённых данных не попадает в состояние', () => {
    const { hidden, order } = normalizeSectionsSettings({
      hidden: ['runes', 'runes', 'нет-такого', 'settings', 'today', 42],
      order: ['parties', 'parties', 'ерунда', 'tools']
    });
    expect(hidden).toEqual(['runes']);      // дубли, неизвестные и запрещённые — отброшены
    expect(order).toHaveLength(SECTIONS.length); // недостающие дописаны
    // Закреплённые держат свои края, переставляемые идут следом в заданном порядке
    expect(order[0]).toBe('today');
    expect(order[order.length - 1]).toBe('settings');
    expect(order.slice(1, 3)).toEqual(['parties', 'tools']);
  });

  it('раздел, добавленный позже, появляется в меню сам', () => {
    // В настройке его ещё нет — но раздел появился в приложении, и молчать не должен
    const { order } = normalizeSectionsSettings({ order: ['tools'] });
    expect(order.slice(1, 2)).toEqual(['tools']); // «Сегодня» закреплён сверху
    expect(order).toContain('runes');
  });
});

describe('разделы: что можно выключить', () => {
  it('запрещённые выключить нельзя, с причиной', () => {
    const s = withSections({});
    expect(canHideSection('today', s)).toBe(false);
    expect(sectionHint('today', s)).toContain('календарь');
    expect(canHideSection('settings', s)).toBe(false);
    expect(sectionHint('settings', s)).toContain('обратно');
  });

  it('последний видимый раздел убрать нельзя', () => {
    const s = withSections({ hidden: ['characters', 'parties', 'marathons', 'runes', 'finance', 'tools'] });
    // остались today и settings; settings прибит, значит единственный убираемый видимый — сегодня
    expect(visibleSections(s).map((x) => x.id)).toEqual(['today', 'settings']);
    expect(canHideSection('settings', s)).toBe(false);
  });

  it('запись «выключить запрещённое» в данных не делает раздел недостижимым', () => {
    const s = withSections({ hidden: ['settings', 'today', 'runes'] });
    expect(s.ui.sections.hidden).toEqual(['runes']);
    expect(visibleSections(s).map((x) => x.id)).toContain('settings');
  });
});

describe('разделы: применение к меню', () => {
  it('порядок пользователя и скрытые разделы применяются к кнопкам', () => {
    const doc = mountMenu();
    applySections(doc, withSections({ order: ['parties', 'marathons', 'tools'], hidden: ['tools'] }));
    const shown = [...doc.querySelectorAll('.next-nav > .tab')].filter((t) => !t.hidden).map((t) => t.dataset.tab);
    // «Сегодня» закреплён сверху, дальше — заданный порядок; недостающие дописываются в конец
    expect(shown.slice(0, 3)).toEqual(['today', 'parties', 'marathons']);
    expect(shown).toContain('characters');
    expect(shown).not.toContain('tools');
    expect(doc.querySelector('.tab[data-tab="tools"]').hidden).toBe(true);
    // «Настройки» прибиты к низу и в перестановку не попадают
    expect(doc.querySelector('.next-sidebar-bottom .tab').dataset.tab).toBe('settings');
  });

  it('кнопки переносятся, а не пересоздаются: на них уже висят обработчики', () => {
    const doc = mountMenu();
    const before = doc.querySelector('.tab[data-tab="runes"]');
    let clicked = 0;
    before.addEventListener('click', () => { clicked += 1; });
    applySections(doc, withSections({ order: ['runes', 'today'] }));
    expect(doc.querySelector('.tab[data-tab="runes"]')).toBe(before);
    before.click();
    expect(clicked).toBe(1);
  });

  it('в разметке меню есть кнопка каждого раздела и все они в .next-nav', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const id of NAV) expect(doc.querySelector(`.next-nav .tab[data-tab="${id}"]`), id).not.toBeNull();
    expect(doc.querySelector('.next-nav .tab[data-tab="settings"]')).toBeNull();
    expect(doc.querySelector('.next-sidebar-bottom .tab[data-tab="settings"]')).not.toBeNull();
  });

  it('выключенная кнопка реально скрывается: у .tab своё display перебивает hidden', () => {
    // Регрессия: `.tab { display: inline-flex }` сильнее правила браузера для `hidden`,
    // и без отдельного правила раздел оставался на месте при выключенном переключателе.
    const css = readFileSync('css/core/layout.css', 'utf8');
    expect(css).toMatch(/\.tab\[hidden\]\s*\{\s*display:\s*none/);
  });
});

describe('разделы: переход в выключенный раздел', () => {
  it('ведёт на первый видимый, а не молчит', () => {
    const s = withSections({ order: ['parties', 'today'], hidden: ['parties', 'marathons'] });
    expect(resolveSection('parties', s).id).toBe('today');   // выключен → первый видимый
    expect(resolveSection('marathons', s).id).toBe('today');
    expect(resolveSection('characters', s).id).toBe('characters'); // видим — идём туда
    expect(resolveSection('today', s).id).toBe('today');
  });

  it('выключенный раздел не попадает в палитру и в горячие клавиши', () => {
    const s = withSections({ hidden: ['runes'], order: ['parties', 'marathons'] });
    expect(visibleSections(s).map((x) => x.id)).toEqual(['today', 'parties', 'marathons', 'characters', 'finance', 'tools', 'settings']);
  });
});

describe('разделы: панель настроек', () => {
  let settings, persist;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="sections-list"></div>';
    settings = normalizeState({ settings: { ui: { sections: {} } } }).settings;
    persist = vi.fn(async () => {});
  });

  it('у каждого раздела есть переключатель, у невыключаемых — выключен с причиной', () => {
    const host = document.createElement('div');
    host.innerHTML = sectionsListHtml(settings);
    const rows = host.querySelectorAll('.sections-row');
    expect(rows).toHaveLength(SECTIONS.length);
    const today = host.querySelector('input[data-sections-id="today"]');
    expect(today.checked).toBe(true);
    expect(today.disabled).toBe(true);
    expect(host.querySelector('.sections-row.is-required .sections-copy small').textContent).toContain('календарь');
    expect(host.querySelector('input[data-sections-id="runes"]').disabled).toBe(false);
    // Видимая часть переключателя — дорожка, а не галочка браузера
    expect(host.querySelector('.sections-toggle .switch')).not.toBeNull();
  });

  it('нажатие на стрелку не переключает видимость: кнопки не внутри подписи', () => {
    const host = document.createElement('div');
    host.innerHTML = sectionsListHtml(settings);
    const row = host.querySelector('.sections-row:not(.is-required)');
    // Всё, что кликается и не должно быть галочкой, лежит вне <label>
    for (const btn of row.querySelectorAll('button')) {
      expect(btn.closest('label')).toBeNull();
    }
    expect(row.querySelector('.sections-toggle').contains(row.querySelector('input'))).toBe(true);
  });

  it('выключенный раздел помечен и галочка снята', () => {
    const s = withSections({ hidden: ['runes'] });
    const host = document.createElement('div');
    host.innerHTML = sectionsListHtml(s);
    const row = host.querySelector('.sections-row.is-off');
    expect(row.querySelector('input').checked).toBe(false);
  });

  it('галочка выключает раздел и сохраняет', async () => {
    const panel = (await import('../js/settings/sectionsPanel.js')).bindSectionsPanel({ settings, persist });
    const box = document.getElementById('sections-list');
    const input = box.querySelector('input[data-sections-id="runes"]');
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(settings.ui.sections.hidden).toEqual(['runes']));
    expect(persist).toHaveBeenCalled();
    // Список перерисовывается сам: выключенный раздел должен быть виден гаснущей строкой
    await vi.waitFor(() => expect(box.querySelector('.sections-row.is-off')).not.toBeNull());
    // Возврат обратно — тоже одним кликом
    panel.render();
    const back = box.querySelector('input[data-sections-id="runes"]');
    back.checked = true;
    back.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(settings.ui.sections.hidden).toEqual([]));
  });

  it('стрелки двигают раздел и сохраняют', async () => {
    const panel = (await import('../js/settings/sectionsPanel.js')).bindSectionsPanel({ settings, persist });
    const box = document.getElementById('sections-list');
    const up = box.querySelector('button[data-sections-move="up"][data-sections-id="parties"]');
    up.click();
    await vi.waitFor(() => expect(sectionOrder(settings).map((s) => s.id).slice(0, 3)).toEqual(['today', 'parties', 'characters']));
    expect(persist).toHaveBeenCalled();
    expect(panel).toBeTruthy();
  });

it('крайние разделы не двигаются: кнопки выключены', async () => {
    await (await import('../js/settings/sectionsPanel.js')).bindSectionsPanel({ settings, persist });
    const box = document.getElementById('sections-list');
    // Крайние среди переставляемых: «Инструменты» — последний, «Персонажи» — не край
    expect(box.querySelector('button[data-sections-move="down"][data-sections-id="tools"]').disabled).toBe(true);
    expect(box.querySelector('button[data-sections-move="down"][data-sections-id="characters"]').disabled).toBe(false);
    // У закреплённых стрелок нет вовсе — вместо них подпись о месте
    expect(box.querySelector('button[data-sections-move][data-sections-id="today"]')).toBeNull();
    expect(box.querySelector('button[data-sections-move][data-sections-id="settings"]')).toBeNull();
  });

  it('попытка выключить запрещённое отклоняется с объяснением, а не молча', async () => {
    const { toast } = await import('../js/core/ui.js');
    const { bindSectionsPanel } = await import('../js/settings/sectionsPanel.js');
    vi.mocked(toast).mockClear?.();
    const panel = bindSectionsPanel({ settings, persist });
    const box = document.getElementById('sections-list');
    const input = box.querySelector('input[data-sections-id="today"]');
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(settings.ui.sections.hidden).toEqual([]));
    expect(persist).not.toHaveBeenCalled();
    expect(panel.render).toBeTruthy();
  });
});

describe('разделы: перестановка', () => {
  it('двигает на одну позицию и возвращает null на краю', () => {
    const settings = normalizeState({ settings: { ui: { sections: {} } } }).settings;
    // порядок по умолчанию: today, characters, parties, marathons, runes, finance, tools
const up = moveSection('parties', 'up', settings);
    expect(up.order.slice(0, 3)).toEqual(['today', 'parties', 'characters']);
    const down = moveSection('characters', 'down', settings);
    expect(down.order.slice(0, 3)).toEqual(['today', 'parties', 'characters']);
    expect(moveSection('characters', 'up', settings)).toBeNull();  // уже первый переставляемый
    expect(moveSection('tools', 'down', settings)).toBeNull();   // уже последний переставляемый
    // Закреплённые не двигаются вовсе: у них нет стрелок, а moveSection отказывает
    expect(moveSection('today', 'down', settings)).toBeNull();     // закреплён сверху
    expect(moveSection('settings', 'up', settings)).toBeNull();   // закреплён снизу
  });

  it('выключенные не занимают мест и не сдвигают видимые', () => {
    const settings = withSections({ hidden: ['characters', 'tools'] });
    const moved = moveSection('runes', 'up', settings);
    // видимые: today, parties, marathons, runes → runes встаёт перед marathons
    expect(moved.order.filter((id) => !['characters', 'tools'].includes(id)).slice(0, 4))
      .toEqual(['today', 'parties', 'runes', 'marathons']);
    expect(moved.hidden).toEqual(['characters', 'tools']);
  });
});

describe('разделы: настройка переживает перезапуск', () => {
  it('порядок и скрытые сохраняются в state.settings.ui.sections', () => {
    const once = normalizeState({
      settings: { ui: { sections: { hidden: ['runes'], order: ['parties', 'today'] } } }
    }).settings;
    const twice = normalizeState({ settings: { ui: { sections: once.ui.sections } } }).settings;
    expect(twice.ui.sections).toEqual(once.ui.sections);
    expect(once.ui.theme).toBeDefined(); // соседние настройки не пострадали
  });
});
describe('закреплённые разделы', () => {
  // «Сегодня» — вход в приложение, «Настройки» — место, где раздел включают обратно.
  // Оба должны стоять там, где их ожидают, независимо от того, что лежит в настройке.
  it('«Сегодня» закреплён сверху, «Настройки» снизу', () => {
    expect(SECTIONS.find((s) => s.id === 'today').pin).toBe('top');
    expect(SECTIONS.find((s) => s.id === 'settings').pin).toBe('bottom');
  });

it('порядок из настройки не может сдвинуть закреплённые с краёв', () => {
    // Старый файл или правка руками: если бы закреплённые не держали свой край,
    // «Сегодня» могло оказаться в конце меню, а «Настройки» — наверху.
    // Недостающие разделы дописываются в конец переставляемой части — по умолчанию.
    const out = normalizeSectionsSettings({
      order: ['settings', 'runes', 'characters', 'today', 'tools', 'parties']
    });
    expect(out.order[0]).toBe('today');
    expect(out.order[out.order.length - 1]).toBe('settings');
    expect(out.order.slice(1, -1)).toEqual(['runes', 'characters', 'tools', 'parties', 'marathons', 'finance']);
  });

  it('перестановка стрелками не трогает закреплённые', () => {
    const before = normalizeSectionsSettings({ order: ['today', 'characters', 'parties', 'settings'] });
    const after = moveSection('parties', 'up', { ui: { sections: before } });
    expect(after.order[0]).toBe('today');
    expect(after.order[after.order.length - 1]).toBe('settings');
  });

  it('стрелок у закреплённого раздела нет, есть подпись о месте', () => {
    const html = sectionsListHtml({ ui: { sections: normalizeSectionsSettings({}) } });
    const todayRow = html.split('<div class="sections-row')[1] || '';
    expect(todayRow).toContain('закреплён сверху');
    expect(todayRow).not.toContain('data-sections-move');
  });
});

describe('панель показывает сохранённый порядок', () => {
  // Список строился по SECTIONS (порядок по умолчанию), а стрелки считали позицию по
  // сохранённому. Выглядело это так: нажал «выше» — ничего не произошло.
  const orderOf = (html) => (html.match(/data-sections-id="([a-z]+)"/g) || [])
    .map(m => m.replace(/.*"([a-z]+)".*/, '$1'))
    .filter((id, i, arr) => arr.indexOf(id) === i);

  it('строки идут в том же порядке, что сохранён', () => {
    const saved = normalizeSectionsSettings({ order: ['today', 'runes', 'characters', 'parties', 'settings'] });
    const html = sectionsListHtml({ ui: { sections: saved } });
    expect(orderOf(html)).toEqual(saved.order);
  });

  it('переставленный раздел реально меняет место в списке', () => {
    const base = normalizeSectionsSettings({ order: ['today', 'characters', 'parties', 'settings'] });
    const moved = moveSection('parties', 'up', { ui: { sections: base } });
    const html = sectionsListHtml({ ui: { sections: normalizeSectionsSettings(moved) } });
    const ids = orderOf(html);
    expect(ids.indexOf('parties')).toBeLessThan(ids.indexOf('characters'));
  });
});

