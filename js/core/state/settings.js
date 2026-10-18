// @ts-check
// js/core/state/settings.js
// Приведение настроек к схеме — чистые функции без доступа к общему состоянию.
//
// Каждая группа настроек сводится к `DEFAULT_SETTINGS` (js/core/constants.js). Список
// групп задан один раз в mergeSettings: добавление группы в DEFAULT_SETTINGS без строки
// здесь означало бы, что настройка молча не сохраняется — за это отвечает тест
// «все группы DEFAULT_SETTINGS переживают нормализацию» в tests/stateSettings.test.js.

import { DEFAULT_SETTINGS } from '../constants.js';
import { SOUND_TONES, DEFAULT_TONE } from '../../desktop/sound.js';
import { normalizeGameCenters } from '../../modules/launcher/gameCenters.js';
import { normalizeGuildData } from '../../modules/guild/core.js';
import { normalizePreflightMode } from '../../modules/launcher/preflight.js';
import { normalizeSectionsSettings } from '../sections.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Настройки кланового сайта (скрытая фича). Рядом с флагом `enabled` лежит кэш сводки —
 * как `updates.lastCheckedAt`: это данные, а не настройка, но они маленькие и одни
 * на приложение. Флаг обязан быть строго булевым, кэш проходит через normalizeGuildData.
 */
function normalizeGuildSettings(input = {}) {
  return { ...normalizeGuildData(input), enabled: input?.enabled === true };
}

function normalizeLauncherSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS.launcher, ...(input || {}) };
  merged.gameCenters = normalizeGameCenters(merged.gameCenters);
  const preferred = String(merged.preferredGcId || '');
  merged.preferredGcId = merged.gameCenters.some(g => g.id === preferred) ? preferred : '';
  // Пауза между запусками окон: число секунд от 0 до 120, иначе умолчание
  /** @type {any} */
  const rawDelay = merged.delaySec;
  const delay = Number(rawDelay);
  merged.delaySec = rawDelay !== '' && rawDelay !== null && rawDelay !== undefined && Number.isFinite(delay)
    ? Math.min(120, Math.max(0, delay))
    : DEFAULT_SETTINGS.launcher.delaySec;
  merged.skipRunning = merged.skipRunning !== false;
  merged.preflight = normalizePreflightMode(merged.preflight);
  merged.layoutDir = String(merged.layoutDir ?? '').trim();
  merged.layoutTemplate = String(merged.layoutTemplate ?? '').trim();
  return merged;
}

/**
 * Настройки уведомлений. Отдельная обработка нужна из-за вложенных списков — видов
 * (`kinds`) и ивентов (`events`): обычное поверхностное слияние затирало бы умолчания
 * ивентов, которых нет в старом state.json, и напоминание о них молча не работало бы.
 * Валидность «минут до начала» проверяет `eventNotificationSettings` при чтении.
 */
function normalizeNotificationSettings(input = {}) {
  const raw = input || {};
  const def = DEFAULT_SETTINGS.notifications;
  const hour = Number(raw.dailyHour);

  /**
   * Настройка одного вида: показывать ли всплывающее окно и играть ли звук.
   * Записи нет — вид работает целиком: новые виды доступны сразу после обновления.
   */
  /** @type {Record<string, { popup: boolean, sound: boolean }>} */
  const kinds = {};
  for (const [kind] of Object.entries(def.kinds || {})) {
    const own = raw.kinds?.[kind] || {};
    kinds[kind] = {
      popup: own.popup !== false,
      sound: own.sound !== false
    };
  }
  // Старые галочки «не успевает», «заканчивается» и «ежедневно» держали по одному выключателю
  // на несколько видов. Переносим их выбор, иначе после обновления выбор молча сбросится.
  const oldOff = (flag) => raw[flag] === false;
  if (oldOff('marathonBehind')) {
    kinds.behind.popup = false;
    kinds.tight.popup = false;
  }
  if (oldOff('marathonEnding')) kinds.ending.popup = false;
  if (oldOff('dailyReminder')) kinds.daily.popup = false;

  /** @type {Record<string, { enabled: boolean, leadMinutes: number }>} */
  const events = {};
  for (const [id, defEvent] of Object.entries(def.events || {})) {
    const own = raw.events?.[id] || {};
    const minutes = Number(own.leadMinutes);
    events[id] = {
      enabled: own.enabled !== false,
      leadMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : defEvent.leadMinutes
    };
  }

  const sound = raw.sound || {};
  const volume = Number(sound.volume);
  // Набор звука приводим к списку из `SOUND_TONES`: в state.json может прийти любой id,
  // в том числе от более новой версии приложения — тогда берём набор по умолчанию
  const toneIds = new Set(SOUND_TONES.map(t => t.id));
  // Настройки собираются заново, а не поверх старых: так из state.json уходят галочки,
  // которых больше нет (marathonBehind и другие), и остаётся один источник настроек
  return {
    enabled: raw.enabled !== false,
    sound: {
      enabled: sound.enabled !== false,
      volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : def.sound.volume,
      tone: toneIds.has(sound.tone) ? sound.tone : DEFAULT_TONE
    },
    // Приведение типов: набор видов и ивентов задаётся списками в `constants.js`, поэтому в
    // типах перечислены конкретные ключи, а объекты собираются циклом
    kinds: /** @type {typeof def.kinds} */ (kinds),
    dailyHour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : def.dailyHour,
    events: /** @type {typeof def.events} */ (events)
  };
}

export function mergeSettings(input = {}) {
  return {
    ...clone(DEFAULT_SETTINGS),
    ...input,
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(input.privacy || {}) },
    autosave: { ...DEFAULT_SETTINGS.autosave, ...(input.autosave || {}) },
    backups: { ...DEFAULT_SETTINGS.backups, ...(input.backups || {}) },
    google: {
      ...DEFAULT_SETTINGS.google,
      ...(input.google || {}),
      sheetsFields: {
        ...DEFAULT_SETTINGS.google.sheetsFields,
        ...(input.google?.sheetsFields || {})
      }
    },
    // Разделы разбираем отдельно: порядок и список выключенных — это не «любые ключи»,
    // а отфильтрованный набор настоящих разделов (см. js/core/sections.js)
    ui: {
      ...DEFAULT_SETTINGS.ui,
      ...(input.ui || {}),
      sections: normalizeSectionsSettings(input.ui?.sections)
    },
    security: { ...DEFAULT_SETTINGS.security, ...(input.security || {}) },
    scripts: { ...DEFAULT_SETTINGS.scripts, ...(input.scripts || {}) },
    notifications: normalizeNotificationSettings(input.notifications),
    browser: { ...DEFAULT_SETTINGS.browser, ...(input.browser || {}) },
    // Ключ раздела клана переехал сюда не здесь: переименование eternals → guild описано
    // миграцией 9 → v10 (js/core/migrations.js), иначе откат на старую версию записал бы
    // поверх файла умолчания. Здесь только приведение к схеме.
    guild: normalizeGuildSettings(input.guild),
    launcher: normalizeLauncherSettings(input.launcher),
    tray: { ...DEFAULT_SETTINGS.tray, ...(input.tray || {}) },
    freshness: { ...DEFAULT_SETTINGS.freshness, ...(input.freshness || {}) },
    updates: { ...DEFAULT_SETTINGS.updates, ...(input.updates || {}) }
  };
}