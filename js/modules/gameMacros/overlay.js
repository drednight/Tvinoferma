import { normalizeAppearance, TEXT_PRESETS, KEY_PRESETS, COMMAND_PRESETS } from './appearance.js';
import { listen, emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
async function init() {
  const current = getCurrentWindow();
  await listen('game-macro-snapshot', event => {
    if (event.payload == null) return;
    const data = event.payload;
    const a = normalizeAppearance(data.appearance);
    document.documentElement.style.setProperty('--overlay-text', TEXT_PRESETS[a.textColor]);
    document.documentElement.style.setProperty('--overlay-key', KEY_PRESETS[a.keyColor]);
    document.documentElement.style.setProperty('--overlay-command', COMMAND_PRESETS[a.commandColor]);
    document.documentElement.style.setProperty('--overlay-font', a.fontSize + 'px');
    document.body.classList.toggle('header-hidden', a.hideHeader);
    if (document.getElementById('appearance-screen').hidden) {
      document.getElementById('text-color').value = a.textColor;
      document.getElementById('key-color').value = a.keyColor;
      document.getElementById('command-color').value = a.commandColor;
      document.getElementById('font-size').value = String(a.fontSize);
      document.getElementById('hide-header').checked = a.hideHeader;
    }
    document.documentElement.style.setProperty(
      '--alpha',
      String(Math.max(0.1, Math.min(1, Number(data.opacity) || 0.9)))
    );
    document.getElementById('status').textContent =
      data.notice ||
      (data.mirroring
        ? `Повтор: клавиатура ${(data.mirrorKeys ?? data.mirroring) ? 'ВКЛ' : 'выкл'} · мышь ${data.mirrorMouse ? 'ВКЛ' : 'выкл'} · Ctrl+Alt+Pause — выключить`
        : data.paused
          ? 'Макросы на паузе'
          : data.busy
            ? 'Команда выполняется'
            : data.registered
              ? 'Хоткеи включены'
              : 'Хоткеи выключены / недоступны');
    document.getElementById('commands').replaceChildren(
      ...(data.commands || []).map(row => {
        const li = document.createElement('li'),
          key = document.createElement('kbd');
        const name = document.createElement('span');
        name.textContent = String(row.name || '');
        name.style.minWidth = '0';
        li.append(name);
        key.textContent = String(row.hotkey || 'Кнопка в Инструментах');
        li.append(key);
        return li;
      })
    );
    if (document.getElementById('appearance-screen').hidden || !document.activeElement?.closest('#appearance-screen')) {
      document.getElementById('opacity').value = String(Math.round((data.opacity || 0.9) * 100));
      document.getElementById('alpha-value').textContent = document.getElementById('opacity').value + '%';
      document.getElementById('topmost').checked = data.topmost !== false;
    }
    document.getElementById('logs').replaceChildren(
      ...[...(data.logEntries || (data.logs || []).map(text => ({ text })))].reverse().map(entry => {
        const line = document.createElement('span');
        const text = String(entry.text || ''),
          name = String(entry.commandName || '');
        if (!name) {
          line.textContent = text + '\n';
          return line;
        }
        const label = document.createElement('span');
        label.style.color = 'var(--overlay-command)';
        label.textContent = name;
        const index = text.indexOf(name);
        if (index >= 0)
          line.append(
            document.createTextNode(text.slice(0, index)),
            label,
            document.createTextNode(text.slice(index + name.length))
          );
        else line.append(label, document.createTextNode(` · ${text}`));
        line.append(document.createTextNode('\n'));
        return line;
      })
    );
  });
  const showView = view => {
    document.getElementById('shortcuts-screen').hidden = view !== 'shortcuts';
    document.getElementById('appearance-screen').hidden = view !== 'appearance';
    document.getElementById('journal-screen').hidden = view !== 'journal';
    document.getElementById('back').hidden = view === 'shortcuts';
    document.getElementById('back-hide').hidden = view !== 'journal';
    document.getElementById('back-hide').textContent = '◌';
    document.getElementById('back-hide').title = 'Скрыть кнопку возврата';
  };
  document.querySelectorAll('[data-view]').forEach(button => (button.onclick = () => showView(button.dataset.view)));
  document.getElementById('back-hide').onclick = () => {
    const back = document.getElementById('back');
    back.hidden = !back.hidden;
    const toggle = document.getElementById('back-hide');
    toggle.textContent = back.hidden ? '◉' : '◌';
    toggle.title = back.hidden ? 'Показать кнопку возврата' : 'Скрыть кнопку возврата';
  };
  document.getElementById('back').onclick = () => showView('shortcuts');
  document.getElementById('info-toggle').onclick = () => {
    const controls = document.getElementById('overlay-controls');
    controls.hidden = !controls.hidden;
    document.querySelectorAll('[data-service-heading]').forEach(el => (el.hidden = controls.hidden));
    document.getElementById('info-toggle').setAttribute('aria-expanded', String(!controls.hidden));
  };
  document.getElementById('opacity').oninput = event => {
    document.getElementById('alpha-value').textContent = event.target.value + '%';
    document.documentElement.style.setProperty('--alpha', String(Number(event.target.value) / 100));
  };
  document.getElementById('save-appearance').onclick = async () => {
    const button = document.getElementById('save-appearance');
    button.disabled = true;
    try {
      await invoke('game_macro_overlay_preferences', {
        opacity: Number(document.getElementById('opacity').value) / 100,
        topmost: document.getElementById('topmost').checked,
        appearance: normalizeAppearance({
          textColor: document.getElementById('text-color').value,
          keyColor: document.getElementById('key-color').value,
          commandColor: document.getElementById('command-color').value,
          fontSize: document.getElementById('font-size').value,
          hideHeader: document.getElementById('hide-header').checked
        })
      });
      document.getElementById('appearance-error').textContent = 'Настройки применены.';
    } catch {
      document.getElementById('appearance-error').textContent = 'Не удалось применить настройки.';
    } finally {
      button.disabled = false;
    }
  };
  document.querySelectorAll('[data-action]').forEach(button => {
    button.onclick = async () => {
      try {
        await invoke('game_macro_navigate', { action: button.dataset.action });
      } catch {
        document.getElementById('status').textContent = 'Не удалось выполнить действие. Откройте главное окно из трея.';
      }
    };
  });
  document.querySelector('[data-drag]').onpointerdown = event => {
    if (event.button === 0 && !event.target.closest('button')) void current.startDragging();
  };
  let collapsed = false;
  const fold = document.getElementById('fold');
  fold.onclick = async () => {
    fold.disabled = true;
    try {
      await invoke('game_macro_overlay_fold', { collapsed: !collapsed });
      collapsed = !collapsed;
      document.body.classList.toggle('folded', collapsed);
      fold.setAttribute('aria-expanded', String(!collapsed));
      fold.title = collapsed ? 'Развернуть оверлей' : 'Свернуть до верхней полосы';
      fold.setAttribute('aria-label', fold.title);
      fold.textContent = collapsed ? '▾' : '▴';
    } catch {
      document.getElementById('status').textContent = 'Не удалось изменить размер оверлея.';
    } finally {
      fold.disabled = false;
    }
  };
  document.getElementById('close').onclick = () => current.close();
  await emitTo('main', 'game-overlay-ready', null);
}
void init().catch(() => {
  document.getElementById('status').textContent = 'Оверлей доступен в настольном приложении.';
});
