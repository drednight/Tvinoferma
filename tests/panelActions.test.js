import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #54-2: действия панели «Помощник входа» в основном окне
const chars = [
  { id: 'a', nick: 'A', partyIds: ['p1', 'p2'], mainPartyId: 'p1', isLoggedIn: true, ancientCoins: 28.5 },
  { id: 'b', nick: 'B', partyIds: ['p1'], mainPartyId: 'p1', isLoggedIn: false, ancientCoins: 10 },
  { id: 'c', nick: 'C', partyIds: [], isLoggedIn: false, ancientCoins: 1 }
];
const parties = [{ id: 'p1', name: 'Основа' }, { id: 'p2', name: 'Запас' }];
vi.mock('../js/core/state.js', () => ({ state: { characters: chars, parties } }));
const { handlePanelAction, partyStatusText, notifyScript } = await import('../js/desktop/panelActions.js');

let d;
beforeEach(() => {
  d = {
    notify: vi.fn(async () => {}),
    hasSession: vi.fn(async () => true),
    isChecking: vi.fn(() => false),
    refreshBalance: vi.fn(async () => ({ updated: 1, failed: 0 }))
  };
});
const said = () => d.notify.mock.calls.map(c => c[1]);

describe('partyStatusText', () => {
  it('по строке на каждую партию, основная со звёздочкой; монеты считаются по основной пати', () => {
    const text = partyStatusText(chars[0], parties, chars);
    const [main, extra] = text.split('\n');
    expect(main).toContain('★ Основа: 2 акк., 🟢 1');
    expect(main).toContain('38,5');   // 28,5 + 10: оба с основной пати p1
    expect(extra).toContain('Запас: 1 акк.');
    expect(extra).not.toContain('★');
  });
  it('персонаж без пати', () => {
    expect(partyStatusText(chars[2], parties, chars)).toBe('Персонаж без пати');
  });
});

describe('handlePanelAction', () => {
  it('игнорирует неизвестного персонажа и неизвестное действие', async () => {
    await handlePanelAction({ charId: 'zzz', action: 'balance' }, d);
    await handlePanelAction({ charId: 'a', action: 'format-disk' }, d);
    await handlePanelAction(null, d);
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.refreshBalance).not.toHaveBeenCalled();
  });

  it('parties и promo отвечают в панель', async () => {
    await handlePanelAction({ charId: 'a', action: 'parties' }, d);
    await handlePanelAction({ charId: 'a', action: 'promo' }, d);
    expect(d.notify).toHaveBeenNthCalledWith(1, 'a', expect.stringContaining('Основа'));
    expect(said()[1]).toContain('#25');
  });

  it('balance: обновляет баланс и показывает итог', async () => {
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(d.refreshBalance).toHaveBeenCalledWith(chars[0]);
    expect(said().at(-1)).toContain('28,5');
  });

  it('balance без сессии в банке не запускается (не трогаем окно, где идёт вход)', async () => {
    d.hasSession.mockResolvedValue(false);
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(d.refreshBalance).not.toHaveBeenCalled();
    expect(said()[0]).toContain('Проверить авторизацию');
  });

  it('balance во время проверки входа не запускается', async () => {
    d.isChecking.mockReturnValue(true);
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(d.refreshBalance).not.toHaveBeenCalled();
  });

  it('balance: ошибка и неудача дают понятное сообщение; повторный запрос после окончания работает', async () => {
    d.refreshBalance.mockResolvedValueOnce({ updated: 0, failed: 1 });
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(said().at(-1)).toContain('не удалось');
    d.refreshBalance.mockRejectedValueOnce(new Error('boom'));
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(said().at(-1)).toContain('не удалось');
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(said().at(-1)).toContain('28,5');
  });

  it('повторный клик, пока баланс запрашивается, не запускает второй запрос', async () => {
    let finish;
    d.refreshBalance.mockImplementation(() => new Promise(r => { finish = r; }));
    const first = handlePanelAction({ charId: 'a', action: 'balance' }, d);
    await new Promise(r => setTimeout(r, 10));
    await handlePanelAction({ charId: 'a', action: 'balance' }, d);
    expect(d.refreshBalance).toHaveBeenCalledTimes(1);
    finish({ updated: 1, failed: 0 });
    await first;
  });
});

describe('notifyScript', () => {
  it('текст попадает в скрипт как JSON-строка (кавычки и теги не ломают код)', () => {
    const script = notifyScript('он сказал "привет" </script>');
    expect(script).toContain('tf-panel-notify');
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('\\"привет\\"');
  });
});
