import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));

const mk = (id, launch = {}) => ({
  id, nick: id, cls: '', contacts: {},
  launch: { gcIds: [], gcAccounts: {}, ...launch }
});

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const GC2 = { id: 'gc-2', name: 'Папка 2', path: 'D:\\GC2\\GameCenter.exe' };

/** Открывает окно на поддельном DOM. Отдаём сам элемент тела, а не строку: картинка
 *  перерисовывается на месте, и снимок строки устарел бы после первого же действия. */
async function open(gcs, chars) {
  const { state } = await import('../js/core/state.js');
  state.settings = { ...state.settings, launcher: { ...state.settings.launcher, gameCenters: gcs } };
  state.characters = chars;
  const { openGcBinding } = await import('../js/modules/launcher/gcBinding.js');
  const ov = await openGcBinding();
  return { state, el: ov.body, close: ov.close };
}

describe('окно привязки GameCenter', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="modal-root"></div>';
  });

  it('без GameCenter объясняет, где их завести, и не рисует пустые карточки', async () => {
    const { el: body } = await open([], [mk('a')]);
    expect(body.innerHTML).toContain('GameCenter ещё не заведены');
    expect(body.innerHTML).toContain('Запуск игры');
    expect(body.innerHTML).not.toContain('gcb-card');
  });

  it('показывает каждому GameCenter число привязанных аккаунтов', async () => {
    const chars = [mk('a', { gcIds: ['gc-1'] }), mk('b', { gcIds: ['gc-1'] }), mk('c')];
    const { el: body } = await open([GC1, GC2], chars);
    // «Папка 1» — два аккаунта, «Папка 2» — пусто
    expect(body.innerHTML).toContain('2 аккаунта');
    expect(body.innerHTML).toContain('пусто');
    expect(body.innerHTML).toContain('Папка 1');
    expect(body.innerHTML).toContain('Папка 2');
  });

  it('один аккаунт, несколько и ноль склоняются по-русски', async () => {
    const { el: one } = await open([GC1], [mk('a', { gcIds: ['gc-1'] })]);
    expect(one.innerHTML).toContain('1 аккаунт');

    const { el: many } = await open([GC1], ['a', 'b', 'c', 'd', 'e'].map(n => mk(n, { gcIds: ['gc-1'] })));
    expect(many.innerHTML).toContain('5 аккаунтов');
  });

  it('показывает запомненный вход и предлагает его забыть', async () => {
    const { el: body } = await open([GC1], [mk('a', {
      gcIds: ['gc-1'],
      gcAccounts: { 'gc-1': { nick: 'Дракон' } }
    })]);
    expect(body.innerHTML).toContain('Дракон');
    expect(body.innerHTML).toContain('data-act="forget"');
  });

  it('без запомненного входа пишет об этом и не показывает кнопку «забыть»', async () => {
    const { el: body } = await open([GC1], [mk('a', { gcIds: ['gc-1'] })]);
    expect(body.innerHTML).toContain('вход не запомнен');
    expect(body.innerHTML).not.toContain('data-act="forget"');
  });

  it('привязка и отвязка меняют список и сохраняют состояние', async () => {
    const { state, el: body, close } = await open([GC1], [mk('a'), mk('b')]);
    const click = (act, gc = 'gc-1', chr = 'b') => document.querySelector(
      `[data-act="${act}"][data-gc="${gc}"][data-char="${chr}"]`
    )?.click();

    // сперва открыть список выбора и привязать «b»
    document.querySelector('[data-act="toggle-pick"][data-gc="gc-1"]').click();
    await Promise.resolve();
    expect(document.body.innerHTML).toContain('Привязать</button>');

    click('attach');
    await new Promise(r => setTimeout(r, 0));
    expect(state.characters.find(c => c.id === 'b').launch.gcIds).toContain('gc-1');
    expect(body.innerHTML).toContain('1 аккаунт');

    click('detach');
    await new Promise(r => setTimeout(r, 0));
    expect(state.characters.find(c => c.id === 'b').launch.gcIds).not.toContain('gc-1');

    const { persist } = await import('../js/core/storage.js');
    expect(persist).toHaveBeenCalled();
    close();
  });

  it('в списке выбора нет уже привязанных, а после привязки список пустеет', async () => {
    const { el: body, close } = await open([GC1], [mk('a', { gcIds: ['gc-1'] }), mk('b')]);
    document.querySelector('[data-act="toggle-pick"][data-gc="gc-1"]').click();
    await Promise.resolve();
    const pickRow = document.querySelector('[data-act="attach"][data-char="b"]');
    expect(pickRow).toBeTruthy();
    expect(document.querySelector('[data-act="attach"][data-char="a"]')).toBeNull();

    pickRow.click();
    await new Promise(r => setTimeout(r, 0));
    expect(body.innerHTML).toContain('Все аккаунты уже привязаны');
    close();
  });

  it('забытый вход убирается из карточки, привязка остаётся', async () => {
    const { state, el: body, close } = await open([GC1], [mk('a', {
      gcIds: ['gc-1'],
      gcAccounts: { 'gc-1': { nick: 'Дракон' } }
    })]);
    document.querySelector('[data-act="forget"][data-char="a"]').click();
    await new Promise(r => setTimeout(r, 0));
    expect(state.characters[0].launch.gcAccounts['gc-1']).toBeUndefined();
    expect(state.characters[0].launch.gcIds).toEqual(['gc-1']);
    expect(body.innerHTML).toContain('вход не запомнен');
    close();
  });
});