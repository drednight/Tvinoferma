// @ts-check
// js/modules/launcher/launch.js
// Запуск игры: у каждого аккаунта (персонажа) свой GameCenter — путь в character.launch.gcPath.
// Аккаунты запускаются по очереди. Rust-команда launcher_start сама подтверждает окно GameCenter
// «Клиент игры уже запущен» (выбирает «Запустить новую копию клиента») и ждёт появления нового клиента;
// после этого выдерживается короткая пауза, и стартует следующий аккаунт.

import { createLimiter, runQueue, sleep } from '../sync/queue.js';

/** Пауза между запусками аккаунтов (после появления нового клиента), мс. */
export const DEFAULT_LAUNCH_DELAY_MS = 3000;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/** Аккаунты, для которых указан путь к GameCenter, в порядке списка. */
export function launchable(characters) {
  return (characters || []).filter(c => String(c?.launch?.gcPath || '').trim());
}

/** Проверка пути из настроек. Возвращает полный путь к GameCenter.exe или бросает ошибку. */
export function checkGameCenterPath(path, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_check_path', { path });
}

/** Диагностика: видимые окна VK Play и окна вопросов GameCenter. */
export function findDialogs(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_find_dialogs');
}

/** PID запущенных клиентов игры. */
export function runningClients(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_running_clients');
}

/** Закрыть все клиенты игры. Возвращает, сколько было закрыто. */
export function closeAllClients(deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_close_clients');
}

/**
 * Запустить игру для списка аккаунтов по очереди (по одному, с паузой между запусками).
 *
 * @param {Array<{ id: string, nick?: string, launch?: { gcPath?: string } }>} characters
 * @param {{
 *   delayMs?: number,
 *   waitSecs?: number,
 *   url?: string,
 *   signal?: { cancelled: boolean },
 *   onStart?: (character: any) => void,
 *   onDone?: (entry: { id: string, nick: string, ok: boolean, error?: string }, done: number, total: number) => void
 * }} [opts]
 * @param {{ invoke?: (cmd: string, args?: any) => Promise<any> }} [deps]
 */
export async function launchCharacters(characters, opts = {}, deps = {}) {
  const { delayMs = DEFAULT_LAUNCH_DELAY_MS, waitSecs, url, signal, onStart, onDone } = opts;
  const invoke = deps.invoke || tauriInvoke;
  const list = launchable(characters);
  const jobs = list.map((character, i) => ({ character, last: i === list.length - 1 }));

  const results = await runQueue(
    jobs,
    async ({ character, last }) => {
      await invoke('launcher_start', { path: character.launch.gcPath, url: url || null, waitSecs: waitSecs ?? null });
      if (!last && delayMs > 0) await sleep(delayMs); // следующий аккаунт стартует после паузы
    },
    {
      limiter: createLimiter(1), // строго по одному
      retries: 0,
      signal,
      onStart: ({ character }) => onStart?.(character),
      onDone: (entry, done, total) => {
        const { character } = entry.item;
        onDone?.({
          id: character.id,
          nick: character.nick || character.id,
          ok: !entry.error,
          error: entry.error ? String(entry.error?.message || entry.error) : undefined
        }, done, total);
      }
    }
  );

  return results.map(r => ({
    id: r.item.character.id,
    nick: r.item.character.nick || r.item.character.id,
    ok: !r.error && !r.cancelled,
    cancelled: !!r.cancelled,
    error: r.error ? String(r.error?.message || r.error) : undefined
  }));
}
