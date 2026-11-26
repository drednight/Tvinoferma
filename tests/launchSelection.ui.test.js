import { describe, it, expect, beforeEach } from 'vitest';
import { pickerRows, selectMembersById, openLaunchPicker } from '../js/modules/launcher/launchSelection.js';

const members = [
  { id: 'c', nick: 'Вв', class: 'Жрец' },
  { id: 'a', nick: 'Аа', class: 'Воин' },
  { id: 'b', nick: 'Бб', class: '' }
];

describe('selectMembersById & pickerRows', () => {
  it('сохраняет порядок пати, отбрасывает неизвестные id и возвращает droppedIds', () => {
    const res = selectMembersById(members, ['b', 'missing-1', 'c', 'missing-2']);
    expect(res.selected.map(m => m.id)).toEqual(['c', 'b']);
    expect(res.droppedIds).toEqual(['missing-1', 'missing-2']);
  });

  it('при пустом массиве возвращает пустой selected', () => {
    expect(selectMembersById(members, [])).toEqual({ selected: [], droppedIds: [] });
  });

  it('pickerRows проставляет значок класса и флаг уже запущенного окна', () => {
    const rows = pickerRows(members, { runningIds: new Set(['a']) });
    expect(rows[0].iconSrc).toBeTruthy();
    expect(rows[0].alreadyRunning).toBe(false);
    expect(rows[1].alreadyRunning).toBe(true);
    expect(rows[2].iconSrc).toBe('');
  });
});

describe('модальное окно выбора состава openLaunchPicker', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
  });

  const dlg = () => document.querySelector('.tf-dialog');
  const checks = () => [...document.querySelectorAll('.plp-check')];

  it('отмечает всех по умолчанию, показывает бейдж «окно уже запущено» и счётчик', async () => {
    const pending = openLaunchPicker({
      partyName: 'Основа',
      members,
      runningIds: new Set(['a'])
    });
    expect(dlg().textContent).toContain('Запуск пати „Основа“ — кого запускаем');
    expect(checks().every(c => c.checked)).toBe(true);
    expect(document.querySelector('.plp-count').textContent).toBe('Запустить: 3 из 3');
    expect(document.querySelector('[data-act="launch"]').textContent).toBe('▶ Запустить (3)');
    expect(document.querySelector('[data-member-id="a"] .plp-badge').textContent).toBe('окно уже запущено');
    expect(document.querySelector('[data-member-id="c"] .plp-badge')).toBeNull();

    document.querySelector('[data-act="cancel"]').click();
    expect(await pending).toBeNull();
  });

  it('кнопки «Снять всех» и «Выбрать всех» меняют отметки и блокируют «Запустить» при 0', async () => {
    const pending = openLaunchPicker({ partyName: 'Основа', members });
    const launchBtn = document.querySelector('[data-act="launch"]');

    document.querySelector('[data-act="none"]').click();
    expect(checks().every(c => !c.checked)).toBe(true);
    expect(document.querySelector('.plp-count').textContent).toBe('Запустить: 0 из 3');
    expect(launchBtn.disabled).toBe(true);
    expect(launchBtn.textContent).toBe('▶ Запустить (0)');

    document.querySelector('[data-act="all"]').click();
    expect(checks().every(c => c.checked)).toBe(true);
    expect(launchBtn.disabled).toBe(false);
    expect(launchBtn.textContent).toBe('▶ Запустить (3)');

    // Снимаем второго (Аа) и запускаем — порядок сохраняется (Вв, Бб)
    checks()[1].checked = false;
    checks()[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(launchBtn.textContent).toBe('▶ Запустить (2)');
    launchBtn.click();
    expect((await pending).map(m => m.id)).toEqual(['c', 'b']);
  });

  it('Escape отменяет, Enter запускает отмеченных, удаление из DOM не вешает промис', async () => {
    const p1 = openLaunchPicker({ partyName: 'Основа', members });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p1).toBeNull();

    const p2 = openLaunchPicker({ partyName: 'Основа', members });
    checks()[0].checked = false;
    checks()[0].dispatchEvent(new Event('change', { bubbles: true }));
    dlg().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((await p2).map(m => m.id)).toEqual(['a', 'b']);

    const p3 = openLaunchPicker({ partyName: 'Основа', members });
    document.getElementById('modal-root').innerHTML = '';
    expect(await p3).toBeNull();
  });
});
