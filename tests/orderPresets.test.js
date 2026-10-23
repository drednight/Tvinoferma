// tests/orderPresets.test.js
// Сохранённые порядки карточек под своими именами (js/modules/characters/orderStore.js)
// и список порядков, в который они попадают.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
import {
  getManualOrder,
  saveManualOrder,
  resetManualOrder,
  canSaveOrder,
  listOrderPresets,
  saveOrderPreset,
  deleteOrderPreset,
  presetValue,
  presetIdFromValue
} from '../js/modules/characters/orderStore.js';
import { fillOrderOptions } from '../js/modules/characters/list.js';

beforeEach(() => {
  window.localStorage.clear();
});

describe('сохранение порядка под именем', () => {
  it('сохраняет и отдаёт обратно', () => {
    const saved = saveOrderPreset('Для рейда', ['c1', 'c2', 'c3']);
    expect(saved.name).toBe('Для рейда');
    expect(saved.replaced).toBe(false);
    expect(listOrderPresets()).toHaveLength(1);
    expect(listOrderPresets()[0].ids).toEqual(['c1', 'c2', 'c3']);
  });

  it('порядок сохраняется отдельно от живого: снимок не меняется сам', () => {
    // Выбранный порядок копируется в живой при выборе, и перетаскивание его меняет.
    // Сохранённый при этом должен остаться нетронутым — иначе «Обновить» был бы не нужен.
    const saved = saveOrderPreset('Для рейда', ['c1', 'c2']);
    saveManualOrder(['c2', 'c1']);
    expect(getManualOrder()).toEqual(['c2', 'c1']);
    expect(listOrderPresets()[0].ids).toEqual(saved.ids);
  });

  it('то же имя заменяет порядок, а не плодит второй', () => {
    // Два порядка с одинаковым именем в списке выглядели бы как ошибка
    saveOrderPreset('Рейд', ['c1']);
    const again = saveOrderPreset('рейд', ['c2', 'c3']); // регистр не важен
    expect(again.replaced).toBe(true);
    expect(listOrderPresets()).toHaveLength(1);
    expect(listOrderPresets()[0].ids).toEqual(['c2', 'c3']);
  });

  it('имя обрезается и не бывает пустым', () => {
    expect(() => saveOrderPreset('   ', ['c1'])).toThrow();
    expect(saveOrderPreset('А'.repeat(80), ['c1']).name).toHaveLength(40);
  });

  it('пустой порядок сохранять не о чем', () => {
    expect(() => saveOrderPreset('Пусто', [])).toThrow();
    expect(listOrderPresets()).toHaveLength(0);
  });

  it('дубликаты в порядке убираются', () => {
    expect(saveOrderPreset('Дубль', ['c1', 'c1', 'c2']).ids).toEqual(['c1', 'c2']);
  });

  it('удаление убирает ровно выбранный', () => {
    const a = saveOrderPreset('Первый', ['c1']);
    const b = saveOrderPreset('Второй', ['c2']);
    expect(deleteOrderPreset(a.id)).toBe(true);
    expect(listOrderPresets().map(p => p.name)).toEqual(['Второй']);
    expect(deleteOrderPreset(a.id)).toBe(false); // второй раз — уже нечего
    expect(listOrderPresets()[0].id).toBe(b.id);
  });

  it('мусор в хранилище не ломает чтение', () => {
    window.localStorage.setItem('tvinoferma-characters-orders-v1', 'не json');
    expect(listOrderPresets()).toEqual([]);
    window.localStorage.setItem('tvinoferma-characters-orders-v1', '[{"нет":"имени"}, 42]');
    expect(listOrderPresets()).toEqual([]);
  });

  it('значение для списка и обратное разбираются', () => {
    const saved = saveOrderPreset('Для рейда', ['c1']);
    expect(presetValue(saved.id)).toBe(`preset:${saved.id}`);
    expect(presetIdFromValue(presetValue(saved.id))).toBe(saved.id);
    expect(presetIdFromValue('manual')).toBeNull();
    expect(presetIdFromValue('')).toBeNull();
  });

  it('можно сохранить, только когда есть свой порядок', () => {
    expect(canSaveOrder()).toBe(false);
    saveManualOrder(['c1']);
    expect(canSaveOrder()).toBe(true);
    resetManualOrder();
    expect(canSaveOrder()).toBe(false);
  });

  it('сохранённые порядки переживают перезапуск страницы', () => {
    // Хранилище то же самое, новый модуль не нужен: порядок должен читаться при следующем
    // открытии раздела, иначе он пропадёт через перезапуск
    const saved = saveOrderPreset('Для рейда', ['c1', 'c2']);
    expect(listOrderPresets()[0].id).toBe(saved.id);
  });
});
describe('разделитель сохранённых порядков', () => {
  // Отдельная строка-разделитель занимала целиком строку списка. Вместо неё — нижняя
  // граница у «Свой порядок»: она рисуется стилями, когда сохранённые порядки есть.
  const fill = (presets, current = 'manual') => {
    if (presets) saveOrderPreset('Для рейда', presets);
    const select = document.createElement('select');
    document.body.appendChild(select);
    fillOrderOptions(select, current);
    return select;
  };

  it('граница появляется только когда есть сохранённые', () => {
    expect(fill(null).classList.contains('has-presets')).toBe(false);
    expect(fill(['c1']).classList.contains('has-presets')).toBe(true);
  });

  it('без сохранённых в списке ровно два пункта, ничего лишнего', () => {
    expect([...fill(null).options].map(o => o.value)).toEqual(['nick', 'manual']);
  });

  it('стиль границы на месте: она задана пункту «Свой порядок»', () => {
    // Строку читает не jsdom, а браузер, поэтому проверяем правило в CSS: без него
    // класс .has-presets ничего не нарисует и разделения не будет
    const css = readFileSync('css/core/components.css', 'utf8');
    expect(css).toContain("#order-filter.has-presets option[value='manual']");
    expect(css).toMatch(/#order-filter\.has-presets option\[value='manual'\][\s\S]{0,200}border-bottom/);
  });

  it('выбранный порядок остаётся выбранным после перерисовки списка', () => {
    const saved = saveOrderPreset('Для рейда', ['c1', 'c2']);
    const select = fill(null, presetValue(saved.id));
    saveOrderPreset('Второй', ['c2']);
    fillOrderOptions(select, select.value);
    expect(select.value).toBe(presetValue(saved.id));
  });

  it('удалённый порядок не остаётся выбранным', () => {
    const b = saveOrderPreset('Второй', ['c2']);
    const select = fill(null, presetValue(b.id));
    deleteOrderPreset(b.id);
    fillOrderOptions(select, select.value);
    // В списке такого значения уже нет — выбирать не на чем, и оставаться не на чем
    expect([...select.options].some(o => o.value === presetValue(b.id))).toBe(false);
    expect(select.value).toBe('nick');
  });
});
