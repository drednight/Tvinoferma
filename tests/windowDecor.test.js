import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { windowTitle, windowDecor, launchCharacters, WINDOW_ICON_SMALL, WINDOW_ICON_BIG } from '../js/modules/launcher/launch.js';
import { normalizeState } from '../js/core/state.js';
import { CLASS_ICON_MAP, CLASSES } from '../js/core/constants.js';

const ch = (id, cls, extra = {}) => ({ id, nick: `Ник ${id}`, class: cls, launch: { gcPath: `D:\\${id}`, ...extra } });

describe('название и значок окна клиента', () => {
  it('название: «Ник — Класс», без класса — только ник', () => {
    expect(windowTitle({ nick: ' Twin ', class: 'Маг' })).toBe('Twin — Маг');
    expect(windowTitle({ nick: 'Twin', class: '' })).toBe('Twin');
    expect(windowTitle({})).toBe('');
  });

  it('у каждого класса из списка есть значок', () => {
    for (const c of CLASSES) expect(CLASS_ICON_MAP[c], c).toMatch(/\.webp$/);
  });

  it('значки запрашиваются в двух размерах; без класса значков нет', async () => {
    const asked = [];
    const loadIcon = async (cls, size) => { asked.push([cls, size]); return [size]; };
    expect(await windowDecor({ nick: 'T', class: 'Маг' }, { loadIcon })).toEqual({
      windowTitle: 'T — Маг',
      iconSmall: [WINDOW_ICON_SMALL],
      iconBig: [WINDOW_ICON_BIG]
    });
    expect(asked).toEqual([['Маг', 16], ['Маг', 48]]);
    expect(await windowDecor({ nick: 'T', class: '' }, { loadIcon })).toEqual({ windowTitle: 'T', iconSmall: null, iconBig: null });
    expect(await windowDecor({}, { loadIcon })).toEqual({ windowTitle: null, iconSmall: null, iconBig: null });
  });

  it('значок не нашёлся — окно всё равно получит название', async () => {
    const r = await windowDecor({ nick: 'T', class: 'Маг' }, { loadIcon: async () => null });
    expect(r).toEqual({ windowTitle: 'T — Маг', iconSmall: null, iconBig: null });
  });

  it('при запуске название и значки уходят в Rust вместе с остальными параметрами', async () => {
    const seen = [];
    const invoke = async (cmd, args) => { seen.push(args); return {}; };
    const loadIcon = async (cls, size) => [size];
    await launchCharacters([ch('a', 'Воин')], { delayMs: 0 }, { invoke, loadIcon });
    expect(seen[0]).toMatchObject({ path: 'D:\\a', windowTitle: 'Ник a — Воин', iconSmall: [16], iconBig: [48] });
  });

  it('настройка выключена — окно не трогаем', async () => {
    const seen = [];
    const invoke = async (cmd, args) => { seen.push(args); return {}; };
    await launchCharacters([ch('a', 'Воин')], { delayMs: 0, decorate: false }, { invoke, loadIcon: async () => [1] });
    expect(seen[0]).toMatchObject({ windowTitle: null, iconSmall: null, iconBig: null });
  });

  it('настройка включена по умолчанию и сохраняется', () => {
    expect(normalizeState({ characters: [], settings: {} }).settings.launcher.decorateWindows).toBe(true);
    expect(normalizeState({ characters: [], settings: { launcher: { decorateWindows: false } } }).settings.launcher.decorateWindows).toBe(false);
  });

  it('значки можно не ставить: окно получает только название «Ник — Класс»', async () => {
    const asked = [];
    const loadIcon = async (cls, size) => { asked.push([cls, size]); return [size]; };
    const r = await windowDecor({ nick: 'T', class: 'Маг' }, { loadIcon, icons: false });
    expect(r).toEqual({ windowTitle: 'T — Маг', iconSmall: null, iconBig: null });
    expect(asked).toEqual([]);   // значки даже не читаются с диска
  });

  it('выключенные значки уходят в Rust пустыми и при запуске', async () => {
    const seen = [];
    const invoke = async (cmd, args) => { seen.push(args); return {}; };
    await launchCharacters([ch('a', 'Воин')], { delayMs: 0 }, { invoke, loadIcon: async () => [1], icons: false });
    expect(seen[0]).toMatchObject({ windowTitle: 'Ник a — Воин', iconSmall: null, iconBig: null });
  });

  it('настройка значков включена по умолчанию, сохраняется и есть в разметке', () => {
    expect(normalizeState({ characters: [], settings: {} }).settings.launcher.decorateIcons).toBe(true);
    expect(normalizeState({ characters: [], settings: { launcher: { decorateIcons: false } } }).settings.launcher.decorateIcons).toBe(false);
    expect(readFileSync('index.html', 'utf8')).toContain('data-setting="launcher.decorateIcons"');
  });

  it('параметры команды совпадают у интерфейса и Rust', () => {
    const rust = readFileSync('src-tauri/src/launcher.rs', 'utf8');
    for (const name of ['window_title: Option<String>', 'icon_small: Option<Vec<u8>>', 'icon_big: Option<Vec<u8>>']) {
      expect(rust).toContain(name);
    }
    const js = readFileSync('js/modules/launcher/launch.js', 'utf8');
    expect(js).toContain("windowTitle: windowTitle(character) || null");
    expect(js).toContain('iconSmall');
    expect(js).toContain('iconBig');
    expect(readFileSync('index.html', 'utf8')).toContain('data-setting="launcher.decorateWindows"');
  });
});
