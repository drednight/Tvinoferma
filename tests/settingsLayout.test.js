import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { balanceSettingsColumns } from '../js/settings/columns.js';
import { DANGER_ACTIONS, clearParties, clearMarathons, clearCharacters } from '../js/settings/dangerZone.js';

const html = readFileSync('index.html', 'utf8');
const css = readFileSync('css/core/layout.css', 'utf8');

/** Сколько панелей в каждой колонке настроек по разметке index.html. */
function columnCounts(source) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  return [...doc.querySelectorAll('.settings-cols > .settings-col')].map(c => c.querySelectorAll(':scope > .panel').length);
}

describe('настройки: колонки', () => {
  it('в разметке левая колонка не короче правой', () => {
    const [left, right] = columnCounts(html);
    expect(left).toBeGreaterThanOrEqual(right);
    expect(left - right).toBeLessThanOrEqual(1);
  });

  it('при запуске панели раскладываются заново: левая заполняется первой, порядок сохраняется', () => {
    document.body.innerHTML = `<div class="settings-cols">
      <div class="settings-col">${[1, 2].map(n => `<details class="panel" data-n="${n}"></details>`).join('')}</div>
      <div class="settings-col">${[3, 4, 5, 6, 7].map(n => `<details class="panel" data-n="${n}"></details>`).join('')}</div>
    </div>`;
    document.querySelector('[data-n="6"]').open = true;
    expect(balanceSettingsColumns()).toEqual([4, 3]);
    const order = (col) => [...col.children].map(el => el.dataset.n).join('');
    const [l, r] = document.querySelectorAll('.settings-col');
    expect(order(l)).toBe('1234');
    expect(order(r)).toBe('567');
    expect(document.querySelector('[data-n="6"]').open).toBe(true); // раскрытая панель осталась раскрытой
  });

  it('чётное число панелей делится поровну, одна колонка или пустая страница не ломаются', () => {
    document.body.innerHTML = `<div class="settings-cols"><div class="settings-col">${'<div class="panel"></div>'.repeat(6)}</div><div class="settings-col"></div></div>`;
    expect(balanceSettingsColumns()).toEqual([3, 3]);
    document.body.innerHTML = '<div></div>';
    expect(balanceSettingsColumns()).toEqual([]);
  });

  it('правила колонок: две равные колонки, на узком окне — одна', () => {
    expect(css).toContain('.settings-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(css).toContain('@media (max-width: 900px) { .settings-cols { grid-template-columns: minmax(0, 1fr); } }');
  });
});

describe('шапка с навигацией', () => {
  it('шапка липкая и выше карточек, а контейнер — колонка (в сетке липкость не работает)', () => {
    expect(css).toMatch(/\.topbar\s*{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*100;/);
    expect(css).toMatch(/\.app-shell\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);
    expect(css).not.toMatch(/\.app-shell\s*{[^}]*display:\s*grid/);
  });
});

describe('опасные действия: разметка', () => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const zone = doc.getElementById('danger-zone');

  it('блок свёрнут по умолчанию, у каждого действия есть описание и кнопка', () => {
    expect(zone).not.toBeNull();
    expect(zone.hasAttribute('open')).toBe(false);
    for (const [kind, id] of [['parties', 'clear-all-parties-btn'], ['marathons', 'clear-all-marathons-btn'], ['characters', 'clear-all-characters-btn']]) {
      const btn = zone.querySelector(`#${id}`);
      expect(btn?.dataset.danger).toBe(kind);
      const item = btn.closest('.danger-item');
      expect(item.querySelector('strong')?.textContent.length).toBeGreaterThan(5);
      expect(item.querySelector('p.muted')?.textContent.length).toBeGreaterThan(40);
    }
  });

  it('«Удалить персонажей» спрятано глубже: во вложенном свёрнутом блоке', () => {
    const btn = zone.querySelector('#clear-all-characters-btn');
    const more = btn.closest('details.danger-more');
    expect(more).not.toBeNull();
    expect(more.hasAttribute('open')).toBe(false);
    expect(zone.querySelector('#clear-all-parties-btn').closest('details.danger-more')).toBeNull();
  });

  it('на вкладке «Марафоны» сверху больше нет кнопок «Новая папка» и «Создать»', () => {
    expect(doc.getElementById('add-folder-btn')).toBeNull();
    expect(doc.getElementById('add-marathon-btn')).toBeNull();
    expect([...doc.querySelectorAll('#fab-menu [data-fab-action="folder"], #fab-menu [data-fab-action="marathon"]')].length).toBe(2);
  });
});

describe('опасные действия: логика', () => {
  let state;
  beforeEach(() => {
    state = {
      parties: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }],
      characters: [
        { id: 'c1', partyIds: ['p1', 'p2'], mainPartyId: 'p1', updatedAt: 'old', launch: { gcAccounts: { g1: { nick: 'x' } } } },
        { id: 'c2', partyIds: [], mainPartyId: null, updatedAt: 'old' }
      ],
      marathons: [{ id: 'm1' }, { id: 'm2', kind: 'series' }],
      marathonTemplates: [{ id: 't' }],
      ui: { expandedCharacterId: 'c1', partyFilter: 'p1' }
    };
  });

  it('пати удаляются, персонажи остаются без пати, марафоны не тронуты', () => {
    expect(clearParties(state)).toBe(2);
    expect(state.parties).toEqual([]);
    expect(state.characters).toHaveLength(2);
    expect(state.characters[0]).toMatchObject({ partyIds: [], mainPartyId: null });
    expect(state.characters[0].updatedAt).not.toBe('old');
    expect(state.characters[1].updatedAt).toBe('old'); // у кого пати не было — не трогаем
    expect(state.marathons).toHaveLength(2);
    expect(state.ui.partyFilter).toBe('');
  });

  it('марафоны и папки удаляются, шаблоны, пати и персонажи остаются', () => {
    expect(clearMarathons(state)).toBe(2);
    expect(state.marathons).toEqual([]);
    expect(state.marathonTemplates).toHaveLength(1);
    expect(state.parties).toHaveLength(2);
    expect(state.characters).toHaveLength(2);
  });

  it('персонажи удаляются, ключи запомненных входов возвращаются для очистки хранилища ОС', () => {
    const res = clearCharacters(state, c => Object.keys(c.launch?.gcAccounts || {}).map(g => `${c.id}@${g}`));
    expect(res).toEqual({ count: 2, accountKeys: ['c1@g1'] });
    expect(state.characters).toEqual([]);
    expect(state.ui.expandedCharacterId).toBeNull();
  });

  it('опасные действия учитывают архивные записи и чистят связи архивной пати', () => {
    state.archivedCharacters = [{ id: 'archived', launch: { gcAccounts: { g2: { nick: 'y' } } } }];
    state.archivedParties = [{ id: 'ap', memberLinks: [{ characterId: 'archived' }] }];
    expect(DANGER_ACTIONS.characters.count(state)).toBe(3);
    expect(DANGER_ACTIONS.parties.count(state)).toBe(3);
    const removed = clearCharacters(state, c => Object.keys(c.launch?.gcAccounts || {}).map(g => `${c.id}@${g}`));
    expect(removed).toEqual({ count: 3, accountKeys: ['c1@g1', 'archived@g2'] });
    expect(state.archivedCharacters).toEqual([]);
    expect(state.archivedParties[0].memberLinks).toEqual([]);
  });

  it('у каждого действия есть описание, название и счётчик', () => {
    for (const a of Object.values(DANGER_ACTIONS)) {
      expect(a.description.length).toBeGreaterThan(60);
      expect(a.title).toMatch(/^Удалить/);
    }
    expect(DANGER_ACTIONS.parties.count(state)).toBe(2);
    expect(DANGER_ACTIONS.characters.count(state)).toBe(2);
    expect(DANGER_ACTIONS.marathons.count({})).toBe(0);
  });
});


describe('смысловые группы настроек', () => {
  it('панели находятся в своих разделах, навигация ведёт к существующим блокам', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const [group, ids] of Object.entries({
      app: ['settings-system', 'settings-launcher', 'settings-browser', 'settings-tray', 'settings-notifications'],
      sync: ['settings-scripts', 'settings-freshness', 'log-hub-panel'],
      updates: ['settings-update-panel'], data: ['settings-backups', 'settings-transfer', 'settings-security'],
      help: ['guide-library', 'settings-hotkeys'],
    })) {
      for (const id of ids) expect(doc.querySelector(`#settings-${group} #${id}`)).not.toBeNull();
    }
    // «Состояние парсеров» — это диагностика, а не настройка: панель уехала в «Инструменты»
    expect(doc.querySelector('#settings-sync #parser-health-panel')).toBeNull();
    expect(doc.querySelector('[data-section="tools"] #parser-health-panel')).not.toBeNull();
    for (const link of doc.querySelectorAll('.settings-nav a')) expect(doc.querySelector(link.getAttribute('href'))).not.toBeNull();
    expect(doc.querySelector('#danger-zone').closest('.settings-group')).toBeNull();
    expect(doc.querySelector('[data-setting="updates.mode"] option[value="never"]')).toBeNull();
    const ids = [...doc.querySelectorAll('[id]')].map(el => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('балансировка не переносит панели между смысловыми группами', () => {
    document.body.innerHTML = `<div class="settings-cols" id="first"><div class="settings-col"><div class="panel" id="a"></div></div><div class="settings-col"><div class="panel" id="b"></div><div class="panel" id="c"></div></div></div><div class="settings-cols" id="second"><div class="settings-col"><div class="panel" id="d"></div></div><div class="settings-col"></div></div>`;
    expect(balanceSettingsColumns()).toEqual([2, 1, 1, 0]);
    expect([...document.querySelectorAll('#first .panel')].map(el => el.id)).toEqual(['a', 'b', 'c']);
    expect(document.querySelector('#second #d')).not.toBeNull();
  });
});

describe('информация о системе', () => {
  it('свёрнута по умолчанию, путь и режим доступны после раскрытия', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');const panel = doc.getElementById('settings-system');
    expect(panel.tagName).toBe('DETAILS');expect(panel.hasAttribute('open')).toBe(false);
    expect(panel.querySelector('summary h3').textContent).toBe('Информация о системе');
    for (const id of ['storage-runtime','data-dir','copy-data-dir-btn']) expect(panel.querySelector(`#${id}`)).not.toBeNull();
  });
});
