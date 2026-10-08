// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutSummaryText, layoutApplyText, baseName, layoutPaths, bindLayoutPanel } from '../js/modules/launcher/layoutSync.js';
import { state } from '../js/core/state.js';
import { normalizeState } from '../js/core/state.js';

const html = readFileSync('index.html', 'utf8');

describe('Layout: тексты', () => {
  it('имя файла из пути Windows и обычного', () => {
    expect(baseName('C:\\Games\\layout\\2069946672.ini')).toBe('2069946672.ini');
    expect(baseName('/a/b/c.ini')).toBe('c.ini');
    expect(baseName('')).toBe('');
  });

  it('сводка по папке', () => {
    expect(layoutSummaryText({ targets: [], templateInDir: true })).toMatch(/менять нечего/);
    const t = layoutSummaryText({ targets: [{ name: 'a.ini', readOnly: true }, { name: 'b.ini', readOnly: false }], templateInDir: true }, 'D:\\x\\1.ini');
    expect(t).toContain('2 файла');
    expect(t).toContain('уже: 1');
    expect(t).toContain('1.ini');
  });

  it('итог применения', () => {
    expect(layoutApplyText({ replaced: ['a', 'b'], unchanged: ['c'], failed: [], backupDir: 'X' })).toBe('Готово: заменено: 2, уже совпадали: 1. Прежние файлы сохранены в копии: X');
    expect(layoutApplyText({ replaced: [], unchanged: [], failed: [{ name: 'a.ini', error: 'нет доступа' }] })).toContain('a.ini — нет доступа');
    expect(layoutApplyText({ replaced: [], unchanged: [], failed: [] })).toBe('Менять было нечего.');
  });

  it('настройки пустые по умолчанию, пути обрезаются', () => {
    const s = normalizeState({ characters: [], settings: { launcher: { layoutDir: '  C:\\L  ' } } }).settings;
    expect(s.launcher.layoutTemplate).toBe('');
    expect(layoutPaths(s)).toEqual({ dir: 'C:\\L', template: '' });
  });
});

describe('Layout: разметка и команды', () => {
  it('панель есть в разделе «Приложение», id уникальны', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const id of ['layout-dir', 'layout-template', 'layout-dir-btn', 'layout-template-btn', 'layout-apply-btn', 'layout-unlock-btn']) {
      expect(doc.querySelector(`#settings-app #settings-layout #${id}`), id).not.toBeNull();
    }
    expect(doc.querySelector('[data-setting="launcher.layoutDir"]')).not.toBeNull();
    expect(doc.querySelector('[data-setting="launcher.layoutTemplate"]')).not.toBeNull();
  });

  it('команды интерфейса есть в Rust и зарегистрированы', () => {
    const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
    const rust = readFileSync('src-tauri/src/commands/layout.rs', 'utf8');
    const js = readFileSync('js/modules/launcher/layoutSync.js', 'utf8');
    for (const cmd of ['layout_pick_folder', 'layout_pick_file', 'layout_scan', 'layout_apply', 'layout_unlock']) {
      expect(rust).toContain(`pub async fn ${cmd}(`);
      expect(lib).toContain(`commands::layout::${cmd}`);
      expect(js).toContain(`'${cmd}'`);
    }
  });
});

describe('Layout: кнопка «Применить»', () => {
  function mount() {
    document.body.innerHTML = `<div id="toast-root"></div>
      <input id="layout-dir" /><input id="layout-template" /><p id="layout-summary"></p><p id="layout-result"></p>
      <button id="layout-dir-btn"></button><button id="layout-template-btn"></button>
      <button id="layout-apply-btn"></button><button id="layout-unlock-btn"></button>`;
    state.settings.launcher.layoutDir = 'D:\\Layout';
    state.settings.launcher.layoutTemplate = 'D:\\Layout\\1.ini';
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  it('при запущенной игре ничего не меняет', async () => {
    mount();
    const calls = [];
    const invoke = async (cmd) => { calls.push(cmd); return cmd === 'layout_scan' ? { targets: [{ name: 'a.ini', readOnly: false }], templateInDir: true } : []; };
    bindLayoutPanel({ invoke, running: async () => [123], confirm: async () => true });
    await tick();
    document.getElementById('layout-apply-btn').click();
    await tick();
    expect(calls).not.toContain('layout_apply');
    expect(document.getElementById('toast-root').textContent).toMatch(/закройте окна игры/i);
  });

  it('без подтверждения не применяет, с подтверждением — применяет', async () => {
    mount();
    const calls = [];
    const invoke = async (cmd) => {
      calls.push(cmd);
      if (cmd === 'layout_scan') return { targets: [{ name: 'a.ini', readOnly: false }], templateInDir: true };
      if (cmd === 'layout_apply') return { replaced: ['a.ini'], unchanged: [], failed: [], backupDir: 'B' };
      return null;
    };
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    bindLayoutPanel({ invoke, running: async () => [], confirm });
    await tick();
    document.getElementById('layout-apply-btn').click();
    await tick(); await tick();
    expect(calls).not.toContain('layout_apply');
    document.getElementById('layout-apply-btn').click();
    await tick(); await tick();
    expect(calls).toContain('layout_apply');
    expect(document.getElementById('layout-result').textContent).toContain('заменено: 1');
    expect(confirm.mock.calls[0][0].text).toContain('systemsettings.ini');
  });
});
