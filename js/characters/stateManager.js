// js/characters/stateManager.js

import { uid, nowISO } from '../utils.js';

/**
 * Дефолтная структура характеристик
 */
export const DEFAULT_STATS = {
  endurance: 0, intelligence: 0, strength: 0, agility: 0,
  hp: 0, hpMax: 0, mp: 0, mpMax: 0,
  physAttack: 0, physDefense: 0, magAttack: 0, magDefense: 0,
  critChance: 0, critDamage: 0, atkSpeed: 0, evasion: 0, accuracy: 0,
  pa: 0, pz: 0, morale: 0, power: 0, stealth: 0, detection: 0,
  pvePa: 0, pvePz: 0, physPenetration: 0, magPenetration: 0
};

/**
 * Создает новый объект персонажа с дефолтами
 */
export function createEmptyCharacter() {
  return {
    id: uid(),
    nick: '',
    class: '',
    party: null,
    level: 1,
    sky: { name: null, level: null },
    contacts: { email: '', password: '', recoveryEmail: '', phone: '' },
    dungeonPasses: { weapon: 0, armor: 0, relic: 0 },
    ancientCoins: 0,
    coinHistory: [],
    stats: { ...DEFAULT_STATS },
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

/**
 * Нормализует данные персонажа при загрузке из JSON
 */
export function normalizeCharacterData(input = {}) {
  return {
    ...createEmptyCharacter(), // База
    ...input,                  // Переопределяем входными данными
    sky: { 
      name: input.sky?.name || null, 
      level: input.sky?.level ? Number(input.sky.level) : null 
    },
    contacts: {
      email: String(input.contacts?.email || ''),
      password: String(input.contacts?.password || ''),
      recoveryEmail: String(input.contacts?.recoveryEmail || ''),
      phone: String(input.contacts?.phone || '')
    },
    dungeonPasses: {
      weapon: Number(input.dungeonPasses?.weapon) || 0,
      armor: Number(input.dungeonPasses?.armor) || 0,
      relic: Number(input.dungeonPasses?.relic) || 0
    },
    stats: {
      ...DEFAULT_STATS,
      ...(input.stats || {})
    },
    ancientCoins: Number(input.ancientCoins) || 0,
    coinHistory: Array.isArray(input.coinHistory) ? input.coinHistory : []
  };
}