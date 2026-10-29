// js/settings/factoryReset.js
// «Настройки → Опасные действия»: намеренное необратимое удаление данных.
// Очередь и снимок согласуются только внутри этого JS-контекста. Неизвестные
// ключи хранилища ОС и отдельные журналы в WebView перечислить здесь нельзя.

import { state } from '../core/state.js';
import { isTauri, isUncertainFactoryReset, runGuardedFactoryReset } from '../core/storage.js';
import { toast } from '../core/ui.js';
import { accountKeysOf } from '../modules/launcher/gameCenters.js';

const plans = new WeakMap();

/** Ключи контактов без изменения регистра и пробелов внутри исходного ID. */
export function contactKeysOf(characters) {
  return (characters || []).map(c => (typeof c?.id === 'string' ? c.id : '')).filter(id => id.trim());
}

/** Ключи известных запомненных входов GameCenter. */
export function accountKeysOfAll(characters) {
  return (characters || []).flatMap(c => accountKeysOf(c));
}

/** Для совместимости: объединённые имена ключей, без префиксов хранилища ОС. */
export function secretsToRemove(characters) {
  return [...new Set([...contactKeysOf(characters), ...accountKeysOfAll(characters)])];
}

function characterLists(appState) {
  const active = appState?.characters ?? [];
  const archived = appState?.archivedCharacters ?? [];
  if (!Array.isArray(active) || !Array.isArray(archived)) throw new Error('Некорректный список персонажей');
  const all = [...active, ...archived];
  const seen = new Set();
  for (const character of all) {
    if (!character || typeof character.id !== 'string' || !character.id.trim()) {
      throw new Error('Некорректный ID персонажа');
    }
    const id = character.id.toLowerCase();
    if (seen.has(id)) throw new Error('Неоднозначные ID персонажей');
    seen.add(id);
    const launch = character.launch;
    if (launch != null && (typeof launch !== 'object' || Array.isArray(launch))) throw new Error('Некорректный запуск');
    if (launch?.gcIds != null && !Array.isArray(launch.gcIds)) throw new Error('Некорректные ID лаунчеров');
    if (launch?.gcAccounts != null && (typeof launch.gcAccounts !== 'object' || Array.isArray(launch.gcAccounts))) {
      throw new Error('Некорректные данные лаунчеров');
    }
    const ids = [...(launch?.gcIds || []), ...Object.keys(launch?.gcAccounts || {})];
    if (ids.some(gcId => typeof gcId !== 'string' || !gcId.trim())) throw new Error('Некорректный ID лаунчера');
  }
  return all;
}

// Некоторые старые записи могли остаться после изменения настройки входа. Удаляем
// известные кандидатные имена для каждого персонажа и его известных лаунчеров,
// но не заявляем, что обнаружены все оставшиеся в системе записи.
function knownAccountKeys(characters) {
  const keys = new Set([...contactKeysOf(characters), ...accountKeysOfAll(characters)]);
  for (const character of characters) {
    const launch = character.launch || {};
    const gcIds = new Set([...(launch.gcIds || []), ...Object.keys(launch.gcAccounts || {})]);
    for (const gcId of gcIds) keys.add(`${character.id}@${gcId}`);
  }
  return [...keys].sort();
}

function resetPlanData(appState) {
  if (!appState || typeof appState !== 'object' || Array.isArray(appState)) throw new Error('Нет состояния');
  const characters = characterLists(appState);
  const keys = [...new Set(contactKeysOf(characters))].sort();
  const accountKeys = knownAccountKeys(characters);
  const count = (active, archived) => {
    if (active != null && !Array.isArray(active)) throw new Error('Некорректный список');
    if (archived != null && !Array.isArray(archived)) throw new Error('Некорректный архив');
    return (active?.length || 0) + (archived?.length || 0);
  };
  const summary = {
    chars: characters.length,
    parties: count(appState.parties, appState.archivedParties),
    marathons: count(appState.marathons, null),
    // Это число возможных имён, а не подтверждение наличия записей.
    secrets: keys.length + accountKeys.length
  };
  // Свидетельство не выводится в журнал и живёт только до завершения операции.
  // В нём могут быть открытые контакты; JS не гарантирует стирание строки из памяти.
  const { ui: _ui, ...persisted } = appState;
  const witness = JSON.stringify(persisted);
  if (typeof witness !== 'string') throw new Error('Не удалось проверить состояние');
  return { summary, keys, accountKeys, witness };
}

/** Что именно указать в подтверждении, включая архивные записи. */
export function resetSummary(appState = state) {
  return resetPlanData(appState).summary;
}

/** Текст предупреждает об удалении копий и известных ограничениях сброса. */
export function resetWarning(summary) {
  const parts = [];
  if (summary.chars) parts.push(`персонажей: ${summary.chars} (включая архив)`);
  if (summary.parties) parts.push(`пати: ${summary.parties} (включая архив)`);
  if (summary.marathons) parts.push(`марафонов: ${summary.marathons}`);
  const list = parts.length ? `Будет удалено — ${parts.join(', ')}. ` : '';
  return (
    `${list}Также удаляются настройки, сессии и профили браузера персонажей, известные контакты и запомненные входы ` +
    `в хранилище ОС${summary.secrets ? ` (возможных ключей: ${summary.secrets})` : ''}. ` +
    'Резервные копии тоже удаляются, поэтому откатить это действие нельзя. Если данные нужны — сначала сделайте экспорт. ' +
    'Экспорт может содержать открытые контакты и пароли, но не включает отдельные журналы, сессии, профили и входы GameCenter; храните его защищённо. ' +
    'Приложение также пытается удалить известные локальные записи доступа к облаку, внутренний ключ синхронизации и локальную очередь отправки; облачные файлы и разрешения, выданные провайдерам, сохраняются. Для восстановления шифрованного облака понадобится пароль или запасной ключ, сохранённый отдельно. ' +
    'Завершите активные операции и закройте другие окна приложения. Отдельные локальные журналы и неизвестные записи хранилища ОС могут остаться.'
  );
}

/** Фиксирует данные, которые пользователь увидит перед подтверждением. */
export function prepareFactoryReset(appState = state) {
  const data = resetPlanData(appState);
  const plan = Object.freeze({ summary: Object.freeze(data.summary) });
  plans.set(plan, { appState, ...data });
  return plan;
}

/** Забывает свидетельство после отмены диалога. */
export function discardFactoryResetPlan(plan) {
  if (plan && typeof plan === 'object') plans.delete(plan);
}

function reportConfirmed(report) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
  return (
    report &&
    typeof report === 'object' &&
    !Array.isArray(report) &&
    typeof report.stateRemoved === 'boolean' &&
    count(report.backupsRemoved) &&
    typeof report.sessionsRemoved === 'boolean' &&
    typeof report.profilesRemoved === 'boolean' &&
    count(report.secretsRemoved) &&
    Array.isArray(report.problems) &&
    report.problems.every(problem => typeof problem === 'string') &&
    typeof report.message === 'string'
  );
}

/**
 * Блокирует новые записи, ждёт запланированные и только после перепроверки
 * согласованного снимка отправляет команду. Успех требует корректного полного
 * отчёта; частичный или потерянный ответ не повторяется автоматически.
 * @returns {Promise<boolean>} true — команда завершилась без известных ошибок
 */
export async function performFactoryReset(appState = state, approvedPlan = null) {
  if (!isTauri()) {
    toast('Полный сброс доступен только в приложении', 'error');
    return false;
  }
  let plan;
  let record;
  let invoke;
  try {
    plan = approvedPlan;
    record = plan && plans.get(plan);
    if (!record || record.appState !== appState) throw new Error('Нет подтверждённого плана');
    plans.delete(plan); // одно подтверждение нельзя использовать повторно
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    toast('Не удалось подготовить сброс. Проверьте данные и попробуйте снова.', 'error');
    return false;
  }

  try {
    await runGuardedFactoryReset(
      () => {
        const current = resetPlanData(appState);
        return (
          current.witness === record.witness &&
          JSON.stringify(current.keys) === JSON.stringify(record.keys) &&
          JSON.stringify(current.accountKeys) === JSON.stringify(record.accountKeys)
        );
      },
      async () => {
        // Исходная строка нужна только для локальной проверки перед удалением.
        // В ней могут быть контакты; её нельзя выводить в журнал или передавать в сеть.
        const raw = await invoke('load_state_raw');
        if (raw !== null && (typeof raw !== 'string' || !raw)) throw new Error('Недопустимый ответ');
        return raw;
      },
      async expectedRaw => {
        const result = await invoke('factory_reset', {
          keys: record.keys,
          accountKeys: record.accountKeys,
          expectedRaw
        });
        if (!reportConfirmed(result) || result.problems.length) throw new Error('Результат не подтверждён');
        return result;
      }
    );
    // В памяти остаётся прежнее состояние. Блокировка действует до перезагрузки.
    try {
      window.location.reload();
    } catch {
      toast('Команда сброса завершилась. Перезапустите приложение, чтобы обновить данные.', 'info', 60000);
    }
    return true;
  } catch (error) {
    if (isUncertainFactoryReset(error)) {
      toast(
        'Сброс мог затронуть часть данных. Повтор и сохранение остановлены; проверьте данные и копии.',
        'error',
        60000
      );
    } else {
      toast(error instanceof Error ? error.message : 'Сброс остановлен до удаления данных.', 'error', 60000);
    }
    return false;
  }
}
