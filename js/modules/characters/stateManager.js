// js/modules/characters/stateManager.js

import { nowISO } from '../../core/utils.js';

/**
 * Дефолтная структура характеристик
 */
export const DEFAULT_STATS = {
  endurance: 0,
  intelligence: 0,
  strength: 0,
  agility: 0,
  hp: 0,
  mp: 0,
  levelBonus: 0,
  physAttack: 0,
  physDefense: 0,
  magAttack: 0,
  magDefense: 0,
  critChance: 0,
  critDamage: 0,
  atkSpeed: 0,
  evasion: 0,
  accuracy: 0,
  pa: 0,
  pz: 0,
  morale: 0,
  pvePa: 0,
  pvePz: 0,
  physPenetration: 0,
  magPenetration: 0
};

/**
 * Полная runtime-схема, совпадающая с normalizeCharacter: экспорт и подготовка
 * облака должны работать до первого перезапуска, без undefined в сохранении.
 */
export function createEmptyCharacter() {
  return {
    id: null, // назначается из ника при сохранении (core/ids.js)
    nick: '',
    favorite: false,
    class: '',
    partyIds: [],
    mainPartyId: null,
    partyOrder: {},
    notes: '',
    level: 1,
    sky: { name: null, level: null },
    contacts: { email: '', password: '', recoveryEmail: '', phone: '' },
    launch: { gcPath: '', gcNick: '', gcAccount: false, gcIds: [], gcAccounts: {} },
    dungeonPasses: { weapon: 0, armor: 0, relic: 0 },
    ancientCoins: 0,
    lastCoinUpdate: null,
    coinsParserV: 0,
    coinHistory: [],
    stats: { ...DEFAULT_STATS },
    statsHistory: [],
    isLoggedIn: false,
    lastLoginCheck: null,
    lastLoginReason: null,
    marathonData: null,
    tags: [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

/**
 * Бонус к уровню для показа рядом с уровнем: «12 БУ». Пустая строка, если бонуса нет.
 * @param {{ stats?: { levelBonus?: number } } | null | undefined} char
 */
export function levelBonusLabel(char) {
  const n = Number(char?.stats?.levelBonus) || 0;
  return n > 0 ? `${n} БУ` : '';
}
