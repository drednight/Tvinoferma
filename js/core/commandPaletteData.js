// js/core/commandPaletteData.js
// Данные командной палитры (Ctrl+K): какие команды есть и как они находятся по запросу.
//
// Логика отделена от интерфейса: `buildCommands` собирает команды из состояния приложения,
// `filterCommands` ищет их по запросу. Поэтому и то и другое проверяется тестами без DOM.

/** Разряды и регистр не мешают поиску: «Ауразак», «ауразак», «aura» находятся одинаково. */
export function normalizeQuery(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Оценка совпадения: чем выше, тем лучше команда подходит запросу.
 * Точное совпадение важнее начала, начало — важнее вхождения в середину; название важнее подписи.
 * Всё сравнивается в одной нормализованной форме, поэтому «ё» и «е» не мешают.
 */
export function scoreCommand(command, query) {
  const q = normalizeQuery(query);
  if (!q) return 1;
  const title = normalizeQuery(command.title).replace(/^[^\p{L}\p{N}]+/u, '');   // без значка в начале
  const sub = normalizeQuery(command.subtitle || '');
  const keys = (command.keywords || []).map(normalizeQuery);

  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (keys.some(k => k === q)) return 70;
  if (keys.some(k => k.startsWith(q))) return 60;
  if (title.includes(q)) return 50;
  if (sub.includes(q)) return 30;
  if (keys.some(k => k.includes(q))) return 25;
  return 0;
}

/**
 * Отбирает команды по запросу: сначала лучшие по оценке, при равенстве — по алфавиту.
 * Пустой запрос возвращает всё в исходном порядке (важные команды уже стоят первыми).
 */
export function filterCommands(commands, query, limit = 40) {
  const q = normalizeQuery(query);
  const list = commands || [];
  if (!q) return list.slice(0, limit);
  return list
    .map(c => ({ command: c, score: scoreCommand(c, q) }))
    .filter(x => x.score > 0)
    // Более высокий балл — выше; при равном балле выигрывает более короткое название:
    // «Новая пати» точнее подходит запросу «пати», чем «Запустить пати и ждать»
    .sort((a, b) => b.score - a.score || a.command.title.length - b.command.title.length
      || a.command.title.localeCompare(b.command.title, 'ru'))
    .slice(0, limit)
    .map(x => x.command);
}

/** Команда-разделитель в списке палитры: по ней нельзя кликнуть. */
export const isHeading = (command) => command?.kind === 'heading';

/**
 * Собирает команды из текущего состояния приложения.
 *
 * Персонажи дают самый большой выигрыш: вместо поиска карточки в списке можно набрать часть ника
 * и сразу открыть профиль, проверить вход или запустить игру.
 *
 * @param {any} state состояние приложения
 * @param {{ switchTab: (tab: string) => void, run?: (action: string, payload?: any) => void }} deps
 */
export function buildCommands(state, deps = {}) {
  /** @type {Array<{id: string, title: string, subtitle?: string, group: string, keywords?: string[], run: () => void, kind?: string}>} */
  const out = [];
  const push = (c) => out.push(c);

  // --- Разделы ---
  for (const [tab, title, icon] of [
    ['today', 'Сегодня', '⌂'],
    ['characters', 'Персонажи', '👥'],
    ['parties', 'Пати', '🛡'],
    ['marathons', 'Марафоны', '🏃'],
    ['settings', 'Настройки', '⚙']
  ]) {
    push({ id: `tab-${tab}`, title: `${icon} ${title}`, group: 'Разделы', keywords: [tab, 'раздел', 'вкладка'], run: () => deps.switchTab?.(tab) });
  }

  // --- Действия ---
  push({ id: 'act-new-char', title: '➕ Новый персонаж', group: 'Действия', keywords: ['создать', 'добавить', 'аккаунт'], run: () => deps.run?.('new-character') });
  push({ id: 'act-new-party', title: '➕ Новая пати', group: 'Действия', keywords: ['создать', 'добавить', 'группа'], run: () => deps.run?.('new-party') });
  push({ id: 'act-new-marathon', title: '➕ Новый марафон', group: 'Действия', keywords: ['создать', 'событие'], run: () => deps.run?.('new-marathon') });
  push({ id: 'act-auth', title: '🔐 Проверить авторизацию', group: 'Действия', keywords: ['вход', 'логин', 'сессия', 'проверка'], run: () => deps.run?.('check-auth') });
  push({ id: 'act-balance', title: '💰 Обновить балансы', group: 'Действия', keywords: ['монеты', 'деньги', 'обновить'], run: () => deps.run?.('update-balance') });
  push({ id: 'act-marathon-sync', title: '🏆 Обновить марафоны', group: 'Действия', keywords: ['прогресс', 'сверка', 'сверка с сайтом'], run: () => deps.run?.('update-marathons') });
  push({ id: 'act-promo', title: '🎁 Активировать промокод', group: 'Действия', keywords: ['код', 'бонус'], run: () => deps.run?.('promo') });
  push({ id: 'act-transfer', title: '📦 Передать предметы в игру', group: 'Действия', keywords: ['подарок', 'перевод'], run: () => deps.run?.('transfer') });
  push({ id: 'act-shop', title: '🪙 Активация подарков (покупка за Древние монеты)', group: 'Действия', keywords: ['активация', 'магазин', 'подарки', 'подарок', 'камень', 'знак', 'сундук', 'купить'], run: () => deps.run?.('shop') });
  push({ id: 'act-windows', title: '🎮 Запущенные окна игры', group: 'Действия', keywords: ['закрыть', 'клиенты', 'процессы'], run: () => deps.run?.('windows') });
  push({ id: 'act-close-game', title: '🛑 Закрыть все окна игры', group: 'Действия', keywords: ['закрыть', 'клиенты'], run: () => deps.run?.('close-game') });
  push({ id: 'act-save', title: '💾 Сохранить сейчас', group: 'Действия', keywords: ['запись', 'диск'], run: () => deps.run?.('save') });
  push({ id: 'act-backup', title: '☁️ Создать резервную копию', group: 'Действия', keywords: ['бэкап', 'копия', 'снимок'], run: () => deps.run?.('backup') });
  push({ id: 'act-export', title: '📤 Экспорт всех данных', group: 'Действия', keywords: ['выгрузка', 'json', 'сохранить в файл'], run: () => deps.run?.('export') });
  push({ id: 'act-import', title: '📥 Импорт данных', group: 'Действия', keywords: ['загрузка', 'json', 'восстановить'], run: () => deps.run?.('import') });
  push({ id: 'act-update', title: '⬆️ Проверить обновления', group: 'Действия', keywords: ['версия', 'новая версия'], run: () => deps.run?.('check-updates') });

  // --- Персонажи ---
  const characters = state?.characters || [];
  if (characters.length) {
    push({ id: 'head-chars', title: 'Персонажи', group: 'Персонажи', kind: 'heading', run: () => {} });
    for (const c of characters) {
      const where = c.class ? `${c.class}${c.level ? `, ур. ${c.level}` : ''}` : 'класс не указан';
      push({
        id: `char-${c.id}`,
        title: `👤 ${c.nick}`,
        subtitle: where,
        group: 'Персонажи',
        keywords: [c.class, c.id, ...(c.tags || [])],
        run: () => deps.run?.('open-character', c.id)
      });
      push({
        id: `char-check-${c.id}`,
        title: `🔐 Проверить вход: ${c.nick}`,
        group: 'Команды персонажа',
        subtitle: where,
        keywords: ['логин', 'сессия'],
        run: () => deps.run?.('check-auth-one', c.id)
      });
      push({
        id: `char-launch-${c.id}`,
        title: `▶ Запустить игру: ${c.nick}`,
        group: 'Команды персонажа',
        subtitle: where,
        keywords: ['клиент', 'играть', 'запуск'],
        run: () => deps.run?.('launch-one', c.id)
      });
      push({
        id: `char-balance-${c.id}`,
        title: `💰 Обновить баланс: ${c.nick}`,
        group: 'Команды персонажа',
        subtitle: where,
        keywords: ['монеты'],
        run: () => deps.run?.('balance-one', c.id)
      });
    }
  }

  // --- Пати ---
  const parties = state?.parties || [];
  if (parties.length) {
    push({ id: 'head-parties', title: 'Пати', group: 'Пати', kind: 'heading', run: () => {} });
    for (const p of parties) {
      push({
        id: `party-${p.id}`,
        title: `🛡 ${p.name}`,
        group: 'Пати',
        keywords: ['группа', 'пати'],
        run: () => deps.run?.('open-party', p.id)
      });
      push({
        id: `party-launch-${p.id}`,
        title: `▶ Запустить пати: ${p.name}`,
        group: 'Пати',
        keywords: ['играть', 'запуск', 'группа'],
        run: () => deps.run?.('launch-party', p.name)
      });
      push({
        id: `party-close-${p.id}`,
        title: `🛑 Закрыть окна пати: ${p.name}`,
        group: 'Пати',
        keywords: ['закрыть', 'группа'],
        run: () => deps.run?.('close-party', p.name)
      });
    }
  }

  // --- Марафоны ---
  const marathons = (state?.marathons || []).filter(m => m.kind !== 'series');
  if (marathons.length) {
    push({ id: 'head-marathons', title: 'Марафоны', group: 'Марафоны', kind: 'heading', run: () => {} });
    for (const m of marathons) {
      push({
        id: `marathon-${m.id}`,
        title: `${m.kind === 'series' ? '📁' : '🏃'} ${m.title}`,
        group: 'Марафоны',
        subtitle: m.status === 'completed' ? 'завершён' : 'идёт',
        keywords: ['событие', 'задания'],
        run: () => deps.run?.('open-marathon', m.id)
      });
    }
    for (const m of (state?.marathons || []).filter(x => x.kind === 'series')) {
      push({
        id: `folder-${m.id}`,
        title: `📁 ${m.title}`,
        group: 'Марафоны',
        subtitle: 'папка',
        keywords: ['папка', 'серия'],
        run: () => deps.run?.('open-marathon', m.id)
      });
    }
  }

  return out;
}
