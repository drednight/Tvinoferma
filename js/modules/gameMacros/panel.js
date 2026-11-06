import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { toast, showModal } from '../../core/ui.js';
import { normalizeGameMacros, partyMembers } from './model.js';
import { commandLabels, openCommandEditor } from './editor.js';
import {
  config,
  configure,
  initGameMacros,
  snapshot,
  openOverlay,
  run,
  stop,
  saveProfile,
  pickPoint,
  previewCommand,
  showSize
} from './runtime.js';
let activeHost,
  selectedId = '',
  selectedPointId = '',
  updateListener;
const safe = fn => async event => {
  try {
    await fn(event);
  } catch (error) {
    toast(error?.message || 'Действие не выполнено.', 'error');
  }
};
async function save(patch) {
  const previous = state.settings.gameMacros;
  state.settings.gameMacros = normalizeGameMacros({ ...config(), ...patch });
  try {
    await persist();
  } catch (error) {
    state.settings.gameMacros = previous;
    throw error;
  }
  await configure();
  if (activeHost?.isConnected) mountGameMacros(activeHost);
}
const option = (id, name, selected) =>
  `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(name)}</option>`;
const targetLabel = row =>
  row.scope === 'managed'
    ? 'Все распознанные запущенные окна'
    : { all: 'Вся выбранная пати', others: 'Участники, кроме ПЛ', leader: 'Только ПЛ', subset: 'Отмеченные участники' }[
        row.target
      ];
export function mountGameMacros(host) {
  if (!host) return;
  activeHost = host;
  const wasOpen = host.querySelector('#game-macros-block')?.open === true;
  const c = config();
  const selected = c.commands.find(row => row.id === selectedId) || c.commands[0];
  selectedId = selected?.id || '';
  const point = c.points.find(p => p.id === selected?.pointId);
  host.innerHTML = `<details id="game-macros-block" class="tools-block gm-workspace"><summary class="gm-collapsed-title">🎮 Управление пати и макросы</summary>
  <header class="gm-heading"><div><span class="gm-eyebrow">Управление игровыми окнами</span><h3>🎮 Управление пати и макросы</h3><p>Выберите пати, настройте команды и запускайте их кнопкой или сочетанием клавиш.</p></div><button class="btn danger" data-gm-stop>■ Остановить</button></header>
  <div class="gm-control-bar"><label class="gm-field">Пати для всех команд<select data-gm-party><option value="">Выберите пати</option>${state.parties.map(p => option(p.id, p.name, c.partyId)).join('')}</select></label><label class="gm-switch"><input type="checkbox" data-gm-enabled ${c.enabled ? 'checked' : ''}><span><b>Управление сочетаниями клавиш</b><small>Можно запускать команды, когда открыта игра, без перехода в Твиноферму.</small></span></label></div>
  <p class="gm-key-note">Если переключатель выключен, работает ручной запуск кнопкой ▶. При включении Windows закрепляет сочетания за приложением; игровые команды срабатывают только из окон выбранной пати. Остановка — <kbd>Ctrl+Alt+Pause</kbd>.</p>
  <button class="btn ghost" data-gm-diagnostics>◎ Проверить окна</button><div class="gm-status" role="status" data-gm-runtime></div>
  <div class="gm-section-top"><h4>Мои команды <span>${c.commands.length}</span></h4><button class="btn primary" data-gm-create>＋ Создать команду</button></div>
  <div class="gm-command-workbench"><nav class="gm-command-menu" aria-label="Команды">${c.commands.map(row => `<button class="gm-command-choice ${row.id === selectedId ? 'is-selected' : ''}" data-gm-select="${esc(row.id)}" aria-pressed="${row.id === selectedId}"><b>${esc(row.name)}</b><kbd>${esc(row.hotkey || 'Без сочетания')}</kbd></button>`).join('') || '<p class="muted">Пока нет команд. Создайте первую.</p>'}</nav>
  <article class="gm-command-detail">${
    selected
      ? `<div class="gm-detail-head"><div><span class="gm-eyebrow">Выбранная команда</span><h4>${esc(selected.name)}</h4></div><div class="gm-icon-actions"><button class="btn" data-gm-run="${esc(selected.id)}" ${selected.action === 'pause' ? 'data-gm-pause' : ''} title="Запустить один раз без сочетания клавиш" aria-label="Запустить один раз">▶</button><button class="btn ghost" data-gm-edit="${esc(selected.id)}" title="Изменить команду" aria-label="Изменить команду">✎</button><button class="btn ghost danger" data-gm-delete="${esc(selected.id)}" title="Удалить команду" aria-label="Удалить команду">🗑</button></div></div>
  <dl class="gm-command-facts"><div><dt>Действие</dt><dd>${esc(commandLabels[selected.action])}</dd></div><div><dt>Получатели</dt><dd>${esc(targetLabel(selected))}</dd></div><div><dt>Сочетание</dt><dd><kbd>${esc(selected.hotkey || 'Не задано')}</kbd></dd></div>${['click', 'follow'].includes(selected.action) ? `<div><dt>Точка</dt><dd>${esc(point?.name || 'Нужно задать координаты')}</dd></div>` : ''}</dl>
  ${selected.action === 'sequence' ? `<pre class="gm-sequence">${esc(selected.sequence)}</pre>` : ''}
  <p class="muted">▶ — выполнить эту команду один раз мышью. Это удобно для проверки и работы без сочетания клавиш.</p>${['click', 'follow'].includes(selected.action) ? `<button class="btn" data-gm-preview="${esc(selected.id)}">◎ Предпросмотр без клика</button><p class="muted">Перед первым кликом в этом сеансе проверьте точки предпросмотром.</p>` : ''}`
      : '<p class="muted">Создайте команду: выберите действие, получателей и удобные клавиши.</p>'
  }</article></div>
  <section class="gm-settings-section"><div class="gm-section-top"><div><h4>Размеры клиентов для F11</h4><p>Задайте размер игровой области. «Показать размер» рисует рамку на экране, не меняя окна игры.</p></div><button class="btn ghost" data-gm-size-reset>По умолчанию</button></div><div class="gm-size-grid">${[
    ['leader', '👑 ПЛ'],
    ['other', 'Остальные участники']
  ]
    .map(
      ([prefix, title]) =>
        `<div class="gm-size-card"><h5>${title}</h5><div class="gm-number-pair">${[
          ['Width', 'Ширина'],
          ['Height', 'Высота']
        ]
          .map(
            ([suffix, name]) =>
              `<label class="gm-field">${name}<span class="gm-number-unit"><input type="number" min="160" max="8000" data-gm-size="${prefix + suffix}" value="${c[prefix + suffix]}"><small>px</small></span></label>`
          )
          .join(
            ''
          )}</div><select class="input" data-gm-resolution="${prefix}" aria-label="Стандартное разрешение"><option value="">Стандартные разрешения</option>${[
          [1280, 720],
          [1600, 900],
          [1920, 1080],
          [1920, 1200],
          [2560, 1400],
          [2560, 1440],
          [3440, 1440],
          [3840, 2160]
        ]
          .map(([w, h]) => `<option value="${w}x${h}">${w} × ${h}</option>`)
          .join('')}</select><button class="btn" data-gm-show-size="${prefix}">▣ Показать размер</button></div>`
    )
    .join('')}</div><button class="btn primary" data-gm-save-sizes>Сохранить размеры</button></section>
  <section class="gm-settings-section"><div class="gm-section-top"><div><h4>Профили размещения игровых окон</h4><p>Запомните текущие размеры и позиции окон пати. Выбранный профиль использует команда «Применить профиль окон».</p></div></div><div class="gm-profile-controls"><label class="gm-field">Используемый профиль<select data-gm-profile><option value="">Не выбран</option>${c.profiles.map(p => option(p.id, p.name, c.profileId)).join('')}</select></label><button class="btn ghost" data-gm-delete-profile>Удалить выбранный</button></div><div class="gm-profile-controls"><label class="gm-field">Название нового профиля<input data-gm-profile-name maxlength="80" placeholder="Например: основная пати, два монитора"></label><button class="btn" data-gm-save-profile>＋ Запомнить текущее расположение</button></div></section>
  <section class="gm-settings-section"><div class="gm-section-top"><div><h4>Координатные точки</h4><p>Назовите точку, выберите окно и совместите экранный крестик с нужным местом. Сохранение не кликает в игру.</p></div></div><form data-gm-capture class="gm-point-form"><label class="gm-field">Название точки<input name="name" required maxlength="80" placeholder="Свиток воскрешения, портрет персонажа…"></label><label class="gm-field">В каком окне задать точку<select name="charId" required><option value="">Выберите участника</option>${partyMembers(
    state,
    c.partyId
  )
    .map(char => option(char.id, `${char.class || ''} — ${char.nick}`, c.leaders[c.partyId]))
    .join(
      ''
    )}</select></label><button class="btn primary">⊕ Задать координаты</button></form><p class="muted">Размер окна и DPI определяются автоматически. Для другого размера окна создайте вариант точки; после перемещения элементов интерфейса задайте точку заново.</p><div class="gm-command-workbench"><nav class="gm-command-menu">${c.points.map(p => `<button class="gm-command-choice" data-gm-point="${esc(p.id)}"><b>${esc(p.name)}</b><small>${p.width} × ${p.height}</small></button>`).join('') || '<p>Нет сохранённых точек.</p>'}</nav><article data-gm-point-detail></article></div></section>
  <footer class="gm-bottom-actions"><button class="btn" data-gm-logs>≡ Журнал сеанса</button><button class="btn" data-gm-overlay>▣ Открыть оверлей</button><button class="btn ghost" data-gm-overlay-settings>⚙ Настройки оверлея</button></footer></details>`;
  host.querySelector('#game-macros-block').open = wasOpen;
  host.querySelectorAll('[data-gm-resolution]').forEach(
    select =>
      (select.onchange = () => {
        if (!select.value) return;
        const [w, h] = select.value.split('x');
        host.querySelector(`[data-gm-size="${select.dataset.gmResolution}Width"]`).value = w;
        host.querySelector(`[data-gm-size="${select.dataset.gmResolution}Height"]`).value = h;
      })
  );
  host.querySelector('[data-gm-stop]').onclick = stop;
  host.querySelector('[data-gm-party]').onchange = safe(e => save({ partyId: e.target.value }));
  host.querySelector('[data-gm-enabled]').onchange = safe(e => save({ enabled: e.target.checked }));
  host.querySelector('[data-gm-create]').onclick = () => openCommandEditor(config(), save);
  host.querySelectorAll('[data-gm-select]').forEach(button => {
    button.onclick = () => {
      selectedId = button.dataset.gmSelect;
      mountGameMacros(host);
    };
  });
  host.querySelector('[data-gm-run]')?.addEventListener('click', () => {
    void run(selectedId);
  });
  host.querySelector('[data-gm-edit]')?.addEventListener('click', () => openCommandEditor(config(), save, selected));
  host.querySelector('[data-gm-delete]')?.addEventListener('click', () =>
    showModal({
      title: 'Удалить команду?',
      content: `<p>Удалить «${esc(selected.name)}»? Сохранённые точки останутся.</p>`,
      submitText: 'Удалить',
      cancelText: 'Отмена',
      onSubmit: () => save({ commands: config().commands.filter(row => row.id !== selectedId) })
    })
  );
  host.querySelector('[data-gm-preview]')?.addEventListener(
    'click',
    safe(async () => drawPoint(await previewCommand(selectedId)))
  );
  host.querySelector('[data-gm-diagnostics]').onclick = safe(async () => {
    const rows = await (await import('./runtime.js')).listMacroWindows();
    showModal({
      title: 'Проверка игровых окон',
      content: `<p>Для управления нужны однозначное имя, проверенный процесс и достаточные права. Для игры от администратора сама Твиноферма тоже должна быть запущена от администратора. Программа не угадывает персонажа по порядку окон.</p>${rows.map(r => `<p><b>${esc(r.nick || 'Не распознано')} · PID ${r.pid}</b><br>${esc(r.title || 'Без заголовка')}<br>${r.elevated === true && !r.selfElevated ? 'Твиноферма запущена без прав администратора. Перезапустите её от администратора.' : r.elevated == null ? 'Не удалось определить права процесса.' : !r.known ? 'Не распознано: проверьте ник в заголовке и список персонажей.' : !r.startedAt || !r.hwnd ? 'Не удалось проверить время запуска или игровое окно.' : r.elevated === true ? 'Окно распознано. Игра и Твиноферма запущены от администратора.' : 'Окно распознано, права обычные.'}</p>`).join('') || '<p>Запущенные клиенты не найдены.</p>'}`,
      submitText: 'Закрыть',
      onSubmit: () => {}
    });
  });
  host.querySelector('[data-gm-overlay]').onclick = safe(openOverlay);
  host.querySelector('[data-gm-logs]').onclick = () => openMacrosDialog('logs');
  host.querySelector('[data-gm-overlay-settings]').onclick = () => openMacrosDialog('overlay-settings');
  const readSizes = () =>
    Object.fromEntries(
      [...host.querySelectorAll('[data-gm-size]')].map(input => {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < 160 || value > 8000)
          throw new Error('Размеры — целые числа от 160 до 8000 px.');
        return [input.dataset.gmSize, value];
      })
    );
  host.querySelector('[data-gm-save-sizes]').onclick = safe(() => save(readSizes()));
  host.querySelector('[data-gm-size-reset]').onclick = safe(() =>
    save({ leaderWidth: 2560, leaderHeight: 1400, otherWidth: 2560, otherHeight: 1400 })
  );
  host.querySelectorAll('[data-gm-show-size]').forEach(button => {
    button.onclick = safe(() => {
      const sizes = readSizes(),
        prefix = button.dataset.gmShowSize;
      return showSize(sizes[prefix + 'Width'], sizes[prefix + 'Height'], prefix);
    });
  });
  host.querySelector('[data-gm-profile]').onchange = safe(e => save({ profileId: e.target.value }));
  host.querySelector('[data-gm-delete-profile]').onclick = safe(() =>
    save({ profiles: config().profiles.filter(p => p.id !== config().profileId), profileId: '' })
  );
  host.querySelector('[data-gm-save-profile]').onclick = safe(async () => {
    const name = host.querySelector('[data-gm-profile-name]').value.trim();
    if (!name) throw new Error('Введите название профиля.');
    const previous = state.settings.gameMacros;
    try {
      await saveProfile(name);
      await save({});
    } catch (error) {
      state.settings.gameMacros = previous;
      throw error;
    }
  });
  host.querySelector('[data-gm-capture]').onsubmit = safe(async event => {
    event.preventDefault();
    const data = new FormData(event.target);
    const previous = state.settings.gameMacros;
    try {
      const point = await pickPoint(String(data.get('charId')), String(data.get('name')));
      selectedPointId = point.id;
      await save({});
    } catch (error) {
      state.settings.gameMacros = previous;
      throw error;
    }
  });
  const drawPoint = point => {
    const detail = host.querySelector('[data-gm-point-detail]');
    if (!point) {
      detail.textContent = 'Выберите сохранённую точку слева.';
      return;
    }
    selectedPointId = point.id;
    detail.innerHTML = `<h4>${esc(point.name)}</h4><p>${point.width} × ${point.height} · DPI ${point.dpi} · (${point.x}, ${point.y}). Схема, не снимок игры.</p><div class="gm-point-map" style="aspect-ratio:${point.width}/${point.height}"><span style="left:${(point.x / point.width) * 100}%;top:${(point.y / point.height) * 100}%">⊕</span></div><label>Окно для повторного задания<select data-point-char>${partyMembers(
      state,
      c.partyId
    )
      .map(char => option(char.id, char.nick, c.leaders[c.partyId]))
      .join(
        ''
      )}</select></label><button class="btn" data-point-edit>✎ Задать заново</button><button class="btn danger" data-point-delete aria-label="Удалить точку">🗑</button>`;
    detail.querySelector('[data-point-delete]').onclick = safe(() =>
      save({ points: config().points.filter(p => p.id !== point.id) })
    );
    detail.querySelector('[data-point-edit]').onclick = safe(async () => {
      const previous = state.settings.gameMacros;
      try {
        await pickPoint(detail.querySelector('[data-point-char]').value, point.name, point.id);
        await save({});
      } catch (error) {
        state.settings.gameMacros = previous;
        throw error;
      }
    });
  };
  host
    .querySelectorAll('[data-gm-point]')
    .forEach(button => (button.onclick = () => drawPoint(config().points.find(p => p.id === button.dataset.gmPoint))));
  drawPoint(c.points.find(p => p.id === selectedPointId) || c.points[0]);
  const update = () => {
    if (!host.isConnected) return;
    const data = snapshot();
    host.querySelector('[data-gm-runtime]').textContent = data.paused
      ? 'Команды на паузе'
      : data.busy
        ? 'Команда выполняется…'
        : data.registered
          ? 'Управление клавишами включено'
          : 'Ручной режим · команды запускаются кнопкой ▶';
    host.querySelectorAll('button:not([data-gm-stop]):not([data-gm-pause]),input,select').forEach(input => {
      input.disabled = data.busy;
    });
    const log = document.querySelector('[data-gm-log-text]');
    if (log) log.textContent = data.logs.join('\n') || 'В этом сеансе команды ещё не запускались.';
  };
  if (updateListener) window.removeEventListener('tf-game-macros-changed', updateListener);
  updateListener = update;
  window.addEventListener('tf-game-macros-changed', update);
  update();
  void initGameMacros();
}
export function openMacrosDialog(action) {
  if (action === 'logs') {
    showModal({
      title: 'Журнал команд · текущий сеанс',
      wide: true,
      content: `<div class="gm-dialog"><p class="muted">Только действия команд с момента запуска приложения. Журнал не сохраняется на диск.</p><pre data-gm-log-text class="gm-log">${esc(snapshot().logs.join('\n') || 'В этом сеансе команды ещё не запускались.')}</pre></div>`,
      submitText: null,
      cancelText: 'Закрыть'
    });
    return;
  }
  if (action !== 'overlay-settings') return;
  const c = config();
  showModal({
    title: 'Настройки оверлея',
    content: `<form class="gm-dialog gm-overlay-form"><p>Небольшое окно поверх игры: сочетания команд, состояние и быстрый переход к настройкам. Последнее положение сохраняется автоматически. Оверлей без системной рамки; верхняя полоса чуть прозрачнее основного фона. Кнопка ▴ сворачивает его до этой полосы, ▾ разворачивает обратно. Перетаскивайте за название.</p><label class="gm-field">Непрозрачность фона <output data-gm-alpha-value>${Math.round(c.opacity * 100)}%</output><input type="range" name="opacity" min="10" max="100" value="${Math.round(c.opacity * 100)}"></label><div class="gm-overlay-sample" style="--preview-alpha:${c.opacity}" data-gm-overlay-sample><b>🎮 Управление пати</b><small>Так будет выглядеть фон окна</small><kbd>Ctrl + F1</kbd></div><label class="gm-switch"><input type="checkbox" name="topmost" ${c.topmost ? 'checked' : ''}><span><b>Показывать поверх других окон</b><small>Удобно для оконного или безрамочного режима игры.</small></span></label></form>`,
    submitText: 'Сохранить',
    cancelText: 'Отмена',
    onSubmit: async data => {
      await save({ opacity: Number(data.get('opacity')) / 100, topmost: data.has('topmost') });
      await (await import('./runtime.js')).applyOverlayPreferences();
    }
  });
  document.querySelector('#modal-root [name="opacity"]').oninput = event => {
    document.querySelector('[data-gm-alpha-value]').textContent = event.target.value + '%';
    document
      .querySelector('[data-gm-overlay-sample]')
      .style.setProperty('--preview-alpha', String(Number(event.target.value) / 100));
  };
}
window.addEventListener('tf-game-macro-dialog', event => openMacrosDialog(event.detail));
window.addEventListener('tf-game-macro-party-selected', () => {
  if (activeHost?.isConnected) mountGameMacros(activeHost);
});

window.addEventListener('tf-game-macro-size-selected', () => {
  if (activeHost?.isConnected) mountGameMacros(activeHost);
});
