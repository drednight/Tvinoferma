// js/modules/launcher/partyLaunch.js
// Запуск игры из интерфейса: пати целиком (вкладка «Пати») и один персонаж (раскрытая карточка).
// Ход запуска виден в доке задач и в «Настройки → Журналы → Скрипты»; кнопка «Отмена» останавливает очередь.
// Одновременно идёт один запуск: GameCenter и окна клиентов общие для всех аккаунтов.

import { state } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import { startTask } from '../../core/taskLog.js';
import { launchCharacters, launchPlan, checkGameCenterPath, captureAccount, forgetAccount } from './launch.js';

let active = null; // { signal } идущего запуска

export const isLaunching = () => !!active;

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

/**
 * Запускает игру для списка персонажей по очереди.
 * @param {string} title заголовок задачи в журнале
 * @param {any[]} characters
 */
export async function launchGroup(title, characters) {
  if (active) {
    toast('Запуск уже идёт: дождитесь окончания или отмените его (док задач внизу)', 'error');
    return null;
  }
  if (!isTauri()) {
    toast('Запуск игры работает только в приложении (в браузере недоступен)', 'error');
    return null;
  }
  const { ready, skipped } = launchPlan(characters);
  if (!ready.length) {
    toast('Не указан путь к GameCenter: откройте персонажа → «🎮 Запуск игры»', 'error');
    return null;
  }

  const signal = { cancelled: false };
  const task = startTask(title, { total: ready.length, cancelable: true });
  task.onCancel(() => { signal.cancelled = true; });
  active = { signal };
  skipped.forEach(c => task.log(`${c.nick}: пропущен — не указан путь к GameCenter`, 'warn'));

  try {
    const results = await launchCharacters(ready, {
      signal,
      onStart: (c) => task.setStep(`${c.nick}: запуск…`),
      onDone: (e, done, total) => {
        task.log(`${e.nick}: ${e.ok ? 'клиент игры запущен' : `ошибка — ${e.error}`}`, e.ok ? 'ok' : 'error');
        task.progress(done, total);
      }
    });
    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.cancelled).length;
    const cancelled = results.filter(r => r.cancelled).length;
    const parts = [`запущено ${ok} из ${ready.length}`];
    if (failed) parts.push(`с ошибкой: ${failed}`);
    if (cancelled) parts.push(`отменено: ${cancelled}`);
    if (skipped.length) parts.push(`пропущено без пути: ${skipped.length}`);
    const summary = parts.join(', ');
    task.finish(summary, failed ? 'warn' : undefined);
    toast(summary, failed ? 'error' : 'success');
    return results;
  } catch (e) {
    task.log(errText(e), 'error');
    task.finish('Запуск прерван из-за ошибки', 'error');
    toast(`Запуск не удался: ${errText(e)}`, 'error');
    return null;
  } finally {
    active = null;
  }
}

/** Сохраняет путь к GameCenter у персонажа (в приложении путь проверяется). */
export async function saveGameCenterPath(char, path) {
  const value = String(path || '').trim();
  if (value && isTauri()) {
    try { await checkGameCenterPath(value); }
    catch (e) { toast(errText(e), 'error'); return false; }
  }
  char.launch = { ...(char.launch || {}), gcPath: value };
  char.updatedAt = new Date().toISOString();
  await persist();
  toast(value ? 'Путь к GameCenter сохранён' : 'Путь к GameCenter убран', 'success');
  return true;
}

/** Запоминает вход, открытый сейчас в GameCenter персонажа. */
export async function captureLogin(char) {
  if (!String(char.launch?.gcPath || '').trim()) {
    toast('Сначала укажите и сохраните путь к GameCenter', 'error');
    return false;
  }
  if (!isTauri()) { toast('Доступно только в приложении', 'error'); return false; }
  try {
    const nick = await captureAccount(char);
    char.launch = { ...char.launch, gcNick: nick || '', gcAccount: true };
    char.updatedAt = new Date().toISOString();
    await persist();
    toast(nick ? `Вход запомнен: ${nick}` : 'Вход запомнен', 'success');
    return true;
  } catch (e) {
    toast(errText(e), 'error');
    return false;
  }
}

/** Забывает сохранённый вход персонажа. */
export async function forgetLogin(char) {
  try {
    if (isTauri()) await forgetAccount(char.id);
    char.launch = { ...(char.launch || {}), gcNick: '', gcAccount: false };
    char.updatedAt = new Date().toISOString();
    await persist();
    toast('Сохранённый вход удалён', 'success');
    return true;
  } catch (e) {
    toast(errText(e), 'error');
    return false;
  }
}
