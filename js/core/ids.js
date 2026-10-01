// js/core/ids.js
// Читаемые id персонажей, построенные из ника: «Тёмный_Маг#2» → «Temnyy_Mag_2».
// id используется в именах окон браузера (sync-win-<id>), папках профилей
// (pw-sync-profiles/<id>), ключах хранилища ОС и логах, поэтому в нём только
// латиница, цифры, «_» и «-» (ограничение меток окон Tauri и имён папок Windows).

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g'
};

// Зарезервированные имена устройств Windows: такую папку создать нельзя.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_LENGTH = 40;

/** Транслитерация + замена всего лишнего на «_». */
export function slugifyNick(nick) {
  const latin = [...String(nick || '').normalize('NFC')].map(ch => {
    const lower = ch.toLowerCase();
    if (!(lower in TRANSLIT)) return ch;
    const t = TRANSLIT[lower];
    return ch !== lower && t ? t[0].toUpperCase() + t.slice(1) : t;
  }).join('');
  let slug = latin
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // é → e
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/[_-]+$/g, '');
  if (!slug) slug = 'char';
  if (RESERVED.test(slug)) slug += '_';
  return slug;
}

/**
 * Уникальный id для ника. `taken` — занятые id (Set или массив);
 * собственный id персонажа (`selfId`) занятым не считается.
 * Совпадения регистра тоже считаются занятыми (папки Windows регистронезависимы).
 */
export function characterIdFor(nick, taken = [], selfId = null) {
  const used = new Set([...taken].filter(id => id && id !== selfId).map(id => String(id).toLowerCase()));
  const base = slugifyNick(nick);
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Новые id для списка персонажей по порядку. Возвращает Map(oldId → newId) только для изменившихся. */
export function planCharacterIds(characters) {
  const taken = [];
  const remap = new Map();
  characters.forEach(c => {
    const id = characterIdFor(c.nick, taken);
    taken.push(id);
    if (c.id !== id) remap.set(c.id, id);
  });
  return remap;
}

/**
 * Глубокая замена id: значения-строки и ключи объектов, совпадающие со старым id.
 * Старые id — UUID, поэтому случайных совпадений с другими данными нет.
 */
export function remapIdsDeep(value, remap) {
  if (!remap || remap.size === 0) return value;
  if (typeof value === 'string') return remap.has(value) ? remap.get(value) : value;
  if (Array.isArray(value)) return value.map(v => remapIdsDeep(v, remap));
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => { out[remap.has(k) ? remap.get(k) : k] = remapIdsDeep(v, remap); });
    return out;
  }
  return value;
}
