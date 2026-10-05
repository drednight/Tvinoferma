// Окно «Запущенные окна игры» (js/modules/launcher/windowPicker.js):
// список клиентов, галочки, закрытие выбранных и по пати.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  closePids: vi.fn(),
  closeAll: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn()
}));

vi.mock('../js/modules/launcher/launch.js', () => ({
  runningClientDetails: mocks.details,
  closeClientsByPid: mocks.closePids,
  closeAllClients: mocks.closeAll
}));
vi.mock('../js/core/storage.js', () => ({ isTauri: () => true, persist: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: mocks.confirm }));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ showCloseReport: vi.fn() }));

let state, openWindowPicker;

const clients = () => [
  { pid: 100, image: 'elementclient_64.exe', startedAt: Date.now() - 60000, title: 'Аа — Воин', elevated: false },
  { pid: 200, image: 'elementclient_64.exe', startedAt: Date.now() - 120000, title: 'Бб — Маг', elevated: false },
  { pid: 300, image: 'elementclient_64.exe', startedAt: null, title: 'Perfect World', elevated: true }
];

const foot = () => document.querySelector('.tf-dialog-foot');
const rows = () => [...document.querySelectorAll('.winp-row')];
const btn = (act) => foot().querySelector(`[data-act="${act}"]`);
const box = (pid) => document.querySelector(`.winp-row input[data-pid="${pid}"]`);

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
