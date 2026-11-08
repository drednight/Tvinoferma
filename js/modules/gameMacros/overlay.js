import { updateRepeatButton } from './repeatButton.js';
import { copyJournal } from './journal.js';
import { normalizeAppearance, TEXT_PRESETS, KEY_PRESETS, COMMAND_PRESETS } from './appearance.js';
import { listen, emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
async function init() {
  const current = getCurrentWindow();
  let latestLaunch = null;
  const renderElapsed = () => {
    const launch = latestLaunch;
    if (!launch?.stageStartedAt) {
      document.getElementById('launch-elapsed').textContent = '';
      return;
    }
    const seconds = Math.max(0, Math.floor(((launch.finishedAt || Date.now()) - launch.stageStartedAt) / 1000));
    document.getElementById('launch-elapsed').textContent =
      `Время этапа: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  setInterval(renderElapsed, 1000);
  let journalLines = [];
  let repeatState = {};
  const keyboardToggle = document.getElementById('keyboard-repeat-toggle');
  const keyboardDisabled = () =>
    !!repeatState.mirrorPending || ((!!repeatState.busy || !!repeatState.paused) && !repeatState.mirrorKeys);
  keyboardToggle.onclick = async () => {
    keyboardToggle.disabled = true;
    try {
      await emitTo('main', 'game-overlay-keyboard-toggle', { enabled: !repeatState.mirrorKeys });
    } catch {
      document.getElementById('status').textContent = 'Не удалось отправить запрос повтора клавиатуры.';
    } finally {
      keyboardToggle.disabled = keyboardDisabled();
    }
  };
  const mouseToggle = document.getElementById('mouse-repeat-toggle');
  const mouseDisabled = () =>
    !!repeatState.mirrorPending || ((!!repeatState.busy || !!repeatState.paused) && !repeatState.mirrorMouse);
  mouseToggle.onclick = async () => {
    mouseToggle.disabled = true;
    try {
      await emitTo('main', 'game-overlay-mouse-toggle', { enabled: !repeatState.mirrorMouse });
    } catch {
      document.getElementById('status').textContent = 'Не удалось отправить запрос повтора мыши.';
    } finally {
      mouseToggle.disabled = mouseDisabled();
    }
  };
  const hotkeysToggle = document.getElementById('hotkeys-toggle');
  let hotkeysPending = false;
  const hotkeysDisabled = () => hotkeysPending || !!repeatState.busy || !!repeatState.mirrorPending;
  hotkeysToggle.onclick = async () => {
    hotkeysPending = true;
    hotkeysToggle.disabled = true;
    try {
      await emitTo('main', 'game-overlay-hotkeys-toggle', { enabled: !repeatState.hotkeysEnabled });
    } catch {
      document.getElementById('status').textContent = 'Не удалось изменить сочетания клавиш.';
    } finally {
      hotkeysPending = false;
      hotkeysToggle.disabled = hotkeysDisabled();
    }
  };
  const pauseButton = document.getElementById('pause-macros');
  pauseButton.onclick = () =>
    emitTo('main', 'game-overlay-pause').catch(() => {
      document.getElementById('status').textContent = 'Не удалось изменить паузу.';
    });
  const reconnectButton = document.getElementById('reconnect-input');
  reconnectButton.onclick = async () => {
    reconnectButton.disabled = true;
    try {
      await emitTo('main', 'game-overlay-reconnect');
    } catch {
      document.getElementById('status').textContent = 'Не удалось отправить запрос подключения ввода.';
    } finally {
      reconnectButton.disabled = !!repeatState.busy || !!repeatState.mirrorPending;
    }
  };
  const copyButton = document.getElementById('copy-logs'),
    journal = document.getElementById('journal-screen'),
    copyStatus = document.getElementById('copy-logs-status');
  copyButton.onclick = async () => {
    copyButton.disabled = true;
    try {
      await copyJournal(journalLines, journal, copyStatus);
    } finally {
      copyButton.disabled = false;
    }
  };
  await listen('game-macro-snapshot', event => {
    if (event.payload == null) return;
    const data = event.payload;
    repeatState = data;
    const hotkeysOn = !!data.hotkeysEnabled;
    const hotkeysConflict = hotkeysOn && (!data.registered || data.hotkeyFailures?.length);
    hotkeysToggle.textContent = `Сочетания: ${hotkeysOn ? 'ВКЛ' : 'ВЫКЛ'}`;
    hotkeysToggle.dataset.state = hotkeysConflict ? 'paused' : hotkeysOn ? 'on' : 'off';
    hotkeysToggle.setAttribute('aria-pressed', String(hotkeysOn));
    hotkeysToggle.title = `${hotkeysOn ? 'Выключить' : 'Включить'} сочетания клавиш${hotkeysConflict ? ' · есть незарегистрированные сочетания, см. журнал' : ''}`;
    hotkeysToggle.setAttribute('aria-label', hotkeysToggle.title);
    hotkeysToggle.disabled = hotkeysDisabled();

    pauseButton.textContent = data.paused ? '▶ Продолжить' : 'Ⅱ Пауза';
    pauseButton.setAttribute('aria-pressed', String(!!data.paused));
    reconnectButton.disabled = !!data.busy || !!data.mirrorPending;
    updateRepeatButton(keyboardToggle, 'keyboard', data);
    keyboardToggle.disabled = keyboardDisabled();
    document.getElementById('party-close-all').disabled = !!data.busy;
    updateRepeatButton(mouseToggle, 'mouse', data);
    mouseToggle.disabled = mouseDisabled();
    journalLines = Array.isArray(data.logs)
      ? data.logs.slice()
      : Array.isArray(data.logEntries)
        ? data.logEntries.map(entry => String(entry.text || ''))
        : [];
    if (!journalLines.length) {
      journal.querySelector('[data-gm-journal-copy-fallback]')?.remove();
      copyStatus.textContent = '';
    }
    const partySelect = document.getElementById('party-select'),
      selected = partySelect.value || data.partyId;
    partySelect.replaceChildren(
      new Option('Выберите пати', ''),
      ...(data.parties || []).map(p => new Option(p.name, p.id))
    );
    partySelect.value = selected || '';
    document.getElementById('party-launch').disabled = !!data.busy || !partySelect.value;
    document.getElementById('party-refresh').disabled = !!data.busy;
    document.getElementById('window-notice').textContent = data.windowNotice || 'Нажмите «Обновить окна».';
    document.getElementById('windows').replaceChildren(
      ...(data.windows || []).map(row => {
        const li = document.createElement('li');
        li.textContent = `${row.name} · PID ${row.pid}${row.known ? ` · ${{ manual: 'ручная привязка', title: 'из заголовка', launcher: 'запуск Твинофермой' }[row.ownershipSource] || 'распознано'}` : ' · не распознано'}`;
        return li;
      })
    );
    const launch = data.launchProgress;
    latestLaunch = launch;
    renderElapsed();
    document.getElementById('launch-progress').hidden = !launch;
    if (launch) {
      document.getElementById('launch-character').hidden = !launch.character;
      document.getElementById('launch-character').textContent = launch.character
        ? `Сейчас: ${launch.character.nick}`
        : '';
      const result = document.getElementById('launch-result');
      result.hidden = launch.status === 'running' || !launch.counts;
      result.textContent = launch.counts
        ? `Запущено: ${launch.counts.launched} · Уже работало: ${launch.counts.alreadyRunning} · Ошибка: ${launch.counts.failed} · Отменено: ${launch.counts.cancelled} · Пропущено: ${launch.counts.skipped}`
        : '';
      document.getElementById('launch-percent').value = launch.percent;
      document.getElementById('launch-stage').textContent =
        `${launch.percent}% · ${launch.stage}${launch.total ? ` · ${launch.done}/${launch.total}` : ''}`;
    }
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
      for (const id of ['text-color', 'key-color', 'command-color'])
        document
          .querySelectorAll(`[name="${id}-choice"]`)
          .forEach(input => (input.checked = input.value === document.getElementById(id).value));
      document.getElementById('font-size').value = String(a.fontSize);
      document.getElementById('hide-header').checked = a.hideHeader;
    }
    document.documentElement.style.setProperty(
      '--alpha',
      String(Math.max(0.1, Math.min(1, Number(data.opacity) || 0.9)))
    );
    document.getElementById('status').dataset.executionState = data.executionState || 'idle';
    document.getElementById('status').textContent =
      data.notice ||
      (data.mirroring
        ? `Повтор: клавиатура ${(data.mirrorKeys ?? data.mirroring) ? 'ВКЛ' : 'выкл'} · мышь ${data.mirrorMouse ? 'ВКЛ' : 'выкл'} · Ctrl+Alt+Pause — выключить`
        : data.paused
          ? 'Макросы на паузе'
          : data.busy
            ? `Выполняется: ${data.runningName || 'команда'}`
            : data.hotkeyFailures?.length
              ? `Конфликт сочетаний: ${data.hotkeyFailures.join(', ')} · переподключите ввод`
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
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'command-run';
        play.textContent = '▶';
        play.title = `Запустить: ${row.name || 'команда'}`;
        play.setAttribute('aria-label', play.title);
        play.disabled = !row.id || (!!data.busy && !row.allowWhileBusy);
        play.onclick = async () => {
          play.disabled = true;
          try {
            await emitTo('main', 'game-overlay-run', row.id);
          } catch {
            document.getElementById('status').textContent = 'Не удалось отправить запрос запуска команды.';
          } finally {
            play.disabled = !row.id || (!!data.busy && !row.allowWhileBusy);
          }
        };
        li.append(play, name);
        key.textContent = String(row.hotkey || 'Не назначена');
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
        if (entry.terminal) line.className = 'gm-log-terminal';
        const text = String(entry.text || ''),
          name = String(entry.commandName || '');
        if (!name) {
          line.textContent = text + '\n';
          return line;
        }
        const label = document.createElement('span');
        label.style.color = entry.terminal ? 'var(--danger, #f7768e)' : 'var(--overlay-command)';
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
    for (const id of ['shortcuts', 'journal', 'party', 'appearance'])
      document.getElementById(`${id}-screen`).hidden = id !== view;
    if (view === 'party') void partyRequest('party-refresh');
    document.querySelectorAll('[data-view]').forEach(button => {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  };
  document.querySelectorAll('[data-view]').forEach(button => (button.onclick = () => showView(button.dataset.view)));
  const extraNames = {
    pink: 'Розовый',
    cyan: 'Бирюзовый',
    lime: 'Лаймовый',
    coral: 'Коралловый',
    silver: 'Серебристый',
    lavender: 'Лавандовый'
  };
  for (const id of ['text-color', 'key-color', 'command-color']) {
    const fieldset = document.getElementById(id).closest('fieldset');
    for (const [value, name] of Object.entries(extraNames)) {
      const label = document.createElement('label'),
        input = document.createElement('input'),
        span = document.createElement('span');
      input.type = 'radio';
      input.name = `${id}-choice`;
      input.value = value;
      span.textContent = name;
      label.append(input, span);
      fieldset.append(label);
    }
  }
  document.querySelectorAll('.color-options input[type=radio]').forEach(
    input =>
      (input.onchange = () => {
        document.getElementById(input.name.replace('-choice', '')).value = input.value;
      })
  );
  for (const [id, colors] of Object.entries({
    'text-color': TEXT_PRESETS,
    'key-color': KEY_PRESETS,
    'command-color': COMMAND_PRESETS
  }))
    document
      .querySelectorAll(`[name="${id}-choice"]`)
      .forEach(input => (input.nextElementSibling.style.color = colors[input.value]));
  let partyBusy = false;
  document.getElementById('party-launch').disabled = true;
  const partyRequest = async action => {
    if (partyBusy) return;
    partyBusy = true;
    document.getElementById('party-launch').disabled = true;
    document.getElementById('party-refresh').disabled = true;
    document.getElementById('party-close-all').disabled = true;
    try {
      await invoke('game_macro_navigate', { action, partyId: document.getElementById('party-select').value || null });
    } catch {
      document.getElementById('window-notice').textContent =
        'Не удалось отправить запрос. Откройте главное приложение.';
      document.getElementById('party-refresh').disabled = false;
      document.getElementById('party-close-all').disabled = false;
      document.getElementById('party-launch').disabled = !document.getElementById('party-select').value;
    } finally {
      partyBusy = false;
    }
  };
  document.getElementById('party-select').onchange = () =>
    (document.getElementById('party-launch').disabled = partyBusy || !document.getElementById('party-select').value);
  document.getElementById('party-launch').onclick = () => partyRequest('party-launch');
  document.getElementById('party-close-all').onclick = () => {
    document.getElementById('close-confirm').hidden = false;
  };
  document.getElementById('close-confirm-no').onclick = () => {
    document.getElementById('close-confirm').hidden = true;
  };
  document.getElementById('close-confirm-yes').onclick = () => {
    document.getElementById('close-confirm').hidden = true;
    return partyRequest('party-close-all');
  };
  document.getElementById('party-refresh').onclick = () => partyRequest('party-refresh');
  const togglePanel = () => {
    const controls = document.getElementById('overlay-controls');
    controls.hidden = !controls.hidden;
    document.querySelectorAll('[data-service-heading]').forEach(el => (el.hidden = controls.hidden));
    for (const id of ['info-toggle', 'floating-panel-toggle'])
      document.getElementById(id).setAttribute('aria-expanded', String(!controls.hidden));
  };
  document.getElementById('info-toggle').onclick = togglePanel;
  document.getElementById('floating-panel-toggle').onclick = togglePanel;
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
