import { state } from '../../core/state.js';
import { isTauri } from '../../core/storage.js';
import { confirmModal, toast } from '../../core/ui.js';
import { windowRows, closeSelectedText } from '../launcher/windowList.js';
import { recalledOwnership } from '../launcher/launchedWindows.js';
export function mountWindowsWidget(panel, editing) {
  const content = document.createElement('div'),
    refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn';
  refresh.textContent = 'Обновить окна';
  panel.append(refresh, content);
  const load = async () => {
    if (editing) {
      content.textContent = 'Список игровых окон с кнопками «Вид» и «Закрыть».';
      return;
    }
    if (!isTauri()) {
      content.textContent = 'Список доступен в настольном приложении.';
      return;
    }
    refresh.disabled = true;
    try {
      const api = await import('../launcher/launch.js'),
        clients = await api.runningClientDetails();
      if (!panel.isConnected) return;
      const rows = windowRows(clients, state.characters, {
        recalled: recalledOwnership(
          clients.map(c => ({ pid: c.pid, uptimeMs: c.startedAt ? Date.now() - c.startedAt : null }))
        )
      });
      content.replaceChildren();
      if (!rows.length) content.textContent = 'Запущенных клиентов нет.';
      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'rt-window-inline';
        const name = document.createElement('b');
        name.textContent = row.nick || `PID ${row.pid}`;
        const style = document.createElement('button'),
          close = document.createElement('button');
        style.type = close.type = 'button';
        style.className = 'btn ghost';
        close.className = 'btn danger';
        style.textContent = '✎ Вид';
        close.textContent = 'Закрыть';
        style.onclick = async () => {
          await (await import('../launcher/windowPicker.js')).openStyleDialog(row, load);
        };
        close.onclick = async () => {
          if (
            !(await confirmModal({
              title: 'Закрыть игровое окно?',
              text: `${row.nick || 'Клиент'} · PID ${row.pid}`,
              okText: 'Закрыть'
            }))
          )
            return;
          close.disabled = true;
          try {
            const fresh = await api.runningClientDetails();
            const original = clients.find(c => c.pid === row.pid);
            if (!original?.startedAt || !fresh.some(c => c.pid === row.pid && c.startedAt === original.startedAt)) {
              toast('Окно изменилось или не удалось проверить время запуска. Обновите список.', 'warning');
              await load();
              return;
            }
            const report = await api.closeClientsByPid([row.pid]);
            toast(closeSelectedText(report), report?.failed || report?.error ? 'error' : 'success');
            await load();
          } catch {
            close.disabled = false;
            content.append(document.createTextNode(' Не удалось проверить или закрыть окно.'));
          } finally {
            close.disabled = false;
          }
        };
        line.append(name, style, close);
        content.append(line);
      }
    } catch {
      content.textContent = 'Не удалось прочитать список окон.';
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.disabled = editing;
  refresh.onclick = load;
  queueMicrotask(() => {
    if (panel.isConnected && !panel.hidden) void load();
  });
}
