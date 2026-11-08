// Окно «Запущенные окна игры» (js/modules/launcher/windowPicker.js):
// список клиентов, галочки, закрытие выбранных и по пати.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  redecorate: vi.fn(),
  closePids: vi.fn(),
  closeAll: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn()
}));

vi.mock('../js/modules/launcher/launch.js', () => ({
  runningClientDetails: mocks.details,
  redecorateRunningWindows: mocks.redecorate,
  redecorateText: () => '',
  closeClientsByPid: mocks.closePids,
  closeAllClients: mocks.closeAll
}));
vi.mock('../js/core/storage.js', () => ({ isTauri: () => true, persist: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', async importOriginal => ({
  ...(await importOriginal()),
  toast: mocks.toast,
  confirmModal: mocks.confirm
}));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ showCloseReport: vi.fn() }));

let state, openWindowPicker;

const clients = () => [
  { pid: 100, image: 'elementclient_64.exe', startedAt: Date.now() - 60000, title: 'Аа — Воин', elevated: false },
  { pid: 200, image: 'elementclient_64.exe', startedAt: Date.now() - 120000, title: 'Бб — Маг', elevated: false },
  { pid: 300, image: 'elementclient_64.exe', startedAt: null, title: 'Perfect World', elevated: true }
];

const foot = () => document.querySelector('.tf-dialog-foot');
const rows = () => [...document.querySelectorAll('.winp-row')];
const btn = act => foot().querySelector(`[data-act="${act}"]`);
const box = pid => document.querySelector(`.winp-row input[data-pid="${pid}"]`);

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="modal-root"></div>';
  mocks.details.mockResolvedValue(clients());
  mocks.closePids.mockResolvedValue({ found: 1, closed: 1 });
  mocks.closeAll.mockResolvedValue({ found: 3, closed: 3 });
  mocks.confirm.mockResolvedValue(true);
  ({ state } = await import('../js/core/state.js'));
  state.parties = [{ id: 'p1', name: 'Основа' }];
  state.characters = [
    { id: 'a', nick: 'Аа', class: 'Воин', partyIds: ['p1'], mainPartyId: 'p1' },
    { id: 'b', nick: 'Бб', class: 'Маг', partyIds: ['p1'], mainPartyId: 'p1' }
  ];
  ({ openWindowPicker } = await import('../js/modules/launcher/windowPicker.js'));
  await openWindowPicker();
});

describe('список запущенных окон', () => {
  it('показывает ник и класс, PID и время работы', () => {
    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain('Аа');
    expect(rows()[0].textContent).toContain('Воин');
    expect(rows()[0].textContent).toContain('PID 100');
    expect(rows()[0].textContent).toContain('1 мин');
  });

  it('окно не из Твинофермы показано как PID и помечено администратором', () => {
    const unknown = rows().find(r => r.textContent.includes('PID 300'));
    expect(unknown.classList.contains('is-unknown')).toBe(true);
    expect(unknown.textContent).toContain('запущено не из Твинофермы');
    expect(unknown.textContent).toContain('админ');
  });

  it('узнанные окна идут первыми по алфавиту, безымянные — после', () => {
    expect(rows().map(r => r.querySelector('input').dataset.pid)).toEqual(['100', '200', '300']);
  });
});

describe('закрытие выбранных окон', () => {
  it('без выбора кнопки закрытия выключены', () => {
    expect(btn('selected').disabled).toBe(true);
    expect(btn('party').disabled).toBe(true);
    expect(btn('all').disabled).toBe(false);
  });

  it('галочка включает кнопку и обновляет счётчик', () => {
    box(100).checked = true;
    box(100).dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('.winp-count').textContent).toContain('1');
    expect(btn('selected').disabled).toBe(false);
    expect(btn('selected').textContent).toContain('(1)');
  });

  it('«Закрыть выбранные» спрашивает подтверждение и закрывает только эти PID', async () => {
    box(100).checked = true;
    box(100).dispatchEvent(new Event('change', { bubbles: true }));
    box(200).checked = true;
    box(200).dispatchEvent(new Event('change', { bubbles: true }));

    btn('selected').click();
    await vi.waitFor(() => expect(mocks.closePids).toHaveBeenCalled());
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.confirm.mock.calls[0][0].text).toContain('Аа');
    expect(mocks.closePids.mock.calls[0][0].sort()).toEqual([100, 200]);
  });

  it('отказ в подтверждении ничего не закрывает', async () => {
    mocks.confirm.mockResolvedValue(false);
    box(100).checked = true;
    box(100).dispatchEvent(new Event('change', { bubbles: true }));
    btn('selected').click();
    await new Promise(r => setTimeout(r, 20));
    expect(mocks.closePids).not.toHaveBeenCalled();
  });

  it('«Закрыть все» закрывает все окна', async () => {
    btn('all').click();
    await vi.waitFor(() => expect(mocks.closeAll).toHaveBeenCalled());
  });

  it('после закрытия список перечитывается', async () => {
    mocks.details.mockResolvedValue([clients()[1]]);
    box(100).checked = true;
    box(100).dispatchEvent(new Event('change', { bubbles: true }));
    btn('selected').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].querySelector('input').dataset.pid).toBe('200');
  });

  it('ошибка закрытия показывается, а не глотается', async () => {
    mocks.closePids.mockRejectedValue(new Error('нет доступа'));
    box(100).checked = true;
    box(100).dispatchEvent(new Event('change', { bubbles: true }));
    btn('selected').click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.toast.mock.calls[0][0]).toContain('нет доступа');
  });

  it('обновление списка перечитывает данные', async () => {
    mocks.details.mockClear();
    // Кнопка обновления живёт в подзаголовке окна, а не в подвале с действиями
    const refresh = document.querySelector('.tf-dialog-sub [data-act="refresh"]');
    expect(refresh).not.toBeNull();
    refresh.click();
    await vi.waitFor(() => expect(mocks.details).toHaveBeenCalled());
  });
});

describe('отметить все окна разом', () => {
  const toggle = () => btn('toggle-all');
  const allBoxes = () => [...document.querySelectorAll('.winp-row input[data-pid]')];

  it('кнопка отмечает все окна: галочки, счётчик и подпись', () => {
    expect(toggle().textContent).toContain('Отметить все');
    toggle().click();
    expect(allBoxes().map(b => b.checked)).toEqual([true, true, true]);
    expect(document.querySelector('.winp-count').textContent).toContain('3');
    expect(btn('selected').textContent).toContain('(3)');
    // Выбрано всё — кнопка предлагает обратное действие
    expect(toggle().textContent).toContain('Снять все');
  });

  it('повторное нажатие снимает все отметки', () => {
    toggle().click();
    toggle().click();
    expect(allBoxes().map(b => b.checked)).toEqual([false, false, false]);
    expect(document.querySelector('.winp-count').textContent).toContain('0');
    expect(toggle().textContent).toContain('Отметить все');
    expect(btn('selected').disabled).toBe(true);
  });

  it('частичный выбор не мешает: кнопка отмечает недостающее, а не снимает выбранное', () => {
    box(100).checked = true;
    box(100).dispatchEvent(new Event('change', { bubbles: true }));
    expect(toggle().textContent).toContain('Отметить все');
    toggle().click();
    expect(allBoxes().map(b => b.checked)).toEqual([true, true, true]);
  });

  it('окно без ника отмечается вместе со своими — так же, как его закрывают', () => {
    toggle().click();
    expect(box(300).checked).toBe(true);
  });

  it('после отметки всех «Закрыть выбранные» закрывает весь список', async () => {
    toggle().click();
    btn('selected').click();
    await vi.waitFor(() => expect(mocks.closePids).toHaveBeenCalled());
    expect(mocks.closePids.mock.calls[0][0].sort()).toEqual([100, 200, 300]);
  });

  it('отметка не трогает само окно: закрывать надо отдельной кнопкой', () => {
    toggle().click();
    expect(mocks.closePids).not.toHaveBeenCalled();
    expect(mocks.closeAll).not.toHaveBeenCalled();
  });

  it('список пуст — кнопка выключена, отмечать нечего', async () => {
    mocks.details.mockResolvedValue([]);
    const refresh = document.querySelector('.tf-dialog-sub [data-act="refresh"]');
    refresh.click();
    await vi.waitFor(() => expect(btn('toggle-all').disabled).toBe(true));
  });
});

it('keeps decoration progress visible across redraws and prevents repeated clicks', async () => {
  let finish;
  mocks.redecorate.mockImplementation(
    (_rows, { onProgress }) =>
      new Promise(resolve => {
        onProgress({ percent: 25, done: 1, total: 2, nick: 'Бб', phase: 'apply' });
        finish = () => {
          onProgress({ percent: 100, done: 2, total: 2, phase: 'done' });
          resolve({ ok: 0, fixed: 2, failed: 0, missing: 0, details: [] });
        };
      })
  );
  await openWindowPicker();
  document.querySelector('[data-act="redecorate"]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-decoration-progress]').textContent).toContain('25%'));
  expect(document.querySelector('[data-act="redecorate"]').disabled).toBe(true);
  document.querySelector('[data-act="redecorate"]').click();
  expect(mocks.redecorate).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(document.querySelector('[data-act="redecorate"]').disabled).toBe(false));
  expect(document.querySelector('[data-decoration-progress]').textContent).toContain('100%');
});

it('attaches an external client to a free character and recognizes it after reload', async () => {
  state.characters.push({ id: 'c', nick: 'Вв', class: 'Маг', partyIds: ['p1'] });
  const startedAt = Date.now() - 3600000;
  mocks.details.mockResolvedValue(clients().map(c => (c.pid === 300 ? { ...c, startedAt } : c)));
  document.querySelector('[data-act="refresh"]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-attach="300"] option[value="c"]')).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelector('[data-attach="300"]').disabled).toBe(false));
  const select = document.querySelector('[data-attach="300"]');
  const option = document.createElement('option');
  option.value = 'c';
  select.append(option);
  select.value = 'c';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[data-detach="300"]')).not.toBeNull());
  expect(rows().find(r => r.textContent.includes('PID 300')).textContent).toContain('Вв');
  expect(
    rows()
      .find(r => r.textContent.includes('PID 300'))
      .classList.contains('is-unknown')
  ).toBe(false);
  window.localStorage.clear();
});
it('does not attach a character already recognized in another running window', async () => {
  window.localStorage.clear();
  const select = document.querySelector('[data-attach="300"]');
  select.value = 'a';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('уже привязан'), 'error'));
  expect(document.querySelector('[data-attach="300"]')).not.toBeNull();
});

it('can override a recognized window and remove only its manual binding', async () => {
  window.localStorage.clear();
  state.characters.push({ id: 'c', nick: 'Вв', class: 'Маг', partyIds: ['p1'] });
  const live = clients();
  mocks.details.mockResolvedValue(live);
  document.querySelector('[data-act="refresh"]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-attach="100"] option[value="c"]')).not.toBeNull());
  const select = document.querySelector('[data-attach="100"]');
  select.value = 'c';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[data-detach="100"]')).not.toBeNull());
  expect(
    document.querySelector('[data-attach="100"]').closest('.winp-row').querySelector('.winp-who b').textContent
  ).toBe('Вв');
  expect(
    document.querySelector('[data-attach="100"]').closest('.winp-row').querySelector('.winp-source').textContent
  ).toContain('Ручная');
  document.querySelector('[data-detach="100"]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-detach="100"]')).toBeNull());
  expect(
    document.querySelector('[data-attach="100"]').closest('.winp-row').querySelector('.winp-who b').textContent
  ).toBe('Аа');
  expect(
    document.querySelector('[data-attach="100"]').closest('.winp-row').querySelector('.winp-source').textContent
  ).toContain('заголовка');
});

it('uses the themed attachment menu, disables characters occupied by other windows and closes with the dialog', () => {
  const button = document.querySelector('[data-attach-open="100"]');
  expect(document.querySelector('select[data-attach="100"]').hidden).toBe(true);
  button.click();
  const menu = document.querySelector('.winp-attach-menu');
  expect(menu.getAttribute('role')).toBe('menu');
  expect(menu.querySelector('[data-id="b"]').disabled).toBe(true);
  expect(menu.querySelector('[data-id="a"]').disabled).toBe(false);
  expect(menu.closest('.tf-overlay')).toBeTruthy();
  document.querySelector('.tf-close').click();
  expect(document.querySelector('.winp-attach-menu')).toBeNull();
});
