// @ts-check
// js/data/characterFields.js
// Полный список полей персонажа для экспорта/импорта и сравнения карточек.
// Добавили поле в модель (modules/characters/stateManager.js) — добавьте его и сюда,
// тогда оно появится в окне сравнения при импорте.

// Название пати по id для окна сравнения (import.js подставляет локальные и новые пати)
let resolvePartyName = (id) => id;
export function setPartyNameResolver(fn) { resolvePartyName = typeof fn === 'function' ? fn : (id) => id; }

const isListType = (f) => f.type === 'list' || f.type === 'parties';

const stat = (key, label) => ({ path: `stats.${key}`, label, type: 'number' });

export const FIELD_GROUPS = [
  { id: 'main', title: 'Основное', fields: [
    { path: 'nick', label: 'Ник' },
    { path: 'class', label: 'Класс' },
    { path: 'level', label: 'Уровень', type: 'number' },
    { path: 'mainPartyId', label: 'Основная пати', type: 'party' },
    { path: 'partyIds', label: 'Все пати', type: 'parties', mergeable: true },
    { path: 'sky.name', label: 'Небо' },
    { path: 'sky.level', label: 'Уровень неба', type: 'number' },
    { path: 'tags', label: 'Теги', type: 'list', mergeable: true },
    { path: 'notes', label: 'Примечания' }
  ] },
  { id: 'contacts', title: 'Контакты', fields: [
    { path: 'contacts.email', label: 'Email / Логин' },
    { path: 'contacts.password', label: 'Пароль', secret: true },
    { path: 'contacts.recoveryEmail', label: 'Recovery Email' },
    { path: 'contacts.phone', label: 'Телефон' }
  ] },
  { id: 'passes', title: 'Проходки в данжи', fields: [
    { path: 'dungeonPasses.weapon', label: 'Оружие', type: 'number' },
    { path: 'dungeonPasses.armor', label: 'Броня', type: 'number' },
    { path: 'dungeonPasses.relic', label: 'Реликвии', type: 'number' }
  ] },
  { id: 'coins', title: 'Древние монеты', fields: [
    { path: 'ancientCoins', label: 'Баланс', type: 'number' },
    { path: 'lastCoinUpdate', label: 'Обновлено', type: 'date' },
    { path: 'coinHistory', label: 'История Древних монет', type: 'history', mergeable: true }
  ] },
  { id: 'statsMain', title: 'Основные характеристики', fields: [
    stat('endurance', 'Выносливость'), stat('intelligence', 'Интеллект'),
    stat('strength', 'Сила'), stat('agility', 'Ловкость'),
    stat('hp', 'Здоровье (текущее)'), stat('hpMax', 'Здоровье (макс)'),
    stat('mp', 'Маг. энергия (текущее)'), stat('mpMax', 'Маг. энергия (макс)')
  ] },
  { id: 'statsCombat', title: 'Бой и защита', fields: [
    stat('physAttack', 'Физ. атака'), stat('physDefense', 'Физ. защита'),
    stat('magAttack', 'Маг. атака'), stat('magDefense', 'Маг. защита'),
    stat('critChance', 'Шанс крит. удара (%)'), stat('critDamage', 'Крит. урон (%)'),
    stat('atkSpeed', 'Скорость атаки'), stat('evasion', 'Уклонение'), stat('accuracy', 'Меткость')
  ] },
  { id: 'statsBattle', title: 'Показатели боя', fields: [
    stat('pa', 'Показатель атаки (ПА)'), stat('pz', 'Показатель защиты (ПЗ)'),
    stat('morale', 'Боевой дух'), stat('power', 'Сила (показатель боя)'),
    stat('stealth', 'Скрытность'), stat('detection', 'Обнаружение')
  ] },
  { id: 'statsPve', title: 'PvE и пробивание', fields: [
    stat('pvePa', 'Урон по монстрам (PvE PA)'), stat('pvePz', 'Защита от монстров (PvE PZ)'),
    stat('physPenetration', 'Физ. пробивание'), stat('magPenetration', 'Маг. пробивание')
  ] },
  { id: 'sync', title: 'Данные с сайта', fields: [
    { path: 'marathonData', label: 'Прогресс марафонов (с сайта)', type: 'json' }
  ] }
];

export const ALL_FIELDS = FIELD_GROUPS.flatMap(g => g.fields.map(f => ({ ...f, group: g.id })));

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach(k => { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
}

/** Нормализованное значение для сравнения («пусто» = '', null, 0 у чисел не путаем). */
function comparable(field, v) {
  if (v === undefined || v === null || v === '') return '';
  if (isListType(field)) return JSON.stringify([...(v || [])].map(x => String(x).toLowerCase()).sort());
  if (field.type === 'history') return JSON.stringify((v || []).map(h => h.id || `${h.date}|${h.delta}`).sort());
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function sameValue(field, a, b) {
  return comparable(field, a) === comparable(field, b);
}

/**
 * Поля, в которых два персонажа отличаются.
 * present — пути, которые реально есть в файле (поля, не попавшие в экспорт, не сравниваются).
 */
export function diffCharacters(local, incoming, present = null) {
  return ALL_FIELDS.filter(f => (!present || present.has(f.path)) &&
    !sameValue(f, getPath(local, f.path), getPath(incoming, f.path)));
}

/** Какие поля есть в «сыром» персонаже из файла (до нормализации). */
export function presentPaths(rawChar) {
  const present = new Set(ALL_FIELDS.filter(f => getPath(rawChar, f.path) !== undefined).map(f => f.path));
  // Файлы старого формата хранили пати названием в поле `party`
  if (rawChar && rawChar.party !== undefined) { present.add('partyIds'); present.add('mainPartyId'); }
  return present;
}

/** Объединение для полей-списков: теги без дублей, история монет без повторов, новые сверху. */
export function mergeValues(field, a, b) {
  if (isListType(field)) {
    const seen = new Set();
    return [...(a || []), ...(b || [])].filter(t => { const k = String(t).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (field.type === 'history') {
    const map = new Map();
    [...(a || []), ...(b || [])].forEach(h => map.set(h.id || `${h.date}|${h.delta}|${h.note}`, h));
    return [...map.values()].sort((x, y) => String(y.date).localeCompare(String(x.date)));
  }
  return b;
}

/**
 * Собирает итоговую карточку: picks = { path: 'local' | 'incoming' | 'merge' }.
 * Поля без выбора берутся из текущей карточки; id остаётся текущим.
 */
export function buildMerged(local, incoming, picks = {}) {
  const out = JSON.parse(JSON.stringify(local));
  ALL_FIELDS.forEach(f => {
    const pick = picks[f.path] || 'local';
    const a = getPath(local, f.path);
    const b = getPath(incoming, f.path);
    const value = pick === 'incoming' ? b : pick === 'merge' && f.mergeable ? mergeValues(f, a, b) : a;
    setPath(out, f.path, value === undefined ? null : JSON.parse(JSON.stringify(value ?? null)));
  });
  out.id = local.id;
  out.updatedAt = new Date().toISOString();
  return out;
}

/** Человекочитаемое значение для таблицы сравнения. */
export function displayValue(field, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (field.type === 'list') return v.join(', ');
  if (field.type === 'party') return resolvePartyName(v) || '?';
  if (field.type === 'parties') return v.map(id => resolvePartyName(id) || '?').join(', ');
  if (field.type === 'history') return `${v.length} операц.${v[0] ? ` · последняя ${String(v[0].date || '').slice(0, 10)}: ${v[0].delta > 0 ? '+' : ''}${v[0].delta ?? ''}` : ''}`;
  if (field.type === 'date') return new Date(v).toLocaleString('ru-RU');
  if (field.type === 'json') {
    const keys = Object.keys(v || {});
    return keys.length ? `${keys.length} зап.` : '—';
  }
  if (typeof v === 'number') return v.toLocaleString('ru-RU');
  return String(v);
}
