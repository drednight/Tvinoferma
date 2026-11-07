import { toast } from '../../core/ui.js';
import { state } from '../../core/state.js';
import { mountActionWidget } from './actionWidget.js';
import { mountWindowsWidget } from './windowsWidget.js';
import { mountNotes } from './notesWidget.js';
import { ACTION_WIDGETS } from './widgetCatalog.js';
export function ensureActionWidgets(root, editing = false) {
  const board = root.querySelector('.rt-board');
  if (!board) return;
  for (const [id, title, description, action, icon] of ACTION_WIDGETS) {
    if (root.querySelector(`.rt-${id}`)) continue;
    const panel = document.createElement('section');
    panel.className = `lg-panel rt-${id} rt-action-widget`;
    panel.hidden = true;
    const heading = document.createElement('h3');
    heading.className = 'rt-heading';
    heading.textContent = `${icon} ${title}`;
    const text = document.createElement('p');
    text.textContent = description;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = action.startsWith('check-') || action.startsWith('update-') ? 'Запустить проверку' : 'Открыть';
    let widget;
    if (action === 'update-marathons') button.textContent = 'Обновить все марафоны';
    button.disabled = editing;
    button.onclick = async () => {
      if (editing) return;
      button.disabled = true;
      try {
        if (['check-auth', 'update-balance'].includes(action)) {
          const selected = [...(widget?.selectedCharacters() || state.characters)];
          const sync = await import('../sync/syncManager.js');
          await (action === 'check-auth' ? sync.refreshAllLoginStatuses : sync.refreshAllBalances)(selected);
          return;
        }
        const { createCommandRunner } = await import('../../core/commandRunner.js');
        await createCommandRunner({ switchTab: tab => document.querySelector(`.tab[data-tab="${tab}"]`)?.click() })(
          action
        );
      } catch {
        toast('Не удалось открыть или выполнить сценарий. Проверьте журнал скриптов.', 'error');
      } finally {
        button.disabled = false;
      }
    };
    if (action === 'windows') {
      panel.append(heading);
      mountWindowsWidget(panel, editing);
    } else if (action === 'notes') {
      panel.append(heading);
      mountNotes(panel, editing);
    } else {
      panel.append(heading, text);
      widget = mountActionWidget(panel, action, editing);
      panel.append(button);
    }
    board.append(panel);
  }
}
