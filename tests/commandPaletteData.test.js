// Командная палитра Ctrl+K (Issue #40): поиск команд и их состав (js/core/commandPaletteData.js).
import { describe, it, expect, vi } from 'vitest';

import {
  normalizeQuery, scoreCommand, filterCommands, isHeading, buildCommands
} from '../js/core/commandPaletteData.js';

const cmd = (title, extra = {}) => ({ id: title, title, group: 'Тест', run: () => {}, ...extra });

describe('поиск команд', () => {
  const commands = [
    cmd('👤 Ауразак', { subtitle: 'Воин, ур. 105', keywords: ['воин', 'Ауразак_1', 'основа'] }),
    cmd('🔐 Проверить авторизацию', { keywords: ['вход', 'логин', 'сессия'] }),
    cmd('💰 Обновить балансы', { keywords: ['монеты'] }),
    cmd('🛡 Основа', { keywords: ['группа', 'пати'] })
  ];

  it('пустой запрос возвращает всё в исходном порядке', () => {
    expect(filterCommands(commands, '')).toHaveLength(4);
    expect(filterCommands(commands, '   ')).toHaveLength(4);
  });

  it('находит по части ника и не зависит от регистра', () => {
    expect(filterCommands(commands, 'аураз')[0].title).toContain('Ауразак');
    expect(filterCommands(commands, 'АУРАЗ')[0].title).toContain('Ауразак');
  });

  it('находит по классу и тегу из keywords', () => {
    expect(filterCommands(commands, 'воин')[0].title).toContain('Ауразак');
    expect(filterCommands(commands, 'основа').length).toBeGreaterThan(0);
  });

  it('находит по синониму действия, а не только по названию', () => {
    expect(filterCommands(commands, 'логин')[0].title).toContain('Проверить авторизацию');
    expect(filterCommands(commands, 'монеты')[0].title).toContain('балансы');
  });

  it('точное и начальное совпадение важнее совпадения в середине', () => {
    const list = [cmd('Пати'), cmd('Новая пати'), cmd('Запустить пати')];
    expect(filterCommands(list, 'пати').map(c => c.title)).toEqual(['Пати', 'Новая пати', 'Запустить пати']);
  });

  it('ничего не найдено — пустой список, а не все команды', () => {
    expect(filterCommands(commands, 'щщщ')).toEqual([]);
  });

  it('«ё» и «е» взаимозаменяемы, лишние пробелы не мешают', () => {
    // «ё» приводится к «е» и в запросе, и в названии: «Счётчики» находится как «счетчики»
    expect(normalizeQuery('  Счётчики  ')).toBe('счетчики');
    const list = [cmd('Счётчики')];
    expect(filterCommands(list, 'счетчики')).toHaveLength(1);
    expect(filterCommands(list, 'счётчики')).toHaveLength(1);
    expect(filterCommands(list, '  счетчики  ')).toHaveLength(1);

    const marathons = [cmd('Марафоны')];
    expect(filterCommands(marathons, '  марафоны  ')).toHaveLength(1);
  });

  it('оценка: точное совпадение выше вхождения', () => {
    const exact = cmd('Пати');
    const partial = cmd('Запустить пати');
    expect(scoreCommand(exact, 'пати')).toBeGreaterThan(scoreCommand(partial, 'пати'));
    expect(scoreCommand(partial, 'щщ')).toBe(0);
  });

  it('количество результатов ограничивается', () => {
    const many = Array.from({ length: 100 }, (_, i) => cmd(`Персонаж ${i}`));
    expect(filterCommands(many, 'персонаж', 10)).toHaveLength(10);
    expect(filterCommands(many, '', 10)).toHaveLength(10);
  });
});

describe('состав команд', () => {
  const appState = {
    characters: [
      { id: 'Ауразак', nick: 'Ауразак', class: 'Воин', level: 105, tags: ['основа'] },
      { id: 'Мираж', nick: 'Мираж', class: 'Маг' }
    ],
    parties: [{ id: 'p1', name: 'Основа' }],
    marathons: [
      { id: 'm1', kind: 'single', title: 'Летний марафон', status: 'active' },
      { id: 's1', kind: 'series', title: 'Лето 2026' }
    ]
  };
  const commands = buildCommands(appState, { switchTab: vi.fn(), run: vi.fn() });
  const titles = () => commands.map(c => c.title);

  it('есть разделы и основные действия', () => {
    expect(titles()).toContain('⌂ Сегодня');
    expect(titles()).toContain('👥 Персонажи');
    expect(titles()).toContain('⚙ Настройки');
    expect(titles()).toContain('🔐 Проверить авторизацию');
    expect(titles()).toContain('🎮 Запущенные окна игры');
    expect(titles()).toContain('📤 Экспорт всех данных');
  });

  it('на каждого персонажа — открыть, проверить вход, запустить, обновить баланс', () => {
    expect(titles()).toContain('👤 Ауразак');
    expect(titles()).toContain('🔐 Проверить вход: Ауразак');
    expect(titles()).toContain('▶ Запустить игру: Ауразак');
    expect(titles()).toContain('💰 Обновить баланс: Ауразак');
  });

  it('пати дают запуск и закрытие окон своей пати', () => {
    expect(titles()).toContain('▶ Запустить пати: Основа');
    expect(titles()).toContain('🛑 Закрыть окна пати: Основа');
  });

  it('марафоны и папки попадают в список', () => {
    expect(titles()).toContain('🏃 Летний марафон');
    expect(titles()).toContain('📁 Лето 2026');
  });

  it('разделители помечены и не выбираются', () => {
    const headings = commands.filter(isHeading);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every(h => h.kind === 'heading')).toBe(true);
  });

  it('пустое состояние не падает и не показывает лишнего', () => {
    const empty = buildCommands({}, {});
    expect(empty.some(c => c.title.includes('👤'))).toBe(false);
    expect(empty.length).toBeGreaterThan(0);   // разделы и действия остаются
    expect(buildCommands(null, {})).toHaveLength(empty.length);
  });

  it('команда персонажа выполняет действие с его id', () => {
    const run = vi.fn();
    const list = buildCommands(appState, { switchTab: vi.fn(), run });
    list.find(c => c.title === '👤 Ауразак').run();
    expect(run).toHaveBeenCalledWith('open-character', 'Ауразак');
    list.find(c => c.id === 'char-launch-Мираж').run();
    expect(run).toHaveBeenCalledWith('launch-one', 'Мираж');
  });

  it('команды разделов переключают вкладку', () => {
    const switchTab = vi.fn();
    buildCommands(appState, { switchTab }).find(c => c.title === '🏃 Марафоны').run();
    expect(switchTab).toHaveBeenCalledWith('marathons');
  });

  it('id команд уникальны: иначе выбор в палитре сработает не на той строке', () => {
    const ids = commands.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
