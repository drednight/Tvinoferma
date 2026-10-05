// js/settings/factoryReset.js
// «Настройки → Опасные действия → Вернуть к заводским настройкам».
//
// Полный сброс: приложение возвращается к состоянию сразу после установки. Удаляется всё, включая журналы,
// сессии, профили браузера и записи в хранилище учётных данных ОС. Резервные копии тоже удаляются,
// поэтому откатить действие нельзя — интерфейс обязан честно об этом сказать и предложить экспорт.

import { state } from '../core/state.js';
import { isTauri } from '../core/storage.js';
import { toast } from '../core/ui.js';
import { accountKeysOf } from '../modules/launcher/gameCenters.js';

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

/** Ключи контактов персонажей (email, пароль, телефон) в хранилище ОС. */
export function contactKeysOf(characters) {
  return (characters || [])
    .map(c => String(c?.id || '').trim())
    .filter(Boolean);
}

/** Ключи запомненных входов GameCenter (со своим списком GameCenter у каждого персонажа). */
export function accountKeysOfAll(characters) {
  return (characters || []).flatMap(c => accountKeysOf(c));
}

/**
 * Все ключи хранилища ОС, которые нужно удалить при сбросе.
 * Порядок и повторы не важны: Rust удаляет по списку и пропускает отсутствующие.
 */
export function secretsToRemove(characters) {
  return [...new Set([...contactKeysOf(characters), ...accountKeysOfAll(characters)])];
}

/** Что именно пропадёт — для текста подтверждения. */
export function resetSummary(appState = state) {
  const chars = (appState.characters || []).length;
  const parties = (appState.parties || []).length;
  const marathons = (appState.marathons || []).length;
  return { chars, parties, marathons, secrets: secretsToRemove(appState.characters).length };
}

/** Текст подтверждения: перечисляет, что будет удалено, и предупреждает о необратимости. */
export function resetWarning(summary) {
  const parts = [];
  if (summary.chars) parts.push(`персонажей: ${summary.chars}`);
  if (summary.parties) parts.push(`пати: ${summary.parties}`);
  if (summary.marathons) parts.push(`марафонов: ${summary.marathons}`);
  const list = parts.length ? `Будет удалено — ${parts.join(', ')}. ` : '';
  return `${list}Также удаляются настройки, журналы, история монет, сессии и профили браузера персонажей, `
    + `пароли и запомненные входы в хранилище учётных данных ОС${summary.secrets ? ` (записей: ${summary.secrets})` : ''}. `
    + 'Резервные копии тоже удаляются, поэтому откатить это действие нельзя. Если данные нужны — сначала сделайте экспорт.';
}

/**
 * Выполняет полный сброс: сначала собирает ключи хранилища ОС из текущих данных,
 * затем просит Rust удалить файлы и записи, после чего перезагружает окно.
 * @returns {Promise<boolean>} true — сброс выполнен
 */
export async function performFactoryReset(appState = state) {
  if (!isTauri()) {
    toast('Полный сброс доступен только в приложении', 'error');
    return false;
  }
  const keys = secretsToRemove(appState.characters);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const report = await invoke('factory_reset', { keys });
    const problems = report?.problems || [];
    if (problems.length) {
      // Не всё удалось (например, файл занят): говорим об этом прямо, а не молчим
      console.warn('[FACTORY RESET] не всё удалось:', problems);
    }
    // Перезагрузка обязательна: в памяти остались данные, которых на диске уже нет.
    // Сообщение о неполном удалении показываем до перезагрузки — после неё его уже не увидеть.
    if (problems.length) {
      toast(report?.message || `Не всё удалось удалить: ${problems.join('; ')}`, 'error', 6000);
      setTimeout(() => window.location.reload(), 2500);
      return true;
    }
    window.location.reload();
    return true;
  } catch (e) {
    toast(`Не удалось выполнить сброс: ${errText(e)}`, 'error');
    return false;
  }
}
