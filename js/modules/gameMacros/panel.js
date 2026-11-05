import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { toast } from '../../core/ui.js';
import { chord, steps, normalizeGameMacros, partyMembers } from './model.js';
import {
  config,
  configure,
  initGameMacros,
  snapshot,
  openOverlay,
  run,
  stop,
  saveProfile,
  capturePoint,
  previewCommand
} from './runtime.js';
const labels = {
  next: 'Следующее окно',
  previous: 'Предыдущее окно',
  leader: 'Перейти к ПЛ',
  sequence: 'Последовательность клавиш',
  layout: 'Применить профиль окон',
  click: 'Клик по откалиброванной точке'
};
let previousUpdate;
export function mountGameMacros(host) {
  if (!host) return;
  const c = config();
  host.innerHTML = `<section class="tools-block" id="game-macros-block"><h3>🎮 Управление пати и макросы</h3><p class="muted">Команды только по вашему запуску. ПЛ назначается в настройках пати (👑); это не меняет лидерство внутри игры. Перед массовыми действиями проверьте правила игры и одно тестовое окно.</p>
  <div class="row gap"><label>Пати <select data-gm-party><option value="">Выберите пати</option>${state.parties.map(p => `<option value="${esc(p.id)}" ${p.id === c.partyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><label><input type="checkbox" data-gm-enabled ${c.enabled ? 'checked' : ''}> Включить глобальные хоткеи</label><button class="btn" data-gm-overlay>Окно-памятка / оверлей</button></div>
  <p class="muted">Хоткеи резервируются в Windows; игровые команды исполняются только при активном окне выбранной пати. Ctrl+Alt+Pause — остановка. Безопаснее выбирать сочетания Ctrl+Alt, не Ctrl+X и Ctrl+F.</p>
  <div class="row gap"><label>Непрозрачность фона <input type="range" min="30" max="100" value="${Math.round(c.opacity * 100)}" data-gm-opacity></label><label><input type="checkbox" data-gm-top ${c.topmost ? 'checked' : ''}> Оверлей поверх окон</label><button class="btn danger" data-gm-stop>Остановить</button></div>
  <div data-gm-runtime></div>
  <div class="tools-grid">${c.commands.map(row => `<div class="panel"><b>${esc(row.name)}</b><p>${esc(labels[row.action])} · ${esc(row.hotkey || 'без хоткея')}</p><button class="btn" data-gm-run="${esc(row.id)}">Запустить</button>${row.action === 'click' ? ` <button class="btn" data-gm-preview="${esc(row.id)}">Предпросмотр без клика</button>` : ''} <button class="btn ghost" data-gm-edit="${esc(row.id)}">Изменить</button> <button class="btn ghost" data-gm-delete="${esc(row.id)}">Удалить</button></div>`).join('')}</div>
  <details data-gm-editor><summary>Добавить / изменить команду</summary><form data-gm-form><input type="hidden" name="id"><label>Название <input class="input" name="name" maxlength="80" required></label><label>Действие <select name="action">${Object.entries(
    labels
  )
    .map(([key, value]) => `<option value="${key}">${value}</option>`)
    .join(
      ''
    )}</select></label><label>Хоткей <input class="input" name="hotkey" placeholder="CTRL+ALT+F8"></label><label>Получатели <select name="target"><option value="all">Вся выбранная пати</option><option value="others">Кроме ПЛ</option><option value="leader">Только ПЛ</option><option value="subset">Выбранные участники</option></select></label><fieldset data-gm-subset><legend>Поднабор получателей</legend>${
    partyMembers(state, c.partyId)
      .map(char => `<label><input type="checkbox" name="charIds" value="${esc(char.id)}"> ${esc(char.nick)}</label>`)
      .join('') || '<p class="muted">Сначала выберите пати.</p>'
  }</fieldset><label>Точка для клика <select name="pointId"><option value="">Не выбрана</option>${c.points.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height} · UI ${esc(p.uiScale)}</option>`).join('')}</select></label><label><input type="checkbox" name="resourceAllowed"> Разрешаю координатный клик, в том числе возможный расход игровых ресурсов; сверил масштаб и расположение UI с профилем</label><label>Последовательность (один шаг на строку)<textarea class="input" name="sequence" rows="4">F8
wait 200</textarea></label><p class="muted">Пример ассиста: SHIFT+1, wait 100, F7 — каждый шаг на новой строке. Проверьте игровые привязки; назначенный ПЛ не обязательно первый в игровом списке. Не более 20 шагов; бесконечных циклов и скриптов нет. Координатный клик — отдельное действие с калибровкой и разрешением расходов.</p><button class="btn">Сохранить команду</button></form></details>
  <details><summary>Профили размещения игровых окон</summary><p class="muted">Сохранение текущих внешних размеров и позиций окон выбранной пати. При смене мониторов профиль проверяется. Игра от администратора не управляется.</p><label>Профиль <select data-gm-profile><option value="">Не выбран</option>${c.profiles.map(p => `<option value="${esc(p.id)}" ${p.id === c.profileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><button class="btn ghost" data-gm-delete-profile>Удалить выбранный профиль</button><input class="input" data-gm-profile-name placeholder="Название профиля" maxlength="80"><button class="btn" data-gm-save-profile>Запомнить расположение</button></details>
  <details data-gm-calibration><summary>Координатные профили и калибровка</summary>
  <p class="muted">Координаты привязаны к клиентской области, размеру и DPI. Масштаб UI игры указывается вручную: Windows не может проверить его. При изменении UI создайте новую точку. После каждого запуска приложения сначала выполните «Предпросмотр без клика» у нужной команды. Он проверяет окна, но не игровой смысл кнопки. Оверлей или другое окно над точкой блокирует клик.</p>
  <form data-gm-capture><label>Окно персонажа <select name="charId" required><option value="">Выберите</option>${partyMembers(
    state,
    c.partyId
  )
    .map(char => `<option value="${esc(char.id)}">${esc(char.nick)}</option>`)
    .join(
      ''
    )}</select></label><label>Имя точки <input class="input" name="name" maxlength="80" required></label><label>Масштаб UI игры <input class="input" name="uiScale" maxlength="40" placeholder="Например: 100%, стандартный интерфейс" required></label><button class="btn">Считать положение мыши через 5 секунд — без клика</button></form>
  <div data-gm-point-preview></div><div class="tools-grid">${c.points.map(p => `<div class="panel"><b>${esc(p.name)}</b><p>${p.width}×${p.height} · DPI ${p.dpi} · UI ${esc(p.uiScale)}</p><button class="btn" data-gm-point="${esc(p.id)}">Показать схему</button> <button class="btn ghost" data-gm-remove-point="${esc(p.id)}">Удалить</button></div>`).join('')}</div></details>
  <details open><summary>Журнал команд (только текущий сеанс)</summary><pre id="game-macro-log" style="white-space:pre-wrap;max-height:260px;overflow:auto"></pre></details></section>`;
  const save = async patch => {
    const previous = state.settings.gameMacros;
    state.settings.gameMacros = normalizeGameMacros({ ...config(), ...patch });
    try {
      await persist();
    } catch (error) {
      state.settings.gameMacros = previous;
      throw error;
    }
    await configure();
    mountGameMacros(host);
  };
  const safe = fn => async event => {
    try {
      await fn(event);
    } catch (error) {
      toast(error?.message || 'Действие не выполнено.', 'error');
    }
  };
  host.querySelector('[data-gm-party]').onchange = safe(e => save({ partyId: e.target.value }));
  host.querySelector('[data-gm-enabled]').onchange = safe(e => save({ enabled: e.target.checked }));
  host.querySelector('[data-gm-opacity]').onchange = safe(e => save({ opacity: Number(e.target.value) / 100 }));
  host.querySelector('[data-gm-top]').onchange = safe(async e => {
    await save({ topmost: e.target.checked });
    await openOverlay();
  });
  host.querySelector('[data-gm-overlay]').onclick = safe(openOverlay);
  host.querySelector('[data-gm-stop]').onclick = stop;
  host.querySelector('[data-gm-profile]').onchange = safe(e => save({ profileId: e.target.value }));
  host.querySelector('[data-gm-delete-profile]').onclick = safe(() =>
    save({ profiles: config().profiles.filter(p => p.id !== config().profileId), profileId: '' })
  );
  host.querySelector('[data-gm-save-profile]').onclick = safe(async () => {
    const name = host.querySelector('[data-gm-profile-name]').value.trim();
    if (!name) throw new Error('Укажите название профиля.');
    const previous = state.settings.gameMacros;
    try {
      await saveProfile(name);
      await save({});
    } catch (error) {
      state.settings.gameMacros = previous;
      throw error;
    }
  });
  const form = host.querySelector('[data-gm-form]');
  form.onsubmit = safe(async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (data.hotkey && !chord(data.hotkey)) throw new Error('Неверный хоткей. Пример CTRL+ALT+F8.');
    if (data.action === 'sequence') steps(data.sequence);
    data.sequence = data.sequence || 'F8';
    data.charIds = new FormData(form).getAll('charIds');
    data.resourceAllowed = form.elements.namedItem('resourceAllowed').checked;
    if (data.target === 'subset' && !data.charIds.length) throw new Error('Выберите хотя бы одного получателя.');
    if (data.action === 'click' && (!data.pointId || !data.resourceAllowed))
      throw new Error('Выберите точку и явно разрешите координатное действие.');
    if (!data.id && config().commands.length >= 30) throw new Error('Не более 30 команд.');
    const row = { ...data, id: data.id || crypto.randomUUID() };
    const commands = [...config().commands.filter(c => c.id !== row.id), row];
    const keys = commands.filter(c => c.hotkey).map(c => chord(c.hotkey));
    if (new Set(keys).size !== keys.length || keys.includes('CTRL+ALT+PAUSE'))
      throw new Error('Сочетание уже занято или зарезервировано.');
    await save({ commands });
  });
  host.querySelectorAll('[data-gm-run]').forEach(button => {
    button.onclick = () => {
      void run(button.dataset.gmRun);
    };
  });
  host.querySelectorAll('[data-gm-delete]').forEach(button => {
    button.onclick = safe(() => save({ commands: config().commands.filter(c => c.id !== button.dataset.gmDelete) }));
  });
  host.querySelectorAll('[data-gm-edit]').forEach(button => {
    button.onclick = () => {
      const row = config().commands.find(c => c.id === button.dataset.gmEdit);
      for (const [key, value] of Object.entries(row)) {
        const input = form.elements.namedItem(key);
        if (!input || key === 'charIds') continue;
        if (input.type === 'checkbox') input.checked = value === true;
        else input.value = value;
      }
      form.querySelectorAll('[name="charIds"]').forEach(input => {
        input.checked = row.charIds.includes(input.value);
      });
      host.querySelector('[data-gm-editor]').open = true;
      form.scrollIntoView?.({ block: 'nearest' });
    };
  });
  const showPoint = point => {
    const preview = host.querySelector('[data-gm-point-preview]');
    preview.innerHTML = `<p><b>${esc(point.name)}</b> — схематичная клиентская область, без снимка игры: ${point.width}×${point.height}, UI ${esc(point.uiScale)}. Маркер — место клика.</p><div class="gm-point-map" style="aspect-ratio:${point.width}/${point.height}"><span style="left:${(point.x / point.width) * 100}%;top:${(point.y / point.height) * 100}%" aria-label="Откалиброванная точка">⊕</span></div>`;
    host.querySelector('[data-gm-calibration]').open = true;
    preview.scrollIntoView?.({ block: 'nearest' });
  };
  host.querySelector('[data-gm-capture]').onsubmit = safe(async event => {
    event.preventDefault();
    const fields = new FormData(event.target);
    const previous = state.settings.gameMacros;
    try {
      const point = await capturePoint(
        String(fields.get('charId')),
        String(fields.get('name')),
        String(fields.get('uiScale'))
      );
      await save({});
      showPoint(point);
    } catch (error) {
      state.settings.gameMacros = previous;
      throw error;
    }
  });
  host.querySelectorAll('[data-gm-preview]').forEach(button => {
    button.onclick = safe(async () => showPoint(await previewCommand(button.dataset.gmPreview)));
  });
  host.querySelectorAll('[data-gm-point]').forEach(button => {
    button.onclick = () => showPoint(config().points.find(p => p.id === button.dataset.gmPoint));
  });
  host.querySelectorAll('[data-gm-remove-point]').forEach(button => {
    button.onclick = safe(() => save({ points: config().points.filter(p => p.id !== button.dataset.gmRemovePoint) }));
  });
  const update = () => {
    if (!host.isConnected) return;
    const data = snapshot();
    host.querySelector('[data-gm-runtime]').textContent = data.busy
      ? 'Команда выполняется'
      : data.registered
        ? 'Глобальные хоткеи включены'
        : 'Глобальные хоткеи не включены';
    host.querySelector('#game-macro-log').textContent = data.logs.join('\n') || 'Команд ещё не было.';
    host.querySelectorAll('button:not([data-gm-stop]), input, select, textarea').forEach(button => {
      button.disabled = data.busy;
    });
  };
  if (previousUpdate) window.removeEventListener('tf-game-macros-changed', previousUpdate);
  previousUpdate = update;
  window.addEventListener('tf-game-macros-changed', update);
  update();
  void initGameMacros();
}
