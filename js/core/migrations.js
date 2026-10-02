// js/core/migrations.js
// Единая версия схемы для всего state.json (`schemaVersion`).
// Каждая миграция — чистая функция `state(vN-1) -> state(vN)`; применяются по порядку.
// Марафоны дополнительно проходят собственную миграцию (marathons/model.js → migrateMarathon).
//
// Как добавить миграцию: увеличьте SCHEMA_VERSION и допишите функцию в MIGRATIONS[новая версия].

import { planCharacterIds, remapIdsDeep } from './ids.js';

export const SCHEMA_VERSION = 5;

const clone = (v) => JSON.parse(JSON.stringify(v));

const newPartyId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

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
  },

  // v3 → v4: id персонажей строятся из ника (DragonSlayer#1 → DragonSlayer_1).
  // Ссылки в марафонах и шаблонах переименовываются; карта old → new возвращается
  // в migrateState().idRemap, чтобы перенести профили браузера и ключи хранилища ОС.
  4: (s) => {
    const remap = planCharacterIds(s.characters);
    if (remap.size) {
      s.characters = s.characters.map(c => ({ ...c, id: remap.get(c.id) || c.id }));
      s.marathons = remapIdsDeep(s.marathons, remap);
      s.marathonTemplates = remapIdsDeep(s.marathonTemplates || [], remap);
      s.__idRemap = Object.fromEntries(remap);
    }
    return s;
  },

  // v4 → v5: несколько партий у персонажа и примечания (issues #4 и #20).
  // character.party (название) → character.partyIds (id партий) + mainPartyId (основная); у каждой партии гарантирован id.
  // Название, которое есть у персонажа, но нет в списке партий, превращается в новую партию
  // (раньше такие «неявные» партии рисовались из персонажей и теряли порядок).
  5: (s) => {
    const parties = (Array.isArray(s.parties) ? s.parties : [])
      .map(p => (typeof p === 'string' ? { name: p } : { ...p }))
      .map(p => ({ ...p, id: p.id || newPartyId() }));
    const key = (name) => String(name || '').trim().toLowerCase();
    const byName = new Map(parties.map(p => [key(p.name), p]));
    let nextOrder = Math.max(0, ...parties.map(p => Number(p.order) || 0)) + 1;
    const now = new Date().toISOString();

    s.characters = (Array.isArray(s.characters) ? s.characters : []).map(c => {
      const { party, ...rest } = c;
      const ids = Array.isArray(c.partyIds) ? c.partyIds.map(String) : [];
      const name = typeof party === 'string' ? party.trim() : '';
      if (name) {
        let p = byName.get(key(name));
        if (!p) {
          p = { id: newPartyId(), name, order: nextOrder++, createdAt: now, updatedAt: now };
          parties.push(p);
          byName.set(key(name), p);
        }
        if (!ids.includes(p.id)) ids.push(p.id);
      }
      // Единственная пати из старого формата становится основной
      const mainPartyId = ids.includes(c.mainPartyId) ? c.mainPartyId : (ids[0] || null);
      return { ...rest, partyIds: ids, mainPartyId, notes: typeof c.notes === 'string' ? c.notes : '' };
    });
    s.parties = parties;
    return s;
  }
};

/** Версия схемы входных данных (старые файлы хранили её в поле `version`). */
export function detectVersion(raw) {
  const v = Number(raw?.schemaVersion ?? raw?.version);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
}

/**
 * @returns {{ state: object, from: number, to: number, applied: number[], newer: boolean, idRemap: object }}
 *   newer = файл создан более новой версией приложения (данные не трогаем);
 *   idRemap = { старый id персонажа: новый id } (миграция v4).
 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { state: { schemaVersion: SCHEMA_VERSION }, from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [], newer: false, idRemap: {} };
  }
  const from = detectVersion(raw);
  if (from > SCHEMA_VERSION) {
    return { state: raw, from, to: from, applied: [], newer: true, idRemap: {} };
  }
  let s = clone(raw);
  const applied = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) { s = step(s) || s; applied.push(v); }
  }
  s.schemaVersion = SCHEMA_VERSION;
  delete s.version;
  const idRemap = s.__idRemap || {};
  delete s.__idRemap;
  return { state: s, from, to: SCHEMA_VERSION, applied, newer: false, idRemap };
}
