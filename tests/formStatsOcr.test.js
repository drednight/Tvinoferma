// Кнопка «Заполнить со скриншота» в форме персонажа: обработчик должен вставать,
// потому что раньше он вешался до создания разметки и не находил кнопку.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openStatsImport: vi.fn(), apply: null, submit: null }));

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true, saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({
  showModal: vi.fn(options => { mocks.submit = options.onSubmit; }),
  toast: vi.fn(), confirmModal: vi.fn(async () => true)
}));
vi.mock('../js/modules/characters/list.js', () => ({ renderCharacters: vi.fn(), allTags: () => [] }));
vi.mock('../js/modules/parties/index.js', () => ({ renderParties: vi.fn() }));
vi.mock('../js/modules/characters/statsImport.js', () => ({
  openStatsImport: mocks.openStatsImport,
  statsOcrAvailable: vi.fn(async () => true)
}));

let state, openCharacterForm;

/** showModal подменяем своим: он должен реально вставить разметку, как настоящий. */
async function mountForm() {
  const ui = await import('../js/core/ui.js');
  ui.showModal.mockImplementation(({ content }) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-overlay"><div class="modal-container"><div class="modal-body">${content}</div><div class="modal-footer"></div></div></div>`;
  });
  openCharacterForm(null);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = [];
  state.archivedCharacters = [];
  state.parties = [];
  ({ openCharacterForm } = await import('../js/modules/characters/formEditor.js'));
  // Открытие окна разбора запоминает колбэк переноса, чтобы его можно было вызвать вручную
  mocks.openStatsImport.mockImplementation(({ onApply }) => { mocks.apply = onApply; return {}; });
});

const ocrButton = () => document.getElementById('btn-stats-ocr');

describe('кнопка «Заполнить со скриншота»', () => {
  it('кнопка находится в футере, а не среди полей формы', async () => {
    await mountForm();
    expect(ocrButton()).not.toBeNull();
    expect(ocrButton().textContent).toContain('скриншота');
    expect(ocrButton().closest('.modal-footer')).not.toBeNull();
    expect(document.querySelector('.modal-body #btn-stats-ocr')).toBeNull();
  });

  it('клик открывает разбор скриншота (обработчик действительно навешен)', async () => {
    await mountForm();
    ocrButton().click();
    // Импорт модуля асинхронный — ждём, пока он отработает
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalledTimes(1));
  });

  it('обработчик не навешивается дважды', async () => {
    await mountForm();
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalledTimes(1));
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalledTimes(2));
  });

  it('распознанные значения попадают в поля формы', async () => {
    await mountForm();
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalled());
    // Значения приходят из окна разбора уже подтверждёнными пользователем
    mocks.apply({ hp: 42350, accuracy: 1512 });
    const hp = document.querySelector('input[name="stat-hp"]');
    const acc = document.querySelector('input[name="stat-accuracy"]');
    expect(hp.value).toBe('42350');
    expect(acc.value).toBe('1512');
  });

  it('перенесённое выше текущего — зелёное, ниже — красное, равное — нейтральное', async () => {
    await mountForm();
    // Текущие значения пишем в поля до разбора
    document.querySelector('input[name="stat-strength"]').value = '100';
    document.querySelector('input[name="stat-accuracy"]').value = '700';
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalled());
    mocks.apply({ strength: 200, accuracy: 500, evasion: 0 });
    expect(document.querySelector('input[name="stat-strength"]').classList.contains('is-up')).toBe(true);
    expect(document.querySelector('input[name="stat-accuracy"]').classList.contains('is-down')).toBe(true);
    expect(document.querySelector('input[name="stat-evasion"]').classList.contains('is-filled')).toBe(true);
  });

  it('поля, которых нет в ответе, не обнуляются', async () => {
    await mountForm();
    const before = document.querySelector('input[name="stat-strength"]').value;
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalled());
    mocks.apply({ hp: 100 });
    expect(document.querySelector('input[name="stat-strength"]').value).toBe(before);
  });

  it('перенесённое поле получает класс направления (изменённое — is-up)', async () => {
    await mountForm();
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalled());
    mocks.apply({ pa: 2340 });   // было 0 → выше: зелёная подсветка
    const pa = document.querySelector('input[name="stat-pa"]');
    expect(pa.classList.contains('is-up')).toBe(true);
  });
});

describe('характеристики одним сворачиваемым блоком', () => {
  it('все четыре группы внутри одного details', async () => {
    await mountForm();
    const fold = document.querySelector('details.stats-fold');
    expect(fold).not.toBeNull();
    const text = fold.textContent;
    for (const part of ['Основные характеристики', 'Бой и Защита', 'Показатели боя', 'PvE и Пробивание']) {
      expect(text, part).toContain(part);
    }
    // Ни одна группа характеристик не осталась отдельным блоком вне свёртки:
    // вне её допустимы только проходки и монеты
    const outside = [...document.querySelectorAll('.modal-body > .info-block, .modal-body > details:not(.stats-fold)')]
      .map(el => el.querySelector('h4')?.textContent || el.querySelector('summary')?.textContent || '')
      .filter(Boolean);
    expect(outside.some(t => /характеристик|Бой и Защита|Показатели боя|PvE/i.test(t))).toBe(false);
  });

  describe('редактирование архивного персонажа', () => {
    it('сохраняет изменения в архиве, не возвращая персонажа в активный список', async () => {
      const archived = {
        id: 'archived', nick: 'Архивный', class: 'Маг', level: 10, partyIds: [], mainPartyId: null,
        stats: {}, dungeonPasses: {}, contacts: {}, tags: [], ancientCoins: 0
      };
      state.archivedCharacters = [archived];
      const ui = await import('../js/core/ui.js');
      ui.showModal.mockImplementation(options => { mocks.submit = options.onSubmit; });
      openCharacterForm(archived);
      const values = new Map([
        ['nick', 'Архивный изменённый'], ['class', 'Маг'], ['level', '20'], ['mainParty', ''],
        ['sky-name', ''], ['sky-level', ''], ['tags', 'сохранённый'], ['contact-email', ''],
        ['contact-password', ''], ['contact-recovery', ''], ['contact-phone', ''], ['coins', '0'],
        ['pass-weapon', '4'], ['pass-armor', '2'], ['pass-relic', '1']
      ]);
      const formData = { get: key => values.get(key) ?? null, getAll: () => [] };

      expect(await mocks.submit(formData, { setError: vi.fn() })).toBe(true);
      expect(state.archivedCharacters[0]).toMatchObject({
        id: 'archived', nick: 'Архивный изменённый', level: 20, tags: ['сохранённый'],
        dungeonPasses: { weapon: 4, armor: 2, relic: 1 }
      });
      expect(state.characters).toEqual([]);
    });
  });

  it('блок раскрыт по умолчанию: характеристики нужны чаще, чем скрываются', async () => {
    await mountForm();
    expect(document.querySelector('details.stats-fold').open).toBe(true);
  });

  it('поля всех характеристик на месте', async () => {
    await mountForm();
    for (const key of ['endurance', 'hp', 'levelBonus', 'physAttack', 'critChance', 'pvePa', 'magPenetration']) {
      expect(document.querySelector(`input[name="stat-${key}"]`), key).not.toBeNull();
    }
  });

  it('скрытность, обнаружение и максимальные значения убраны', async () => {
    await mountForm();
    for (const key of ['stealth', 'detection', 'hpMax', 'mpMax']) {
      expect(document.querySelector(`input[name="stat-${key}"]`), key).toBeNull();
    }
  });
});
