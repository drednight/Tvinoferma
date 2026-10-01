// js/migrations.js
// Единая версия схемы для всего state.json (`schemaVersion`).
// Каждая миграция — чистая функция `state(vN-1) -> state(vN)`; применяются по порядку.
// Марафоны дополнительно проходят собственную миграцию (marathons/model.js → migrateMarathon).
//
// Как добавить миграцию: увеличьте SCHEMA_VERSION и допишите функцию в MIGRATIONS[новая версия].

export const SCHEMA_VERSION = 3;

const clone = (v) => JSON.parse(JSON.stringify(v));

export const MIGRATIONS = {
  // v1 → v2: исторический формат (поле `version`), партии без порядка
  2: (s) => {
    s.parties = (Array.isArray(s.parties) ? s.parties : []).map((p, i) =>
      typeof p === 'string' ? { name: p, order: i + 1 } : { ...p, order: Number(p?.order) || i + 1 });
    s.characters = Array.isArray(s.characters) ? s.characters : [];
    s.marathons = Array.isArray(s.marathons) ? s.marathons : [];
    return s;
  },

  // v2 → v3: теги персонажей, служебные поля экспорта убраны, контакты могут жить в keychain ОС
  3: (s) => {
    s.characters = s.characters.map(c => ({
      ...c,
      tags: Array.isArray(c.tags) ? c.tags : [],
      contacts: c.contacts ?? null
    }));
    s.marathonTemplates = Array.isArray(s.marathonTemplates) ? s.marathonTemplates : [];
    delete s.app; delete s.exportedAt; delete s.scope;
    return s;
  }
};

/** Версия схемы входных данных (старые файлы хранили её в поле `version`). */
export function detectVersion(raw) {
  const v = Number(raw?.schemaVersion ?? raw?.version);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
}

/**
 * @returns {{ state: object, from: number, to: number, applied: number[], newer: boolean }}
 *   newer = файл создан более новой версией приложения (данные не трогаем).
 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { state: { schemaVersion: SCHEMA_VERSION }, from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [], newer: false };
  }
  const from = detectVersion(raw);
  if (from > SCHEMA_VERSION) {
    return { state: raw, from, to: from, applied: [], newer: true };
  }
  let s = clone(raw);
  const applied = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) { s = step(s) || s; applied.push(v); }
  }
  s.schemaVersion = SCHEMA_VERSION;
  delete s.version;
  return { state: s, from, to: SCHEMA_VERSION, applied, newer: false };
}
