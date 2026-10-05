// Кнопка «Заполнить со скриншота» в форме персонажа: обработчик должен вставать,
// потому что раньше он вешался до создания разметки и не находил кнопку.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openStatsImport: vi.fn(), apply: null }));

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true, saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ showModal: vi.fn(), toast: vi.fn(), confirmModal: vi.fn(async () => true) }));
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
    root.innerHTML = `<div class="modal-overlay"><div class="modal-container"><div class="modal-body">${content}</div></div></div>`;
  });
  openCharacterForm(null);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  state.characters = [];
  state.parties = [];
  ({ openCharacterForm } = await import('../js/modules/characters/formEditor.js'));
  // Открытие окна разбора запоминает колбэк переноса, чтобы его можно было вызвать вручную
  mocks.openStatsImport.mockImplementation(({ onApply }) => { mocks.apply = onApply; return {}; });
});

const ocrButton = () => document.getElementById('btn-stats-ocr');

describe('кнопка «Заполнить со скриншота»', () => {
  it('кнопка есть в форме', async () => {
    await mountForm();
    expect(ocrButton()).not.toBeNull();
    expect(ocrButton().textContent).toContain('скриншота');
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
    mocks.apply({ hpMax: 42350, accuracy: 1512 });
    const hp = document.querySelector('input[name="stat-hpMax"]');
    const acc = document.querySelector('input[name="stat-accuracy"]');
    expect(hp.value).toBe('42350');
    expect(acc.value).toBe('1512');
  });

  it('поля, которых нет в ответе, не обнуляются', async () => {
    await mountForm();
    const before = document.querySelector('input[name="stat-strength"]').value;
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalled());
    mocks.apply({ hpMax: 100 });
    expect(document.querySelector('input[name="stat-strength"]').value).toBe(before);
  });

  it('перенесённые поля подсвечиваются', async () => {
    await mountForm();
    ocrButton().click();
    await vi.waitFor(() => expect(mocks.openStatsImport).toHaveBeenCalled());
    mocks.apply({ pa: 2340 });
    expect(document.querySelector('input[name="stat-pa"]').classList.contains('is-filled')).toBe(true);
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

  it('блок раскрыт по умолчанию: характеристики нужны чаще, чем скрываются', async () => {
    await mountForm();
    expect(document.querySelector('details.stats-fold').open).toBe(true);
  });

  it('поля всех характеристик на месте', async () => {
    await mountForm();
    for (const key of ['endurance', 'hpMax', 'physAttack', 'critChance', 'pvePa', 'magPenetration']) {
      expect(document.querySelector(`input[name="stat-${key}"]`), key).not.toBeNull();
    }
  });
});
