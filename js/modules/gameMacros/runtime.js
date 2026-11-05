import { state } from '../../core/state.js';
import { normalizeGameMacros, resolveTargets, steps } from './model.js';
let invoke, emitTo;
let initialized = false,
  busy = false,
  cancelled = false,
  registered = false;
let cycleId = '';
const logs = [];
export const config = () => normalizeGameMacros(state.settings.gameMacros);
const native = async (command, args) => {
  if (!window.__TAURI_INTERNALS__) throw new Error('Нужна настольная версия Windows.');
  invoke ||= (await import('@tauri-apps/api/core')).invoke;
  return invoke(command, args);
};
export function snapshot() {
  const c = config();
  return {
    busy,
    registered,
    opacity: c.opacity,
    topmost: c.topmost,
    commands: c.commands.map(({ id, name, hotkey }) => ({ id, name, hotkey })),
    logs: logs.slice(-80)
  };
}
export async function broadcast() {
  window.dispatchEvent(new Event('tf-game-macros-changed'));
  if (!window.__TAURI_INTERNALS__) return;
  emitTo ||= (await import('@tauri-apps/api/event')).emitTo;
  try {
    await emitTo('game-overlay', 'game-macro-snapshot', snapshot());
  } catch {
    /* overlay closed */
  }
}
function log(text) {
  logs.push(`${new Date().toLocaleTimeString('ru-RU')} · ${text}`);
  if (logs.length > 120) logs.shift();
  void broadcast();
}
export function stop() {
  cancelled = true;
  if (busy) log('Запрошена остановка. Уже отправленный ввод отменить нельзя.');
}
const wait = async ms => {
  for (let left = ms; left > 0; left -= 50) {
    if (cancelled) throw new Error('cancel');
    await new Promise(r => setTimeout(r, Math.min(50, left)));
  }
};
let configureQueue = Promise.resolve();
export function configure() {
  configureQueue = configureQueue.catch(() => {}).then(applyConfig);
  return configureQueue;
}
async function applyConfig() {
  const c = config();
  registered = false;
  if (!window.__TAURI_INTERNALS__) {
    void broadcast();
    return;
  }
  const bindings = c.enabled
    ? [
        { id: 'stop', chord: 'CTRL+ALT+PAUSE' },
        ...c.commands.filter(row => row.hotkey).map(row => ({ id: row.id, chord: row.hotkey }))
      ]
    : [];
  try {
    await native('game_macro_bindings', { bindings: [] });
    if (new Set(bindings.map(b => b.chord)).size !== bindings.length)
      throw new Error('Горячие клавиши повторяются; Ctrl+Alt+Pause зарезервирована для остановки.');
    await native('game_macro_bindings', { bindings });
    registered = c.enabled;
  } catch {
    log('Горячие клавиши не включены: сочетание занято или Windows недоступна. Кнопки остаются доступны.');
  }
  void broadcast();
}
export async function openOverlay() {
  await initGameMacros();
  await native('game_macro_overlay', { topmost: config().topmost });
  await broadcast();
}
export async function windowTargets(command = { target: 'all', action: 'next' }) {
  const { windowRows } = await import('../launcher/windowList.js');
  const { recalledOwnership } = await import('../launcher/launchedWindows.js');
  const clients = await native('launcher_running_details');
  const rows = windowRows(clients, state.characters, {
    recalled: recalledOwnership(clients.map(c => ({ pid: c.pid, uptimeMs: Date.now() - c.startedAt })))
  }).map(r => ({ ...r, ...clients.find(c => c.pid === r.pid) }));
  for (const row of rows) {
    if (state.characters.filter(c => String(c.nick).toLowerCase() === String(row.nick).toLowerCase()).length > 1)
      row.known = false;
  }
  return resolveTargets(state, config(), command, rows);
}
const act = (row, action, extra = {}) =>
  native('game_macro_action', {
    target: { pid: row.pid, startedAt: row.startedAt },
    action,
    key: null,
    rect: null,
    ...extra
  });
export async function saveProfile(name) {
  if (busy) throw new Error('Дождитесь окончания команды.');
  const rows = await windowTargets();
  const windows = [];
  for (const row of rows) windows.push({ charId: row.charId, ...(await act(row, 'geometry')) });
  const c = config(),
    profile = { id: crypto.randomUUID(), name: String(name).slice(0, 80), windows };
  state.settings.gameMacros = { ...c, profiles: [...c.profiles, profile].slice(-10), profileId: profile.id };
}
export async function run(id, hotkey = false) {
  if (id === 'stop') {
    stop();
    return;
  }
  if (busy) {
    log('Предыдущая команда ещё выполняется.');
    return;
  }
  const c = config(),
    command = c.commands.find(r => r.id === id);
  if (!command) return;
  busy = true;
  cancelled = false;
  void broadcast();
  try {
    const rows = await windowTargets(command);
    if (hotkey) {
      let foreground = false;
      for (const row of await windowTargets()) {
        try {
          await act(row, 'foreground');
          foreground = true;
          break;
        } catch {
          /* not this window */
        }
      }
      if (!foreground) {
        log('Горячая команда пропущена: активное окно не относится к выбранной пати.');
        return;
      }
      await wait(250);
    }
    log(`Начало: ${command.name}. Получателей: ${rows.length}.`);
    if (['next', 'previous'].includes(command.action)) {
      const found = rows.findIndex(r => r.charId === cycleId),
        idx = found < 0 && command.action === 'previous' ? 0 : found,
        next = (idx + (command.action === 'next' ? 1 : -1) + rows.length) % rows.length;
      await act(rows[next], 'focus');
      cycleId = rows[next].charId;
      log('Окно переключено.');
      return;
    }
    if (command.action === 'layout') {
      const profile = c.profiles.find(p => p.id === c.profileId);
      if (!profile) throw new Error('no profile');
      for (const row of rows) {
        await wait(50);
        const geometry = profile.windows.find(w => w.charId === row.charId);
        if (!geometry) throw new Error('missing profile member');
        await act(row, 'layout', { rect: geometry });
      }
    } else {
      const sequence = command.action === 'sequence' ? steps(command.sequence) : [];
      for (const [index, row] of rows.entries()) {
        await wait(50);
        await act(row, 'focus');
        if (cancelled) throw new Error('cancel');
        for (const step of sequence) {
          if (step.wait) await wait(step.wait);
          else {
            await wait(80);
            await act(row, 'key', { key: step.key });
          }
        }
        log(`Обработано окон: ${index + 1}/${rows.length}. Ввод отправлен; результат в игре не проверялся.`);
      }
    }
    log('Команда завершена.');
  } catch {
    log(
      cancelled
        ? 'Остановлено пользователем.'
        : 'Остановлено: проверьте ПЛ, привязки окон, профиль, фокус и отпустите клавиши-модификаторы. Повторов и повышения прав нет.'
    );
  } finally {
    busy = false;
    void broadcast();
  }
}
export function openSettings() {
  document.querySelector('.tab[data-tab="tools"]')?.click();
  setTimeout(
    () => document.getElementById('game-macros-block')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    0
  );
}
export async function initGameMacros() {
  if (initialized || !window.__TAURI_INTERNALS__) return;
  initialized = true;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('game-macro-hotkey', event => {
    if (config().enabled && registered) void run(String(event.payload), true);
  });
  await listen('game-overlay-ready', () => {
    void broadcast();
  });
  await listen('game-overlay-action', async event => {
    const action = event.payload;
    if (action === 'stop') stop();
    if (action === 'settings' || action === 'logs') {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const main = getCurrentWindow();
      await main.show();
      await main.unminimize();
      await main.setFocus();
      openSettings();
      if (action === 'logs') setTimeout(() => document.getElementById('game-macro-log')?.scrollIntoView(), 100);
    }
  });
  await configure();
}
