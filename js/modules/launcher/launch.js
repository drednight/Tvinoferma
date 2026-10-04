// @ts-check
// js/modules/launcher/launch.js
// Запуск игры: у каждого аккаунта (персонажа) свой GameCenter — путь в character.launch.gcPath.
// Аккаунты запускаются по очереди. Rust-команда launcher_start сама:
//  - подставляет сохранённый вход аккаунта в GameCenter.ini (если он запомнен, см. captureAccount);
//  - подтверждает окно GameCenter «Клиент игры уже запущен» («Запустить новую копию клиента»);
//  - ждёт появления нового клиента игры.
// После этого выдерживается короткая пауза, и стартует следующий аккаунт.
// Токен входа в JS не попадает: он лежит в хранилище ОС и читается только на стороне Rust.

import { createLimiter, runQueue, sleep } from '../sync/queue.js';

/** Пауза между запусками аккаунтов (после появления нового клиента), мс. */
export const DEFAULT_LAUNCH_DELAY_MS = 3000;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/** Указан ли у персонажа путь к GameCenter. */
export function hasGameCenterPath(character) {
  return !!String(character?.launch?.gcPath || '').trim();
}

/** Аккаунты, для которых указан путь к GameCenter, в порядке списка. */
export function launchable(characters) {
  return (characters || []).filter(hasGameCenterPath);
}

/** Кого запустим (`ready`), а кого пропустим из-за отсутствия пути (`skipped`). */
export function launchPlan(characters) {
  const list = characters || [];
  return { ready: list.filter(hasGameCenterPath), skipped: list.filter(c => !hasGameCenterPath(c)) };
}

/** Строка про сохранённый вход для карточки персонажа. */
export function loginStatusText(character) {
  const l = character?.launch || {};
  if (!l.gcAccount) return 'Вход не запомнен: запускается тот аккаунт, под которым уже открыт этот GameCenter.';
  const who = l.gcNick ? ` «${l.gcNick}»` : '';
  return `Вход запомнен${who}. При запуске этот GameCenter будет закрыт и откроется под этим аккаунтом.`;
}

/** Проверка пути из настроек. Возвращает полный путь к GameCenter.exe или бросает ошибку. */
export function checkGameCenterPath(path, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_check_path', { path });
}

/**
 * Запомнить вход, который сейчас открыт в GameCenter персонажа (токен уходит в хранилище ОС).
 * Возвращает ник из GameCenter (может быть пустой строкой).
 */
export function captureAccount(character, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_capture_account', {
    charId: character.id,
    path: character.launch?.gcPath || ''
  });
}

/** Удалить сохранённый вход персонажа из хранилища ОС. */
export function forgetAccount(charId, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_forget_account', { charId });
}

/** Есть ли сохранённый вход у персонажа. */
export function hasAccount(charId, deps = {}) {
  return (deps.invoke || tauriInvoke)('launcher_has_account', { charId });
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
 * Персонажи без пути к GameCenter пропускаются (их можно узнать через launchPlan).
 *
 * @param {Array<{ id: string, nick?: string, launch?: { gcPath?: string, gcNick?: string } }>} characters
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
      // Отмена: тем, кто ещё ждёт своей очереди, запуск уже не начинается
      if (signal?.cancelled) return { cancelled: true };
      onStart?.(character);
      await invoke('launcher_start', {
        path: character.launch?.gcPath,
        charId: character.id,
        nick: character.launch?.gcNick || null,
        url: url || null,
        waitSecs: waitSecs ?? null
      });
      if (!last && delayMs > 0) await sleep(delayMs); // следующий аккаунт стартует после паузы
      return { cancelled: false };
    },
    {
      limiter: createLimiter(1), // строго по одному
      retries: 0,
      signal,
      onDone: (entry, done, total) => {
        if (entry.result?.cancelled) return;
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

  return results.map(r => {
    const cancelled = !!(r.cancelled || r.result?.cancelled);
    return {
      id: r.item.character.id,
      nick: r.item.character.nick || r.item.character.id,
      ok: !r.error && !cancelled,
      cancelled,
      error: r.error ? String(r.error?.message || r.error) : undefined
    };
  });
}
