// @ts-check
// js/modules/externalApi/actions/read.js
// Чтение данных для внешнего API: ответы собираются здесь и только здесь.
//
// Правило безопасности: в ответ попадает белый список полей. Контакты, пароли,
// токены GameCenter, куки, `launch.*` и облачные ключи не попадают в ответ никогда —
// даже если их случайно добавят в объект персонажа позже.
//
// Функции не читают DOM и не зовут Tauri сами: всё, что нужно, приходит аргументами
// (state, список окон). Поэтому их можно проверить тестами без приложения.

/** Поля персонажа, которые видит внешняя программа. */
const CHARACTER_FIELDS = [
  'id',
  'nick',
  'class',
  'level',
  'favorite',
  'sky',
  'partyIds',
  'mainPartyId',
  'stats',
  'dungeonPasses',
  'ancientCoins',
  'isLoggedIn',
  'lastLoginCheck',
  'updatedAt',
  'notes',
  'tags',
  'coinHistory',
  'createdAt'
];

/** Звёздное небо: только имя и уровень. */
function publicSky(sky) {
  if (!sky || typeof sky !== 'object') return { name: null, level: null };
  return {
    name: sky.name ?? null,
    level: Number.isFinite(Number(sky.level)) ? Number(sky.level) : null
  };
}

/** Статы и проходки: числа, ничего лишнего. */
function publicStats(stats) {
  if (!stats || typeof stats !== 'object') return {};
  return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value) || 0]));
}

function publicPasses(passes) {
  if (!passes || typeof passes !== 'object') return {};
  return Object.fromEntries(Object.entries(passes).map(([key, value]) => [key, Number(value) || 0]));
}

/**
 * Окно игры для строки персонажа. `rows` — результат `windowRows` (по pid и charId),
 * `byCharId` — заранее собранная карта, чтобы не искать в списке на каждого персонажа.
 */
function runningOf(charId, byCharId) {
  const row = byCharId.get(String(charId));
  if (!row) return null;
  return { pid: row.pid, title: row.title || '' };
}

/** История Древних монет: дата и число, без внутренних полей парсера. */
function coinHistoryOf(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(entry => entry && typeof entry === 'object')
    .slice(0, 20)
    .map(entry => ({
      at: entry.at ?? null,
      coins: Number(entry.coins) || 0
    }));
}

/** Карта `charId → строка окна` по списку строк `windowRows`. */
export function runningByCharId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row && row.known && row.charId) map.set(String(row.charId), row);
  }
  return map;
}

/**
 * Один персонаж для ответа API.
 * @param {any} char персонаж из state
 * @param {{ running?: Map<string, any> | null }} [options] окна игры (Map по charId)
 */
export function publicCharacter(char, { running = null } = {}) {
  if (!char || typeof char.id !== 'string') return null;
  const out = {};
  for (const field of CHARACTER_FIELDS) {
    if (field === 'sky') out.sky = publicSky(char.sky);
    else if (field === 'stats') out.stats = publicStats(char.stats);
    else if (field === 'dungeonPasses') out.dungeonPasses = publicPasses(char.dungeonPasses);
    else if (field === 'partyIds') out.partyIds = Array.isArray(char.partyIds) ? [...char.partyIds] : [];
    else if (field === 'favorite') out.favorite = char.favorite === true;
    else if (field === 'isLoggedIn') out.isLoggedIn = char.isLoggedIn === true;
    else if (field === 'level') out.level = Number(char.level) || 0;
    else if (field === 'ancientCoins') out.ancientCoins = Number(char.ancientCoins) || 0;
    else if (field === 'mainPartyId') out.mainPartyId = char.mainPartyId ?? null;
    else if (field === 'notes') out.notes = String(char.notes || '');
    else if (field === 'tags') out.tags = Array.isArray(char.tags) ? char.tags.map(String) : [];
    else if (field === 'coinHistory') out.coinHistory = coinHistoryOf(char.coinHistory);
    else out[field] = char[field] ?? null;
  }
  out.running = running ? runningOf(char.id, running) : null;
  return out;
}

/**
 * Параметры списка персонажей: `party` (id или название) и `fields`.
 * @param {{ parties?: any[] }} state
 * @param {string} query строка запроса после `?` (уже без `?`)
 */
export function characterFilter(state, query) {
  const params = new URLSearchParams(query || '');
  const party = String(params.get('party') || '').trim();
  const fields = String(params.get('fields') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return { party, fields };
}

/**
 * Список персонажей для ответа API с фильтром по пати и выбором полей.
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {string} query
 * @param {{ running?: Map<string, any> | null }} [options]
 */
export function publicCharacters(state, query = '', options = {}) {
  const { party, fields } = characterFilter(state, query);
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  let list = characters;
  if (party) {
    // Пати ищется по id или названию (без регистра), как в меню трея.
    const parties = Array.isArray(state?.parties) ? state.parties : [];
    const found = parties.find(
      p =>
        String(p?.id) === party ||
        String(p?.name || '')
          .trim()
          .toLowerCase() === party.trim().toLowerCase()
    );
    const partyId = found ? String(found.id) : party;
    list = characters.filter(c => Array.isArray(c.partyIds) && c.partyIds.map(String).includes(partyId));
  }
  const running = options.running || null;
  const rows = list.map(char => publicCharacter(char, { running })).filter(Boolean);
  const picked = fields.length
    ? rows.map(row => {
        const out = { id: row.id };
        for (const field of fields) if (field in row) out[field] = row[field];
        return out;
      })
    : rows;
  return { characters: picked };
}

/**
 * Пати с участниками в порядке запуска (перетаскивание в карточке пати).
 * @param {{ characters?: any[], parties?: any[] }} state
 * @param {(chars: any[], partyId: string) => any[]} ordered участники в порядке пати
 */
export function publicParties(state, ordered) {
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const parties = Array.isArray(state?.parties) ? state.parties : [];
  return {
    parties: parties.map(party => {
      const members = ordered
        ? ordered(characters, String(party.id))
        : characters.filter(c => (c.partyIds || []).includes(party.id));
      return {
        id: party.id,
        name: party.name || '',
        color: party.color ?? null,
        members: members.map((member, index) => ({
          id: member.id,
          nick: member.nick || '',
          order: index + 1
        }))
      };
    })
  };
}

/**
 * Запущенные окна игры в том же виде, что `GET /windows`.
 * @param {any[]} rows строки `windowRows` (pid, title, known, charId, nick, elevated…)
 * @param {string} updatedAt ISO-время чтения списка
 */
export function publicWindows(rows, updatedAt = new Date().toISOString()) {
  const windows = (rows || []).map(row => ({
    pid: Number(row.pid) || 0,
    title: String(row.title || ''),
    charId: row.known && row.charId ? String(row.charId) : null,
    nick: row.known && row.charId ? String(row.nick || '') : null,
    class: row.known && row.charId ? String(row.cls || '') : null,
    elevated: row.elevated ?? null,
    startedAt: row.startedAt ?? null,
    ownershipSource: row.ownershipSource ?? 'unknown'
  }));
  return { updatedAt, windows };
}

/* ------------------------------------------------------------------ */
/*  Марафоны                                                          */
/* ------------------------------------------------------------------ */

/** Одно задание марафона: то, что нужно, чтобы показать прогресс и награды. */
function publicTask(task) {
  return {
    id: String(task.id),
    title: String(task.title || ''),
    siteTitle: task.siteTitle ?? null,
    description: String(task.description || ''),
    targetChecks: Number(task.targetChecks) || 0,
    schedule: {
      mode: task.schedule?.mode || 'everyDay',
      dates: Array.isArray(task.schedule?.dates) ? task.schedule.dates.map(String) : [],
      weekStartDay: Number(task.schedule?.weekStartDay ?? 1)
    },
    rewards: (task.rewards || []).map(reward => ({
      threshold: Number(reward.threshold) || 0,
      rewardText: String(reward.rewardText || ''),
      rewardCoins: Number(reward.rewardCoins) || 0
    }))
  };
}

/**
 * Прогресс одного персонажа по одному заданию: `progress[charId][taskId]` в state.
 * Ручные отметки и поправку берём как есть — их видит и интерфейс.
 */
function publicCellProgress(cell) {
  if (!cell || typeof cell !== 'object') return { marks: [], adjust: 0, site: null };
  return {
    marks: Array.isArray(cell.marks) ? cell.marks.map(String) : [],
    adjust: Number(cell.adjust) || 0,
    site: cell.site === null || cell.site === undefined ? null : Number(cell.site) || 0
  };
}

/**
 * Марафон в ответе API. `totals` считает `marathonTotals` из модели: если он не
 * передан, вместо цифр будет `null` — лучше пусто, чем вторая правда о прогрессе.
 */
export function publicMarathon(marathon, totals = null) {
  const progress = {};
  for (const [charId, tasks] of Object.entries(marathon.progress || {})) {
    progress[charId] = {};
    for (const [taskId, cell] of Object.entries(tasks || {})) {
      progress[charId][taskId] = publicCellProgress(cell);
    }
  }
  return {
    id: String(marathon.id),
    kind: marathon.kind === 'series' ? 'series' : 'single',
    seriesId: marathon.seriesId ?? null,
    title: String(marathon.title || ''),
    description: String(marathon.description || ''),
    startDate: marathon.startDate ?? null,
    endDate: marathon.endDate ?? null,
    status: marathon.status === 'completed' ? 'completed' : 'active',
    source: {
      type: marathon.source?.type || 'manual',
      url: marathon.source?.url ?? null,
      siteName: marathon.source?.siteName ?? null
    },
    participantIds: Array.isArray(marathon.participantIds) ? marathon.participantIds.map(String) : [],
    assignments: marathon.assignments ? JSON.parse(JSON.stringify(marathon.assignments)) : {},
    tasks: (marathon.tasks || []).map(publicTask),
    bonuses: (marathon.bonuses || []).map(bonus => ({
      needTasks: Number(bonus.needTasks) || 0,
      text: String(bonus.text || '')
    })),
    awards: (marathon.awards || []).map(award => ({
      characterId: award.characterId ?? null,
      charNick: String(award.charNick || ''),
      taskId: award.taskId ?? null,
      taskTitle: String(award.taskTitle || ''),
      rewardText: String(award.rewardText || ''),
      coins: Number(award.coins) || 0
    })),
    progress,
    totals,
    createdAt: marathon.createdAt ?? null,
    updatedAt: marathon.updatedAt ?? null,
    completedAt: marathon.completedAt ?? null
  };
}

/**
 * Итоги марафона: `null`, если функция не передана или упала на битых данных.
 * Один битый марафон не должен ронять список из пятидесяти.
 */
function safeTotals(totalsOf, marathon) {
  if (typeof totalsOf !== 'function') return null;
  try {
    return totalsOf(marathon);
  } catch {
    return null;
  }
}

/**
 * Список марафонов. `totalsOf(marathon)` — обычно `marathonTotals` из
 * `modules/marathons/model.js`: API не считает прогресс сам.
 * Папки-серии (`kind: 'series'`) отдаются без заданий: у них свой набор `childIds`.
 */
export function publicMarathons(state, totalsOf = null) {
  const marathons = Array.isArray(state?.marathons) ? state.marathons : [];
  return {
    marathons: marathons.map(marathon => {
      if (marathon.kind === 'series') {
        return {
          id: String(marathon.id),
          kind: 'series',
          title: String(marathon.title || ''),
          description: String(marathon.description || ''),
          childIds: Array.isArray(marathon.childIds) ? marathon.childIds.map(String) : [],
          createdAt: marathon.createdAt ?? null,
          updatedAt: marathon.updatedAt ?? null
        };
      }
      return publicMarathon(marathon, safeTotals(totalsOf, marathon));
    })
  };
}

/** Марафон по id: `{ marathon }` или `null`, если такого нет. */
export function publicMarathonById(state, id, totalsOf = null) {
  const all = Array.isArray(state?.marathons) ? state.marathons : [];
  const marathon = all.find(item => String(item.id) === String(id));
  if (!marathon) return null;
  if (marathon.kind === 'series') {
    return {
      id: String(marathon.id),
      kind: 'series',
      title: String(marathon.title || ''),
      description: String(marathon.description || ''),
      childIds: Array.isArray(marathon.childIds) ? marathon.childIds.map(String) : [],
      createdAt: marathon.createdAt ?? null,
      updatedAt: marathon.updatedAt ?? null
    };
  }
  return publicMarathon(marathon, safeTotals(totalsOf, marathon));
}

/** Пати и персонажи, участвующие в марафоне — удобно для отчётов. */
export function marathonParticipants(state, marathonId) {
  const marathon = (state?.marathons || []).find(item => String(item.id) === String(marathonId));
  if (!marathon) return null;
  const ids = new Set((marathon.participantIds || []).map(String));
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const parties = Array.isArray(state?.parties) ? state.parties : [];
  const members = characters.filter(char => ids.has(String(char.id)));
  const partyIds = new Set();
  for (const char of members) for (const partyId of char.partyIds || []) partyIds.add(String(partyId));
  return {
    marathonId: String(marathon.id),
    characters: members.map(char => ({ id: String(char.id), nick: String(char.nick || '') })),
    parties: parties
      .filter(party => partyIds.has(String(party.id)))
      .map(party => ({ id: String(party.id), name: String(party.name || '') }))
  };
}

/* ------------------------------------------------------------------ */
/*  Планировщик и учёт                                                */
/* ------------------------------------------------------------------ */

/** Запись планировщика: только то, что видно в календаре. */
export function publicPlanner(state) {
  const entries = Array.isArray(state?.plannerEntries) ? state.plannerEntries : [];
  return {
    entries: entries.map(entry => ({
      id: String(entry.id),
      title: String(entry.title || ''),
      date: entry.date ?? null,
      time: entry.time ?? '',
      durationMinutes: Number(entry.durationMinutes) || 0,
      kind: entry.kind ?? 'task',
      priority: entry.priority ?? 'normal',
      recurrence: entry.recurrence ?? 'none',
      status: entry.status ?? null,
      notes: String(entry.notes || '')
    }))
  };
}

/**
 * Учёт (раздел «Учёт»): движения денег, позиции магазина, долги и настройки.
 * Контакты и персонажи сюда не попадают — это отдельные сущности.
 */
export function publicFinance(state) {
  const finance = state?.finance || {};
  return {
    operations: (finance.operations || []).map(operation => ({
      id: String(operation.id),
      date: operation.date ?? null,
      currency: operation.currency ?? null,
      kind: operation.kind === 'in' ? 'in' : 'out',
      amount: Number(operation.amount) || 0,
      counterparty: String(operation.counterparty || ''),
      note: String(operation.note || ''),
      characterId: operation.characterId ?? null
    })),
    shopItems: (finance.shopItems || []).map(item => ({
      id: String(item.id),
      title: String(item.title || ''),
      quantity: Number(item.quantity) || 0,
      price: Number(item.price) || 0,
      currency: item.currency ?? null,
      status: item.status ?? null
    })),
    loans: (finance.loans || []).map(loan => ({
      id: String(loan.id),
      title: String(loan.title || ''),
      amount: Number(loan.amount) || 0,
      currency: loan.currency ?? null,
      direction: loan.direction ?? null,
      dueDate: loan.dueDate ?? null,
      closed: loan.closed === true
    })),
    settings: {
      goldRate: Number(finance.settings?.goldRate) || 0,
      commissionPct: Number(finance.settings?.commissionPct) || 0,
      goldRateAt: finance.settings?.goldRateAt ?? null,
      opening:
        finance.settings?.opening && typeof finance.settings.opening === 'object'
          ? Object.fromEntries(
              Object.entries(finance.settings.opening).map(([key, value]) => [key, Number(value) || 0])
            )
          : {}
    }
  };
}
