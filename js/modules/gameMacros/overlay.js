import { leaderSuggestion } from './recipients.js';
import { confirmModal } from '../../core/ui.js';
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
  let acknowledgedOpen = '';
  let windowSignature = '';
  let recipientRevision = '',
    recipientDirty = false,
    recipientsPending = false;
  const recipientNotice = document.getElementById('recipients-notice');
  const recipientList = document.getElementById('recipient-list');
  const recipientLeader = document.getElementById('recipient-leader');
  let recipientOptions = [];
  const updateLeaderHint = () => {
    const selected = new Set([...recipientList.querySelectorAll('input:checked')].map(input => input.value));
    const { suggestion, tie } = leaderSuggestion(recipientOptions, selected);
    document.getElementById('recipient-leader-hint').textContent =
      (suggestion
        ? `Подсказка: ${suggestion.name} — ${suggestion.count} выбранных окон. `
        : tie
          ? 'В нескольких пати поровну окон — выберите ПЛ вручную. '
          : '') +
      'ПЛ используется только в специальных командах. Выбор меняет управляющую пати, но не лидерство в игре. Обычные команды не требуют ПЛ.';
  };
  async function recipientRequest(payload) {
    if (recipientsPending) return;
    recipientsPending = true;
    recipientNotice.textContent = 'Ожидаем главное окно…';
    document.getElementById('recipients-save').disabled = true;
    try {
      await emitTo('main', 'game-overlay-recipients', payload);
    } catch {
      recipientsPending = false;
      recipientNotice.textContent = 'Не удалось связаться с главным окном.';
    }
  }
  let refreshConfirmationOpen = false;
  document.getElementById('recipients-refresh').onclick = async () => {
    if (refreshConfirmationOpen || recipientsPending) return;
    refreshConfirmationOpen = true;
    try {
      if (
        recipientDirty &&
        !(await confirmModal({
          title: 'Обновить список?',
          text: 'Несохранённые изменения будут отменены.',
          okText: 'Обновить',
          danger: true
        }))
      )
        return;
      void recipientRequest({ action: 'refresh' });
    } finally {
      refreshConfirmationOpen = false;
    }
  };
  for (const [id, checked] of [
    ['recipients-all', true],
    ['recipients-none', false]
  ])
    document.getElementById(id).onclick = () => {
      recipientList.querySelectorAll('input').forEach(input => {
        input.checked = checked;
      });
      recipientDirty = true;
      updateLeaderHint();
    };
  recipientList.onchange = () => {
    recipientDirty = true;
    updateLeaderHint();
  };
  recipientLeader.onchange = () => {
    recipientDirty = true;
  };
  document.getElementById('recipients-save').onclick = () => {
    const option = recipientLeader.selectedOptions[0];
    const leader = option?.dataset.partyId ? { partyId: option.dataset.partyId, charId: option.dataset.charId } : null;
    void recipientRequest({
      action: 'save',
      revision: recipientRevision,
      selected: [...recipientList.querySelectorAll('input:checked')].map(input => input.value),
      leader
    });
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
    pauseButton.dataset.state = data.paused ? 'paused' : 'on';
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
    if (!data.busy) recipientsPending = false;
    if (data.recipientNotice) recipientNotice.textContent = data.recipientNotice;
    const recipients = data.recipients;
    if ((recipients?.revision || '') !== recipientRevision) {
      recipientRevision = recipients?.revision || '';
      recipientDirty = false;
      recipientList.replaceChildren(
        ...(recipients?.rows || []).map(row => {
          const li = document.createElement('li'),
            label = document.createElement('label');
          const input = document.createElement('input'),
            text = document.createElement('span');
          input.type = 'checkbox';
          input.value = row.charId;
          input.checked = row.selected;
          text.textContent = row.nick + (row.valid ? '' : ' · проверьте окно и права');
          label.append(input, text);
          li.append(label);
          return li;
        })
      );
      const current = recipients?.currentLeader;
      recipientLeader.replaceChildren(
        new Option(current ? `Не менять: ${current.nick} — ${current.partyName}` : 'Не назначать ПЛ', '')
      );
      for (const [index, choice] of (recipients?.options || []).entries()) {
        const option = new Option(
          `${choice.nick} — ${choice.partyName}${choice.current ? ' · ПЛ пати' : ''}`,
          String(index + 1)
        );
        option.dataset.partyId = choice.partyId;
        option.dataset.charId = choice.charId;
        recipientLeader.add(option);
      }
      recipientOptions = recipients?.options || [];
      updateLeaderHint();
    }
    for (const id of ['recipients-save', 'recipients-all', 'recipients-none'])
      document.getElementById(id).disabled = !!data.busy || recipientsPending || !recipientRevision;
    document.getElementById('recipients-refresh').disabled = !!data.busy || recipientsPending;
    recipientLeader.disabled = !!data.busy || recipientsPending || !recipientRevision;
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
    const signature = JSON.stringify(data.windows || []);
    if (windowSignature !== signature) {
      windowSignature = signature;
      document.getElementById('windows').replaceChildren(
        ...(data.windows || []).map(row => {
          const li = document.createElement('li');
          li.className = 'wrow';
          const icon = document.createElement('span');
          icon.className = 'wicon';
          icon.textContent = row.icon || '🖥';
          const wrap = document.createElement('span');
          wrap.className = 'pwrap';
          const pname = document.createElement('span');
          pname.className = 'pname';
          pname.textContent = row.name;
          const pmeta = document.createElement('span');
          pmeta.className = 'pmeta';
          pmeta.textContent = `PID ${row.pid}${row.known ? ` · ${{ manual: 'ручная привязка', title: 'из заголовка', launcher: 'запуск Твинофермой' }[row.ownershipSource] || 'распознано'}` : ' · не распознано'}`;
          wrap.append(pname, pmeta);
          const rebind = document.createElement('button');
          rebind.type = 'button';
          rebind.className = 'wpin';
          rebind.textContent = '🏷';
          rebind.title = 'Переподключить окно и сменить иконку';
          rebind.setAttribute('aria-label', rebind.title);
          rebind.disabled = !row.pid;
          rebind.onclick = async () => {
            rebind.disabled = true;
            try {
              await emitTo('main', 'game-overlay-rebind', { pid: row.pid, hwnd: row.hwnd, startedAt: row.startedAt });
              const icons = ['🖥', '🪟', '🖥'];
              const next = icons[(icons.indexOf(icon.textContent) + 1) % icons.length];
              icon.textContent = icon.textContent === next ? '🪟' : next;
            } catch {
              document.getElementById('status').textContent = 'Не удалось переподключить окно.';
            } finally {
              rebind.disabled = false;
            }
          };
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.dataset.closeWindow = '';
          checkbox.value = JSON.stringify({ pid: row.pid, startedAt: row.startedAt, hwnd: row.hwnd });
          checkbox.disabled = !row.startedAt || !row.hwnd;
          checkbox.setAttribute('aria-label', `Выбрать окно ${row.name}, PID ${row.pid}`);
          li.prepend(checkbox);
          li.append(icon, wrap, rebind);
          return li;
        })
      );
    }
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
        const li = document.createElement('li');
        li.className = 'cmd';
        const key = document.createElement('kbd');
        key.textContent = String(row.hotkey || 'Не назначена');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = String(row.name || '');
        name.style.minWidth = '0';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'cmd-del';
        del.textContent = '✕';
        del.title = `Удалить: ${row.name || 'команда'}`;
        del.setAttribute('aria-label', del.title);
        del.disabled = !row.id;
        del.onclick = async event => {
          event.stopPropagation();
          if (!row.id) return;
          del.disabled = true;
          try {
            await emitTo('main', 'game-overlay-delete', row.id);
          } catch {
            document.getElementById('status').textContent = 'Не удалось удалить команду.';
          } finally {
            del.disabled = false;
          }
        };
        li.append(key, name, del);
        li.onclick = async () => {
          if (!row.id || (!!data.busy && !row.allowWhileBusy)) return;
          try {
            await emitTo('main', 'game-overlay-run', row.id);
          } catch {
            document.getElementById('status').textContent = 'Не удалось отправить запрос запуска команды.';
          }
        };
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
    if (data.overlayOpenRequest && acknowledgedOpen !== data.overlayOpenRequest) {
      acknowledgedOpen = data.overlayOpenRequest;
      void emitTo('main', 'game-overlay-opened', { requestId: acknowledgedOpen }).catch(() => {
        acknowledgedOpen = '';
        document.getElementById('status').textContent = 'Не удалось подтвердить связь с главным окном.';
      });
    }
  });
  const viewLabels = {
    shortcuts: 'Комбинации',
    recipients: 'Получатели',
    party: 'Партия',
    journal: 'Журнал',
    appearance: 'Настройки'
  };
  const closeMenu = () => {
    const menu = document.getElementById('menu');
    if (menu) menu.hidden = true;
  };
  const showView = view => {
    for (const id of ['shortcuts', 'journal', 'party', 'appearance', 'recipients'])
      document.getElementById(`${id}-screen`).hidden = id !== view;
    const where = document.getElementById('where');
    if (where) where.textContent = viewLabels[view] || view;
    if (view === 'party') void partyRequest('party-refresh');
    if (view === 'recipients' && !recipientRevision) void recipientRequest({ action: 'refresh' });
    document.querySelectorAll('[data-view]').forEach(button => {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    closeMenu();
  };
  document.querySelectorAll('[data-view]').forEach(button => (button.onclick = () => {
    if (button.dataset.view === '__fold') { void foldClick(); return; }
    showView(button.dataset.view);
  }));
  const handleMenuAction = action => {
    if (action === 'toggle-menu') document.getElementById('menu-btn')?.click();
    else if (action === 'ghost') document.getElementById('ghost')?.click();
    else if (action === 'fold') document.getElementById('fold')?.click();
    else if (action === 'hide-header') {
      const hh = document.getElementById('hide-header');
      if (hh) { hh.checked = !hh.checked; hh.dispatchEvent(new Event('change')); }
    } else if (action === 'close') document.getElementById('close')?.click();
  };
  document.querySelectorAll('[data-menu-action]').forEach(button => (button.onclick = () => {
    closeMenu();
    handleMenuAction(button.dataset.menuAction);
  }));
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
  const colorPresets = {
    'text-color': TEXT_PRESETS,
    'key-color': KEY_PRESETS,
    'command-color': COMMAND_PRESETS
  };
  document.querySelectorAll('.color-options input[type=radio]').forEach(
    input =>
      (input.onchange = () => {
        const id = input.name.replace('-choice', '');
        document.getElementById(id).value = input.value;
        const value = colorPresets[id]?.[input.value];
        if (value) document.documentElement.style.setProperty('--overlay-' + id.replace('-color', ''), value);
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
  const partyRequest = async (action, options = {}) => {
    if (partyBusy) return;
    partyBusy = true;
    document.getElementById('party-launch').disabled = true;
    document.getElementById('party-refresh').disabled = true;
    document.getElementById('party-close-all').disabled = true;
    try {
      await invoke('game_macro_navigate', {
        action,
        partyId: document.getElementById('party-select').value || null,
        ...options
      });
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
  const closeButton = document.getElementById('party-close-all');
  const closeDropdown = document.getElementById('close-dropdown');
  const closeWindows = mode => {
    if (mode === 'all') { void partyRequest('party-close-all'); return; }
    const closeTargets = [
      ...document.querySelectorAll(
        mode === 'selected' ? '[data-close-window]:checked' : '[data-close-window]:not(:disabled)'
      )
    ].map(input => JSON.parse(input.value));
    if (!closeTargets.length) {
      document.getElementById('window-notice').textContent =
        'Отметьте актуальные окна в списке. Для режима «кроме ПЛ» сначала обновите окна.';
      return;
    }
    void partyRequest('party-close-all', { closeMode: mode, closeTargets });
  };
  if (closeButton && closeDropdown) {
    closeButton.onclick = event => {
      event.stopPropagation();
      const open = closeDropdown.hidden;
      closeDropdown.hidden = !open;
      closeButton.setAttribute('aria-expanded', String(open));
    };
    closeDropdown.querySelectorAll('[data-close-mode]').forEach(option => {
      option.onclick = () => {
        closeDropdown.hidden = true;
        closeButton.setAttribute('aria-expanded', 'false');
        closeWindows(option.dataset.closeMode);
      };
    });
    document.addEventListener('click', event => {
      if (closeDropdown.hidden) return;
      if (!event.target.closest('.close-wrap')) closeDropdown.hidden = true;
    });
  }
  document.getElementById('party-refresh').onclick = () => partyRequest('party-refresh');
  const menuBtn = document.getElementById('menu-btn');
  const menu = document.getElementById('menu');
  const toggleMenu = () => {
    const open = menu.hidden;
    menu.hidden = !open;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
  };
  if (menuBtn) menuBtn.onclick = toggleMenu;
  const floatingPanelToggle = document.getElementById('floating-panel-toggle');
  if (floatingPanelToggle) floatingPanelToggle.onclick = () => { menu.hidden = false; };
  document.addEventListener('click', event => {
    if (menu.hidden) return;
    const target = event.target;
    if (target.closest('#menu') || target.closest('#menu-btn') || target.closest('#floating-panel-toggle')) return;
    closeMenu();
  });

  const hideHeader = document.getElementById('hide-header');
  if (hideHeader) hideHeader.onchange = event => document.body.classList.toggle('header-hidden', event.target.checked);

  const themeGrid = document.getElementById('theme-grid');
  if (themeGrid) {
    themeGrid.onclick = event => {
      const opt = event.target.closest('[data-theme]');
      if (!opt) return;
      document.documentElement.setAttribute('data-theme', opt.dataset.theme);
      themeGrid.querySelectorAll('.theme-opt').forEach(o => o.classList.toggle('sel', o === opt));
    };
  }
  const sizeGrid = document.getElementById('size-grid');
  if (sizeGrid) {
    sizeGrid.onclick = event => {
      const opt = event.target.closest('[data-size]');
      if (!opt) return;
      const size = opt.dataset.size;
      document.documentElement.setAttribute('data-size', size);
    };
  }
  const ghost = document.getElementById('ghost');
  let ghostPrevAlpha = null;
  if (ghost) {
    ghost.onclick = () => {
      const ov = document.getElementById('ov');
      const on = ghost.classList.toggle('on');
      if (ov) ov.classList.toggle('ghost', on);
      if (on) {
        ghostPrevAlpha = Number(getComputedStyle(document.documentElement).getPropertyValue('--alpha')) || 0.9;
        document.documentElement.style.setProperty('--alpha', '0.12');
        ghost.title = 'Призрачный режим: почти прозрачно (клик — вернуть)';
      } else {
        document.documentElement.style.setProperty('--alpha', String(ghostPrevAlpha != null ? ghostPrevAlpha : 0.9));
        ghost.title = 'Призрачный режим (почти прозрачно)';
      }
      ghost.setAttribute('aria-label', ghost.title);
    };
  }
  document.getElementById('opacity').oninput = event => {
    document.getElementById('alpha-value').textContent = event.target.value + '%';
    document.documentElement.style.setProperty('--alpha', String(Number(event.target.value) / 100));
  };
  document.getElementById('font-size').oninput = event => {
    document.getElementById('font-size-out').textContent = event.target.value + 'px';
    document.documentElement.style.setProperty('--overlay-font', event.target.value + 'px');
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
  document.getElementById('resize-handle').onpointerdown = event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (current && typeof current.startResizeDragging === 'function') {
      current.startResizeDragging('SouthEast');
    }
  };
  let collapsed = false;
  const fold = document.getElementById('fold');
  async function foldClick() {
    fold.disabled = true;
    try {
      await invoke('game_macro_overlay_fold', { collapsed: !collapsed });
      collapsed = !collapsed;
      document.body.classList.toggle('folded', collapsed);
      fold.setAttribute('aria-expanded', String(!collapsed));
      fold.title = collapsed ? 'Развернуть оверлей' : 'Свернуть до кнопок';
      fold.setAttribute('aria-label', fold.title);
      fold.textContent = collapsed ? '▴' : '▾';
    } catch {
      document.getElementById('status').textContent = 'Не удалось изменить размер оверлея.';
    } finally {
      fold.disabled = false;
    }
  }
  fold.onclick = foldClick;
  document.getElementById('close').onclick = () => current.close();
  await emitTo('main', 'game-overlay-ready', null);
}
void init().catch(() => {
  document.getElementById('status').textContent = 'Оверлей доступен в настольном приложении.';
});
