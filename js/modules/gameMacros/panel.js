import { openInputComparison } from './inputComparison.js';
import { openMultiInputTrial } from './multiInputTrial.js';
import { runInputComparison, runMultiInputTrial } from './runtime.js';
import { openBackgroundJournal } from './backgroundJournal.js';
import { openMirrorObservation } from './mirrorObservation.js';
import { openReceiverTools } from './receiverTools.js';
import { openTrialWizard, openTrialComparison, outcomeHtml } from './trialWizard.js';
import { summarizeExecution } from './trialEvidence.js';
import { openCommandReview, openCommandTransfer, openExecutionDiagnostics } from './commandTools.js';
import { deleteCommandPlan, restoreDeletedCommand } from './transfer.js';
import { LAB_VERDICTS, labVerdict, recordLabVerdict } from './labResults.js';
import { commandFingerprint } from './fingerprint.js';
import { reviewCommand } from './review.js';
import { openBackgroundLab } from './backgroundLab.js';
import { updateRepeatButton } from './repeatButton.js';
import { copyJournal } from './journal.js';
import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { toast, showModal } from '../../core/ui.js';
import { normalizeGameMacros, partyMembers, validPoint, commandVisible } from './model.js';
import { commandLabels, openCommandEditor } from './editor.js';
import {
  config,
  getExecutionHistory,
  runBackgroundTrial,
  controlReceiver,
  clearLogs,
  diagnoseBackground,
  configure,
  reconnectInput,
  initGameMacros,
  toggleKeyboardMirror,
  snapshot,
  openOverlay,
  run,
  stop,
  togglePause,
  saveProfile,
  pickPoint,
  previewCommand,
  previewComposition,
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
  const scrollNodes = [host, ...host.querySelectorAll('.gm-command-menu,.gm-command-detail,.gm-point-list')];
  for (let node = host.parentElement; node; node = node.parentElement) scrollNodes.push(node);
  const scroll = scrollNodes.map(node => ({
    node,
    top: node.scrollTop,
    left: node.scrollLeft,
    selector:
      node === host || !host.contains(node)
        ? null
        : node.matches('.gm-point-list')
          ? '.gm-point-list'
          : node.matches('[data-gm-point-detail]')
            ? '[data-gm-point-detail]'
            : '.' + node.classList[0]
  }));
  const c = config();
  const searchQuery = host.querySelector('[data-gm-search]')?.value || '';
  const pointsOpen = host.querySelector('.gm-points-section')?.open === true;
  const labOpen = host.querySelector('.gm-background-section')?.open === true;
  const visibleCommands = c.commands.filter(commandVisible);
  const selected = visibleCommands.find(row => row.id === selectedId) || visibleCommands[0];
  selectedId = selected?.id || '';
  const validation = selected ? reviewCommand(selected, c, state) : null;
  const manualResult = selected ? labVerdict(c, selected) : null;
  const isBackgroundTest = selected?.action === 'sequence' && selected.delivery === 'background';
  const point = c.points.find(p => p.id === selected?.pointId);
  host.innerHTML = `<section id="game-macros-block" class="tools-block gm-workspace"><header class="gm-page-heading"><div><span class="gm-eyebrow">Управление игровыми окнами</span><h3>Управление пати и макросами</h3><p>Выберите пати, настройте команды и запускайте их кнопкой или сочетанием клавиш.</p></div><label class="gm-hotkey-master gm-slider-switch" title="Выкл — ручной запуск; аварийная остановка при выполнении остаётся доступной"><span>Сочетания клавиш</span><input type="checkbox" role="switch" aria-label="Управление сочетаниями клавиш" data-gm-enabled ${c.enabled ? 'checked' : ''}><i aria-hidden="true"></i></label></header>
  <div class="gm-start-guide" aria-label="Как начать"><article><span>01</span><div><b>Выберите пати</b><p>Настройте состав и ПЛ. Выбор ниже определяет получателей команд.</p></div></article><article><span>02</span><div><b>Проверьте окна</b><p>Убедитесь, что каждый клиент сопоставлен своему персонажу.</p><button type="button" class="btn ghost small" data-gm-check-windows>Проверить окна</button></div></article><article><span>03</span><div><b>Создайте и проверьте команду</b><p>Начните с одной безопасной клавиши. ▶ запускает команду один раз.</p></div></article></div>
  <div class="gm-control-buttons gm-mirror-buttons" role="group" aria-label="Управление выполнением и повтором"><button class="btn gm-repeat-toggle" data-gm-mirror aria-label="Включить повтор клавиатуры" title="Включить повтор клавиатуры" data-state="off" aria-pressed="false">⌨ ВЫКЛ</button><button class="btn gm-repeat-toggle" data-gm-mirror-mouse aria-label="Включить повтор мыши" title="Включить повтор мыши" data-state="off" aria-pressed="false">🖱 ВЫКЛ</button><button class="btn" data-gm-pause>Ⅱ Пауза</button><button class="btn danger" data-gm-stop>■ Остановить</button></div>
  <div class="gm-control-bar gm-party-bar"><label class="gm-field">Пати для всех команд<select data-gm-party><option value="">Выберите пати</option>${state.parties.map(p => option(p.id, p.name, c.partyId)).join('')}</select></label></div>
  <p class="gm-key-note">Если переключатель выключен, работает ручной запуск кнопкой ▶. При включении Windows закрепляет сочетания за приложением; игровые команды срабатывают только из окон выбранной пати. Остановка — <kbd>Ctrl+Alt+Pause</kbd>.</p>
  <div class="gm-repeat-toolbar"><button class="btn ghost" data-gm-reconnect title="Заново зарегистрировать сочетания и подключить включённые режимы повтора; настройки и данные не сбрасываются">↻ Переподключить ввод</button><button class="btn ghost" data-gm-diagnostics>◎ Проверить окна</button><button class="btn ghost" data-gm-background-probe>◎ Диагностика фона (без клавиш)</button><button class="btn ghost" data-gm-recognize>Распознать пати / порядок</button></div><fieldset class="gm-repeat-settings"><legend>Повтор клавиатуры и мыши — настройки</legend><p>Общий источник для обоих режимов и модификаторы маршрутизации мыши. Кнопки включения находятся выше.</p><div class="gm-repeat-settings-grid"><label class="gm-field">Способ клавиатурного повтора<select data-gm-keyboard-method><option value="post" ${c.mirrorKeyboardMethod === 'post' ? 'selected' : ''}>PostMessage — обычный</option><option value="activity-notify" ${c.mirrorKeyboardMethod === 'activity-notify' ? 'selected' : ''}>Только activity-notify — эксперимент</option><option value="combined" ${c.mirrorKeyboardMethod === 'combined' ? 'selected' : ''}>PostMessage + activity-notify — эксперимент</option></select><small>Только повтор, не команды и не мышь. В совмещённом режиме две отправки могут вызвать двойное действие. Чат автоматически не определяется. Сначала проверяйте безопасные действия на одном твине.</small></label><label class="gm-field"><input type="checkbox" data-gm-hold-only ${c.mirrorHoldOnly ? 'checked' : ''}> Удержание без автоповтора клавиш<small>При удержании: один DOWN и один UP. Сочетания сохраняются; автоповторные DOWN не отправляются. Игра может не распознать удержание через оконные сообщения.</small></label><label class="gm-field">Источник только клавиатуры<select data-gm-keyboard-source>${[
    ['shared', 'Как общий источник'],
    ['any', 'Любое распознанное игровое окно'],
    ['leader', 'Только ПЛ выбранной пати']
  ]
    .map(([value, label]) => option(value, label, c.mirrorKeyboardSource))
    .join('')}</select></label><label class="gm-field">Получатели клавиатуры<select data-gm-keyboard-targets>${[
    ['all', 'Все остальные распознанные окна'],
    ['party', 'Выбранная пати'],
    ['others', 'Пати, кроме ПЛ'],
    ['leader', 'Только ПЛ выбранной пати']
  ]
    .map(([value, label]) => option(value, label, c.mirrorKeyboardTargets))
    .join(
      ''
    )}</select><small>Источник никогда не получает свою копию. Для ввода только ПЛ из окна твина выберите источник «Любое окно» и получателя «Только ПЛ». Настройки мыши не меняются.</small></label><label class="gm-field">Общий источник (мышь и клавиатура без переопределения)<select data-gm-mirror-source><option value="any" ${c.mirrorSource === 'any' ? 'selected' : ''}>Любое распознанное игровое окно</option><option value="leader" ${c.mirrorSource === 'leader' ? 'selected' : ''}>Только ПЛ выбранной пати</option></select><small>Получатели — все остальные проверенные клиенты. Изменение настроек обновляет повтор, не сбрасывая выбранные режимы.</small></label><label class="gm-field">ЛКМ только твинам — модификатор<select data-gm-twins-modifier>${[
    ['', 'Выключено'],
    ['CTRL', 'Ctrl'],
    ['ALT', 'Alt'],
    ['SHIFT', 'Shift'],
    ['CTRL+ALT', 'Ctrl + Alt'],
    ['CTRL+SHIFT', 'Ctrl + Shift'],
    ['ALT+SHIFT', 'Alt + Shift'],
    ['CTRL+ALT+SHIFT', 'Ctrl + Alt + Shift']
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${c.mirrorTwinsModifier === value ? 'selected' : ''}>${label}</option>`
    )
    .join(
      ''
    )}</select><small>Работает при включённом повторе мыши в активном окне ПЛ выбранной пати. Зажмите ровно выбранные модификаторы и нажмите ЛКМ: исходный клик блокируется, остальным проверенным клиентам отправляется ЛКМ без модификаторов. Без модификатора — обычный повтор. Выбранные служебные модификаторы с ПЛ не повторяются клавиатурой. При ошибке клик не передаётся ПЛ вместо твинов; повтор останавливается. Работа в PW требует проверки.</small></label><label class="gm-field">Мышь только в активном окне — модификатор<select data-gm-active-modifier>${[
    ['', 'Выключено'],
    ['CTRL', 'Ctrl'],
    ['ALT', 'Alt'],
    ['SHIFT', 'Shift'],
    ['CTRL+ALT', 'Ctrl + Alt'],
    ['CTRL+SHIFT', 'Ctrl + Shift'],
    ['ALT+SHIFT', 'Alt + Shift'],
    ['CTRL+ALT+SHIFT', 'Ctrl + Alt + Shift']
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${c.mirrorActiveModifier === value ? 'selected' : ''}>${label}</option>`
    )
    .join(
      ''
    )}</select><small>При включённом повторе мыши удерживайте ровно выбранные модификаторы: ЛКМ, ПКМ, средняя и боковые кнопки остаются только в активном игровом окне, без копирования остальным клиентам. Сам повтор остаётся включённым. Клавиатурный повтор не меняется. При совпадении с «ЛКМ только твинам» приоритет у активного окна. Модификаторы не удаляются из локального клика: игра получает обычный Ctrl/Shift/Alt + клик.</small></label></div><small>Клавиатура и мышь включаются независимо. Клавиатура: выбранный выше способ со scan-code источника; работа текста в чате не подтверждает игровые действия. Мышь: абсолютные экранные координаты, без масштабирования. Возможен расход ресурсов.</small></fieldset>
  <div class="gm-section-top"><h4>Мои команды <span>${visibleCommands.length}</span></h4><div class="gm-journal-actions"><button class="btn ghost" data-gm-transfer>Импорт / экспорт</button>${c.deletedCommands.length ? `<button class="btn ghost" data-gm-undo-delete>Вернуть удалённую команду</button>` : ''}<button class="btn primary" data-gm-create>＋ Создать команду</button></div></div>
  <label class="gm-command-search">Поиск команды<input type="search" class="input" data-gm-search placeholder="Название или сочетание клавиш" aria-label="Найти команду"></label>
  <div class="gm-command-workbench"><nav class="gm-command-menu" aria-label="Команды">${visibleCommands.map(row => `<button class="gm-command-choice ${row.id === selectedId ? 'is-selected' : ''}" data-gm-select="${esc(row.id)}" aria-pressed="${row.id === selectedId}"><b>${esc(row.name)}</b><kbd>${esc(row.hotkey || 'Без сочетания')}</kbd></button>`).join('') || '<p class="muted">Пока нет команд. Создайте первую.</p>'}</nav>
  <article class="gm-command-detail">${
    selected
      ? `<div class="gm-detail-head"><div><span class="gm-eyebrow">Выбранная команда</span><h4>${esc(selected.name)}</h4></div><div class="gm-icon-actions"><button class="btn" data-gm-run="${esc(selected.id)}" ${selected.action === 'pause' ? 'data-gm-pause' : ''} title="Запустить один раз без сочетания клавиш" aria-label="Запустить один раз">▶</button><button class="btn ghost" data-gm-edit="${esc(selected.id)}" title="Изменить команду" aria-label="Изменить команду">✎</button><button class="btn ghost danger" data-gm-delete="${esc(selected.id)}" title="Удалить команду" aria-label="Удалить команду">🗑</button></div></div>
  <button type="button" class="btn ghost" data-gm-plan>План и проверка — без запуска</button><p class="gm-validation-summary">${validation.issues.filter(issue => issue.severity === 'error').length ? `Требует настройки: ${validation.issues.filter(issue => issue.severity === 'error').length} проблем. Откройте план и проверку.` : 'В настройках ошибок не найдено. Окна и права проверяются перед вводом.'}</p>
  <dl class="gm-command-facts"><div><dt>Действие</dt><dd>${esc(commandLabels[selected.action])}</dd></div><div><dt>Получатели</dt><dd>${esc(targetLabel(selected))}</dd></div><div><dt>Сочетание</dt><dd><kbd>${esc(selected.hotkey || 'Не задано')}</kbd></dd></div>${['click', 'follow'].includes(selected.action) ? `<div><dt>Точка</dt><dd>${esc(point?.name || 'Нужно задать координаты')}</dd></div>` : ''}</dl>
  ${selected.action === 'sequence' ? `<pre class="gm-sequence">${esc(selected.sequence)}</pre>` : ''}
  <p class="muted">Доставка: ${selected.delivery === 'background' ? 'без активации, эксперимент; игра может игнорировать' : 'ускоренный ввод с активацией окна'}.</p><p class="muted">▶ — выполнить эту команду один раз мышью. Это удобно для проверки и работы без сочетания клавиш.</p>${['click', 'follow', 'composite'].includes(selected.action) ? `<button class="btn" data-gm-preview="${esc(selected.id)}">◎ Предпросмотр без клика</button><p class="muted">Перед первым кликом в этом сеансе проверьте точки предпросмотром.</p>` : ''}`
      : '<p class="muted">Создайте команду: выберите действие, получателей и удобные клавиши.</p>'
  }${
    isBackgroundTest
      ? `<section class="gm-lab-result"><h4>Результат проверки в игре</h4><p>Техническая доставка не меняет эту отметку автоматически. Один и тот же результат нельзя переносить на другие клавиши, получателей или способы.</p><p data-lab-technical>Технический запуск ещё не зафиксирован в текущем сеансе.</p>${!manualResult && c.labResults.some(row => row.commandId === selected.id) ? '<p>Команда изменена: прежняя отметка больше не относится к этим настройкам.</p>' : ''}<label>Наблюдение<select data-lab-verdict>${Object.entries(
          LAB_VERDICTS
        )
          .map(
            ([value, label]) =>
              `<option value="${value}" ${manualResult?.verdict === value ? 'selected' : ''}>${label}</option>`
          )
          .join(
            ''
          )}</select></label><label>Заметка (без паролей и токенов)<textarea class="input" data-lab-notes maxlength="600" rows="3">${esc(manualResult?.notes || '')}</textarea></label><label><input type="checkbox" data-lab-observed> Я проверил действие непосредственно в игре</label><button type="button" class="btn" data-lab-save>Сохранить наблюдение</button><p data-lab-save-status role="status"></p></section>`
      : ''
  }</article></div>
  <section class="gm-settings-section" hidden data-gm-hidden-sizes><div class="gm-section-top"><div><h4>Размеры клиентов для F11</h4><p>Задайте размер игровой области. «Показать размер» рисует рамку на экране, не меняя окна игры.</p></div><button class="btn ghost" data-gm-size-reset>По умолчанию</button></div><div class="gm-size-grid">${[
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
  <section class="gm-settings-section" hidden data-gm-hidden-profiles><div class="gm-section-top"><div><h4>Профили размещения игровых окон</h4><p>Запомните текущие размеры и позиции окон пати. Выбранный профиль использует команда «Применить профиль окон».</p></div></div><div class="gm-profile-controls"><label class="gm-field">Используемый профиль<select data-gm-profile><option value="">Не выбран</option>${c.profiles.map(p => option(p.id, p.name, c.profileId)).join('')}</select></label><button class="btn ghost" data-gm-delete-profile>Удалить выбранный</button></div><div class="gm-profile-controls"><label class="gm-field">Название нового профиля<input data-gm-profile-name maxlength="80" placeholder="Например: основная пати, два монитора"></label><button class="btn" data-gm-save-profile>＋ Запомнить текущее расположение</button></div></section>
  <details class="gm-settings-section gm-points-section"><summary>Координаты для кликов · ${c.points.length} сохранено</summary><div class="gm-section-top"><div><h4>Координатные точки</h4><p>Назовите точку, выберите окно и совместите экранный крестик с нужным местом. Сохранение не кликает в игру.</p></div></div><form data-gm-capture class="gm-point-form"><label class="gm-field">Название точки<input name="name" required maxlength="80" placeholder="Свиток воскрешения, портрет персонажа…"></label><label class="gm-field">В каком окне задать точку<select name="charId" required><option value="">Выберите участника</option>${partyMembers(
    state,
    c.partyId
  )
    .map(char => option(char.id, `${char.class || ''} — ${char.nick}`, c.leaders[c.partyId]))
    .join(
      ''
    )}</select></label><button class="btn primary">⊕ Задать координаты</button></form><p class="muted">Размер окна и DPI определяются автоматически. Для другого размера окна создайте вариант точки; после перемещения элементов интерфейса задайте точку заново.</p><div class="gm-points-workbench"><nav class="gm-point-list" aria-label="Сохранённые координатные точки">${c.points.map(p => `<button class="gm-point-choice" data-gm-point="${esc(p.id)}"><b>${esc(p.name)}</b><small>${p.width} × ${p.height}</small></button>`).join('') || '<p>Нет сохранённых точек.</p>'}</nav><article class="gm-point-detail" data-gm-point-detail></article></div></details>
  <details class="gm-background-section"><summary>Проверки фонового ввода</summary><div class="gm-journal-actions"><button class="btn primary" data-gm-input-comparison>Сравнение A–E: один клиент…</button><button class="btn primary" data-gm-multi-trial>Клавиши и сочетания E · 1–4 окна…</button><button class="btn" data-gm-background-journal>Фоновый журнал…</button></div><p>Начните с одиночного опыта и сохраните наблюдение игры. Успешная отправка Windows не подтверждает действие игры. Методы не перебираются автоматически.</p><details data-gm-legacy-checks><summary>Расширенные и прежние проверки</summary><p class="muted">Резервные инструменты диагностики. Для обычной проверки используйте мастер A–E выше.</p><div class="gm-journal-actions"><button class="btn" data-gm-trial-wizard>Прежний мастер одиночной проверки</button><button class="btn" data-gm-receiver>Окно-приёмник Windows</button><button class="btn" data-gm-mirror-observation>Наблюдение клавиатурного повтора</button><button class="btn" data-gm-trial-table>Прежняя таблица результатов</button><button type="button" class="btn ghost" data-gm-background-lab>Подготовить прежние 5 вариантов</button></div></details></details>
  <div data-gm-outcome></div><footer class="gm-bottom-actions"><button class="btn ghost" data-gm-traces>Диагностика по запускам</button><button class="btn" data-gm-logs>≡ Журнал сеанса</button><button class="btn" data-gm-overlay>▣ Открыть оверлей</button><button class="btn ghost" data-gm-overlay-settings>⚙ Настройки оверлея</button></footer></section>`;
  host.querySelector('[data-gm-trial-wizard]').onclick = () =>
    openTrialWizard({
      getConfig: config,
      state,
      diagnose: diagnoseBackground,
      runTrial: runBackgroundTrial,
      save,
      stop
    });
  host.querySelector('[data-gm-mirror-observation]').onclick = () =>
    openMirrorObservation({ getConfig: config, state, save });
  host.querySelector('[data-gm-receiver]').onclick = () => openReceiverTools(controlReceiver);
  host.querySelector('[data-gm-trial-table]').onclick = () => openTrialComparison(config(), state);
  host.querySelector('[data-gm-transfer]').onclick = () => openCommandTransfer(config, save);
  host.querySelector('[data-gm-undo-delete]')?.addEventListener(
    'click',
    safe(() => save(restoreDeletedCommand(config())))
  );
  host.querySelector('[data-gm-plan]')?.addEventListener('click', () => openCommandReview(selected, config()));
  host.querySelector('[data-gm-traces]').onclick = () => openExecutionDiagnostics(getExecutionHistory());
  host.querySelector('[data-lab-save]')?.addEventListener(
    'click',
    safe(async () => {
      const verdict = host.querySelector('[data-lab-verdict]').value;
      if (verdict !== 'unverified' && !host.querySelector('[data-lab-observed]').checked) {
        host.querySelector('[data-lab-save-status]').textContent =
          'Сначала подтвердите, что проверили действие в самой игре.';
        return;
      }
      const current = config().commands.find(row => row.id === selected.id);
      if (!current || commandFingerprint(current) !== commandFingerprint(selected))
        throw new Error('Команда изменилась. Откройте её заново.');
      await save({
        labResults: recordLabVerdict(config(), current, verdict, host.querySelector('[data-lab-notes]').value)
      });
    })
  );
  host.querySelector('.gm-points-section').open = pointsOpen;
  host.querySelector('.gm-background-section').open = labOpen;
  host.querySelector('[data-gm-input-comparison]').onclick = () =>
    openInputComparison({ state, run: runInputComparison, stop });
  host.querySelector('[data-gm-multi-trial]').onclick = () =>
    openMultiInputTrial({ state, run: runMultiInputTrial, stop });
  host.querySelector('[data-gm-background-journal]').onclick = openBackgroundJournal;
  host.querySelector('[data-gm-background-lab]').onclick = () => openBackgroundLab(config(), save);
  host.querySelector('[data-gm-check-windows]').onclick = () => host.querySelector('[data-gm-diagnostics]').click();
  const search = host.querySelector('[data-gm-search]');
  search.value = searchQuery;
  const filterCommands = () => {
    const query = search.value.trim().toLocaleLowerCase();
    host.querySelectorAll('[data-gm-select]').forEach(button => {
      button.hidden = !button.textContent.toLocaleLowerCase().includes(query);
    });
    let empty = host.querySelector('[data-gm-no-matches]');
    if (!empty) {
      empty = document.createElement('p');
      empty.dataset.gmNoMatches = '';
      empty.className = 'muted';
      empty.textContent = 'Ничего не найдено. Измените запрос.';
      host.querySelector('.gm-command-menu').append(empty);
    }
    empty.hidden = !query || !!host.querySelector('[data-gm-select]:not([hidden])');
  };
  search.oninput = filterCommands;
  filterCommands();
  host.querySelectorAll('[data-gm-resolution]').forEach(
    select =>
      (select.onchange = () => {
        if (!select.value) return;
        const [w, h] = select.value.split('x');
        host.querySelector(`[data-gm-size="${select.dataset.gmResolution}Width"]`).value = w;
        host.querySelector(`[data-gm-size="${select.dataset.gmResolution}Height"]`).value = h;
      })
  );
  host.querySelector('[data-gm-reconnect]').onclick = safe(reconnectInput);
  host.querySelector('[data-gm-pause]').onclick = togglePause;
  host.querySelector('[data-gm-stop]').onclick = stop;
  host.querySelector('[data-gm-mirror]').onclick = safe(toggleKeyboardMirror);
  host.querySelector('[data-gm-mirror-mouse]').onclick = safe(() => toggleKeyboardMirror('mouse'));
  host.querySelector('[data-gm-recognize]').onclick = safe(async () => {
    const rows = await (await import('./runtime.js')).listMacroWindows();
    const known = new Set(rows.filter(r => r.known && r.charId).map(r => r.charId));
    const candidates = state.parties
      .map(p => ({ party: p, members: partyMembers(state, p.id) }))
      .map(p => ({ ...p, found: p.members.filter(ch => known.has(ch.id)) }))
      .sort((a, b) => b.found.length - a.found.length);
    const best = candidates[0];
    const proposed =
      best?.found.length > 0 && best.found.length !== (candidates[1]?.found.length ?? -1) ? best.party.id : '';
    showModal({
      title: 'Распознанные пати и порядок',
      content: `<form><p>Текущая пати: ${esc(state.parties.find(p => p.id === c.partyId)?.name || 'не выбрана')}. Распознано окон: ${known.size} из ${rows.length}. Автоматического переключения по проценту нет; порядок панели задач не используется.</p><label>Подтвердить управляющую пати<select name=partyId><option value="">Выберите явно</option>${candidates.map(p => option(p.party.id, `${p.party.name}: ${p.found.length}/${p.members.length}`, proposed)).join('')}</select></label>${candidates.map(p => `<h4>${esc(p.party.name)} · ${p.found.length}/${p.members.length}</h4><p>${p.members.map(ch => `${known.has(ch.id) ? '✓' : '—'} ${esc(ch.nick)}${c.leaders[p.party.id] === ch.id ? ' (ПЛ)' : ''}`).join(' → ')}</p>`).join('')}<p>✓ — окно распознано; — не запущено. Обычный обход идёт в сохранённом порядке пати. В составной команде блоки могут иметь другие пати; возврат задаётся отдельно.</p></form>`,
      submitText: 'Подтвердить пати',
      cancelText: 'Закрыть',
      onSubmit: async data => {
        const id = data.get('partyId');
        if (!id) {
          toast('Выберите пати явно.', 'error');
          return false;
        }
        await save({ partyId: id });
      }
    });
  });
  host.querySelector('[data-gm-party]').onchange = safe(e => save({ partyId: e.target.value }));
  host.querySelector('[data-gm-active-modifier]').onchange = safe(event =>
    save({ mirrorActiveModifier: event.target.value })
  );
  host.querySelector('[data-gm-twins-modifier]').onchange = safe(event =>
    save({ mirrorTwinsModifier: event.target.value })
  );
  host.querySelector('[data-gm-keyboard-source]').onchange = safe(event =>
    save({ mirrorKeyboardSource: event.target.value })
  );
  host.querySelector('[data-gm-keyboard-targets]').onchange = safe(event =>
    save({ mirrorKeyboardTargets: event.target.value })
  );
  host.querySelector('[data-gm-hold-only]').onchange = safe(event => save({ mirrorHoldOnly: event.target.checked }));
  host.querySelector('[data-gm-keyboard-method]').onchange = safe(event =>
    save({ mirrorKeyboardMethod: event.target.value })
  );
  host.querySelector('[data-gm-mirror-source]').onchange = safe(event => save({ mirrorSource: event.target.value }));
  host.querySelector('.gm-hotkey-master').onclick = e => e.stopPropagation();
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
      onSubmit: () => save(deleteCommandPlan(config(), selectedId))
    })
  );
  host.querySelector('[data-gm-preview]')?.addEventListener(
    'click',
    safe(async () => {
      if (selected.action === 'composite') await previewComposition(selectedId);
      else drawPoint(await previewCommand(selectedId));
    })
  );
  host.querySelector('[data-gm-background-probe]').onclick = () => {
    showModal({
      title: 'Диагностика фонового ввода',
      submitText: 'Закрыть',
      onSubmit: () => {},
      content: `<div class="gm-dialog"><p>Проверка одного распознанного клиента без нажатия клавиш. WM_NULL ждёт ответ до 25/100/250 мс, более длинные проверки пропускаются после первого успеха. Фокус и раскладка не меняются.</p><label>Проверяемый персонаж<select data-bg-char>${partyMembers(
        state,
        c.partyId
      )
        .map(char => option(char.id, char.nick, c.leaders[c.partyId]))
        .join(
          ''
        )}</select></label><label>Клавиша для расчёта VK/scan (не нажимается)<input data-bg-key value="B" maxlength="32"></label><button type="button" class="btn" data-bg-probe-run>Проверить без нажатия</button><fieldset><legend>Эксперимент уведомлений об активности</legend><p>Один B одному неактивному клиенту. Возможны активация клиентом и неверное внутреннее состояние. Уведомления не равны настоящему фокусу. Не используйте расходные действия. После запуска за 5 секунд вручную перейдите в другой клиент; выбранный получатель должен остаться неактивным. Не переключайте окна во время отправки.</p><label><input type="checkbox" data-bg-activity-confirm> Понимаю риск; разрешаю уведомления и один B</label><button type="button" class="btn ghost" data-bg-activity-run disabled>Уведомления активности + B (через 5 секунд)</button></fieldset><p data-bg-probe-status role="status"></p><label>Отчёт для копирования<textarea data-bg-probe-report readonly rows="14"></textarea></label><button type="button" class="btn ghost" data-bg-probe-copy>Выделить отчёт для копирования</button><p class="muted">После проверки сравните вручную: 1) та же клавиша физически в игре; 2) одношаговая команда с обычной доставкой; 3) три фоновых варианта по одному на двух клиентах. Обычный режим активирует окна — здесь он автоматически не запускается. Для каждого варианта запишите: сработало ли в активном/неактивном окне и исходное состояние интерфейса. Не используйте расходные действия.</p></div>`
    });
    const modal = document.querySelector('#modal-root');
    const button = modal.querySelector('[data-bg-probe-run]'),
      status = modal.querySelector('[data-bg-probe-status]'),
      report = modal.querySelector('[data-bg-probe-report]');
    const activity = modal.querySelector('[data-bg-activity-run]'),
      confirm = modal.querySelector('[data-bg-activity-confirm]');
    confirm.onchange = () => {
      activity.disabled = !confirm.checked;
    };
    const probe = async experimental => {
      if (experimental && !confirm.checked) return;
      button.disabled = true;
      activity.disabled = true;
      confirm.disabled = true;
      status.textContent = experimental
        ? 'Через 5 секунд отправится один B. Перейдите в другой клиент, получатель должен остаться неактивным.'
        : 'Проверяется окно; клавиши не отправляются…';
      try {
        report.value = await diagnoseBackground(
          modal.querySelector('[data-bg-char]').value,
          modal.querySelector('[data-bg-key]').value,
          ...(experimental ? [true] : [])
        );
        status.textContent = 'Готово. Отчёт также записан в журнал сеанса.';
      } catch (error) {
        status.textContent = error.message;
        report.value = error.message;
      } finally {
        button.disabled = false;
        confirm.disabled = false;
        activity.disabled = !confirm.checked;
      }
    };
    button.onclick = () => probe(false);
    activity.onclick = () => probe(true);
    modal.querySelector('[data-bg-probe-copy]').onclick = () => {
      report.focus();
      report.select();
      status.textContent = 'Отчёт выделен. Нажмите Ctrl+C.';
    };
  };
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
    host
      .querySelectorAll('[data-gm-point]')
      .forEach(button => button.setAttribute('aria-pressed', String(button.dataset.gmPoint === point.id)));
    detail.innerHTML = `<h4>${esc(point.name)}</h4><p>${point.width} × ${point.height} · DPI ${point.dpi} · (${point.x}, ${point.y}). Схема, не снимок игры.</p><div class="gm-point-map" style="aspect-ratio:${point.width}/${point.height}"><span style="left:${(point.x / point.width) * 100}%;top:${(point.y / point.height) * 100}%">⊕</span></div><button class="btn" data-point-edit>✎ Редактировать</button><button class="btn danger" data-point-delete aria-label="Удалить точку">🗑</button>`;
    detail.querySelector('[data-point-delete]').onclick = safe(() =>
      save({ points: config().points.filter(p => p.id !== point.id) })
    );
    detail.querySelector('[data-point-edit]').onclick = () => {
      let draft = { ...point },
        calibrationPending = false;
      const fields = () => {
        const form = document.querySelector('[data-point-edit-form]');
        return {
          ...draft,
          name: form.elements.namedItem('name').value.trim().slice(0, 80),
          x: Number(form.elements.namedItem('x').value),
          y: Number(form.elements.namedItem('y').value)
        };
      };
      showModal({
        title: 'Редактировать точку',
        onClose: () => {
          if (calibrationPending) stop();
        },
        content: `<form data-point-edit-form><label>Название<input class="input" name="name" maxlength="80" required value="${esc(point.name)}"></label><label>Игровое окно для показа / перемещения<select name="charId">${partyMembers(
          state,
          c.partyId
        )
          .map(ch => option(ch.id, ch.nick, c.leaders[c.partyId]))
          .join(
            ''
          )}</select></label><label>X<input class="input" name="x" type="number" min="0" max="${point.width - 1}" value="${point.x}"></label><label>Y<input class="input" name="y" type="number" min="0" max="${point.height - 1}" value="${point.y}"></label><p data-point-metric>${point.width} × ${point.height}, DPI ${point.dpi}</p><button type="button" class="btn" data-point-position>Показать / переместить точку в игре</button><p class="muted">Кликов в игру нет. После задания вернитесь в этот редактор и нажмите «Сохранить». Отмена не меняет сохранённую точку и ссылки команд.</p></form>`,
        submitText: 'Сохранить',
        cancelText: 'Отмена',
        onSubmit: async () => {
          if (calibrationPending) {
            toast('Сначала завершите задание точки в игре.', 'error');
            return false;
          }
          const value = fields();
          if (!value.name || !validPoint(value)) {
            toast('Введите название и целые координаты внутри игровой области.', 'error');
            return false;
          }
          if (!config().points.some(p => p.id === point.id)) {
            toast('Точка уже удалена.', 'error');
            return false;
          }
          await save({ points: config().points.map(p => (p.id === point.id ? value : p)) });
        }
      });
      document.querySelector('[data-point-edit-form]').onsubmit = event => {
        event.preventDefault();
        document.querySelector('#modal-root .modal-footer .primary')?.click();
      };
      document.querySelector('[data-point-position]').onclick = safe(async () => {
        const form = document.querySelector('[data-point-edit-form]');
        const value = fields();
        if (calibrationPending) return;
        calibrationPending = true;
        try {
          draft = await pickPoint(
            form.elements.namedItem('charId').value,
            value.name || point.name,
            point.id,
            c.partyId,
            true,
            value
          );
          form.elements.namedItem('x').value = draft.x;
          form.elements.namedItem('x').max = draft.width - 1;
          form.elements.namedItem('y').value = draft.y;
          form.elements.namedItem('y').max = draft.height - 1;
          form.querySelector('[data-point-metric]').textContent = `${draft.width} × ${draft.height}, DPI ${draft.dpi}`;
        } finally {
          calibrationPending = false;
        }
      });
    };
  };
  host
    .querySelectorAll('[data-gm-point]')
    .forEach(button => (button.onclick = () => drawPoint(config().points.find(p => p.id === button.dataset.gmPoint))));
  drawPoint(c.points.find(p => p.id === selectedPointId) || c.points[0]);
  const update = () => {
    if (!host.isConnected) return;
    const data = snapshot();
    const latestRun = getExecutionHistory().at(-1);
    host.querySelector('[data-gm-outcome]').innerHTML = latestRun ? outcomeHtml(summarizeExecution(latestRun)) : '';
    const technical = host.querySelector('[data-lab-technical]');
    if (technical) {
      const latest = [...getExecutionHistory()]
        .reverse()
        .find(run => run.commandId === selected.id && run.fingerprint === commandFingerprint(selected, c));
      technical.textContent = latest
        ? `Технический запуск ${latest.runId.slice(0, 8)}: ${latest.state}; этап ${latest.stage}. Результат игры неизвестен до ручной отметки.`
        : 'Для текущих настроек нет технического запуска в этом сеансе.';
    }

    host.querySelector('[data-gm-enabled]').checked = config().enabled;
    const mirror = host.querySelector('[data-gm-mirror]');
    updateRepeatButton(mirror, 'keyboard', data);
    const pause = host.querySelector('[data-gm-pause]');
    pause.textContent = data.paused ? '▶ Продолжить' : 'Ⅱ Пауза';
    pause.setAttribute('aria-pressed', String(!!data.paused));
    const mouse = host.querySelector('[data-gm-mirror-mouse]');
    updateRepeatButton(mouse, 'mouse', data);
    host
      .querySelectorAll(
        'button:not([data-gm-stop]):not([data-gm-pause]):not([data-gm-mirror]):not([data-gm-mirror-mouse]),input,select'
      )
      .forEach(input => {
        input.disabled = data.busy;
      });
    host.querySelector('[data-gm-reconnect]').disabled = !!data.busy || !!data.mirrorPending;
    mirror.disabled = data.busy && !data.mirrorKeys;
    mouse.disabled = data.busy && !data.mirrorMouse;
    const log = document.querySelector('[data-gm-log-text]');
    if (log) log.textContent = data.logs.join('\n') || 'Журнал пуст.';
  };
  if (updateListener) window.removeEventListener('tf-game-macros-changed', updateListener);
  updateListener = update;
  window.addEventListener('tf-game-macros-changed', update);
  update();
  const restoreScroll = () =>
    scroll.forEach(({ node, selector, top, left }) => {
      const target = selector ? host.querySelector(selector) : node;
      if (target) {
        target.scrollTop = top;
        target.scrollLeft = left;
      }
    });
  restoreScroll();
  const scrollEpoch = (host._gmScrollEpoch = (host._gmScrollEpoch || 0) + 1);
  window.requestAnimationFrame?.(() => {
    if (host.isConnected && host._gmScrollEpoch === scrollEpoch) restoreScroll();
  });
  void initGameMacros();
}
export function openMacrosDialog(action) {
  if (action === 'logs') {
    showModal({
      title: 'Журнал команд · текущий сеанс',
      wide: true,
      content: `<div class="gm-dialog"><p class="muted">Только действия команд с момента запуска приложения. Журнал не сохраняется на диск; хранятся последние 300 строк. Очистка не останавливает команду; новые записи продолжат появляться.</p><div class="gm-journal-actions" role="group" aria-label="Действия с журналом"><button type="button" class="btn ghost" data-gm-copy-logs>Копировать весь лог</button><button type="button" class="btn ghost" data-gm-clear-logs>Очистить лог</button></div><p class="muted" data-gm-copy-status role="status" aria-live="polite"></p><pre data-gm-log-text class="gm-log">${esc(snapshot().logs.join('\n') || 'Журнал пуст.')}</pre></div>`,
      submitText: null,
      cancelText: 'Закрыть'
    });
    const dialog = document.querySelector('[data-gm-copy-logs]').closest('.gm-dialog');
    const copy = dialog.querySelector('[data-gm-copy-logs]');
    copy.onclick = safe(async () => {
      copy.disabled = true;
      try {
        await copyJournal(snapshot().logs, dialog, dialog.querySelector('[data-gm-copy-status]'));
      } finally {
        copy.disabled = false;
      }
    });
    document.querySelector('[data-gm-clear-logs]').onclick = safe(async () => {
      await clearLogs();
      dialog.querySelector('[data-gm-journal-copy-fallback]')?.remove();
      dialog.querySelector('[data-gm-copy-status]').textContent = '';
      const text = document.querySelector('[data-gm-log-text]');
      if (text) text.textContent = snapshot().logs.join('\n') || 'Журнал пуст.';
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
