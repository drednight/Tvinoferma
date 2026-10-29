// Только визуальный макет. В нём нет доступа к реальным данным или облачным сервисам.
import { escapeHtml } from '../app/replica/js/core/utils.js';
import { parseCloudModifiedTime } from '../app/replica/js/modules/cloudSync/providers/modifiedTime.js';
import { createCloudAccountConfirmation } from '../../js/modules/cloudSync/ui/confirmCloudAccount.js';
import { DemoDiskWorkflow, DEMO_PROVIDERS } from './workflow.js';

// Только фиксированные вымышленные значения; сюда не поступают реальные аккаунты или токены.
const DEMO_ACCOUNTS = Object.freeze({
  google: Object.freeze({
    clientId: '123456789-example.apps.googleusercontent.com',
    label: Object.freeze({ kind: 'email', value: 'primer@example.test' })
  }),
  yandex: Object.freeze({
    clientId: '0123456789abcdef0123456789abcdef',
    label: Object.freeze({ kind: 'login', value: 'primer-tvinoferma' })
  })
});

const esc = escapeHtml;
const FILTERS = [
  ['all', 'Все'],
  ['added', 'Добавлено'],
  ['changed', 'Изменено'],
  ['deleted', 'Удалено'],
  ['calendar', 'Календарь']
];
const KIND_LABELS = { added: 'Добавлено', changed: 'Изменено', deleted: 'Удалено' };
const icons = {
  cloud:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.5 18.2h9.2a3.8 3.8 0 0 0 .5-7.6 5.5 5.5 0 0 0-10.7-1.2A4.4 4.4 0 0 0 7.5 18.2Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m9.5 13 2.5-2.5 2.5 2.5M12 10.7v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upload:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M5 15v4h14v-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v4h-4M4 17v-4h4m11-2a7 7 0 0 0-12-3M5 13a7 7 0 0 0 12 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
};

function visibleFor(rows, filter) {
  return rows.filter(
    row => filter === 'all' || (filter === 'calendar' ? row.section === 'Календарь' : row.kind === filter)
  );
}

// Отображаем только распознанные даты. Время показывается в часовом поясе этого ПК;
// метка диска не доказывает свежесть или порядок зашифрованных версий.
function dateForDisplay(value) {
  const iso = parseCloudModifiedTime(value);
  if (!iso) return null;
  try {
    const text = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(iso));
    return { iso, text };
  } catch {
    return null;
  }
}

function timeMarkup(value) {
  const date = dateForDisplay(value);
  return date ? `<time datetime="${esc(date.iso)}">${esc(date.text)}</time>` : '<span>Дата недоступна</span>';
}

function ageAtCheck(file, checked) {
  if (!file || !checked) return '';
  const elapsed = Date.parse(checked) - Date.parse(file);
  if (elapsed < 0) return '';
  if (elapsed < 60_000) return 'менее минуты назад';
  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000]
  ];
  const [unit, milliseconds] = units.find(([, size]) => elapsed >= size);
  try {
    return `примерно ${new Intl.RelativeTimeFormat('ru-RU', { numeric: 'always' }).format(-Math.floor(elapsed / milliseconds), unit)}`;
  } catch {
    return '';
  }
}

function reviewTimesHtml(times) {
  const file = parseCloudModifiedTime(times?.fileModifiedAt);
  const checked = parseCloudModifiedTime(times?.checkedAt);
  const future = file && checked && Date.parse(file) - Date.parse(checked) > 5 * 60 * 1000;
  const age = ageAtCheck(file, checked);
  return `<section class="csc-review-times" aria-labelledby="csc-times-title" data-cs-review-times>
    <div class="csc-review-times-head"><strong id="csc-times-title">Дата файла для сравнения</strong><span>ВЫМЫШЛЕННЫЙ ПРИМЕР</span></div>
    <dl class="csc-time-grid">
      <div class="csc-time-cloud" data-cs-file-date><dt>Входящий файл на диске</dt><dd>${timeMarkup(times?.fileModifiedAt)}<small>Дата изменения по данным диска${age ? ` · ${esc(age)}` : ''}</small></dd></div>
      <div data-cs-checked-date><dt>Проверено на этом ПК</dt><dd>${timeMarkup(times?.checkedAt)}<small>Время последней проверки в примере</small></dd></div>
      <div data-cs-local-date><dt>Сохранение на этом ПК</dt><dd>${timeMarkup(times?.localSavedAt)}<small>На момент сравнения в примере</small></dd></div>
    </dl>
    <p>Время показано по часовому поясу этого ПК. Дата файла не означает, что каждое изменение сделано в этот момент, и не доказывает, какая версия актуальнее.</p>
    ${future ? '<p class="csc-time-warning" role="note">⚠ Дата файла более чем на 5 минут позже часов этого ПК. Проверьте время на устройствах; по одной дате выбирать версию нельзя.</p>' : ''}
  </section>`;
}

function comparisonHtml(state, filter) {
  if (!state.checked) return '';
  const filtered = visibleFor(state.differences, filter);
  const selected = new Set(state.selected);
  const shownIds = new Set(filtered.map(row => row.id));
  const hiddenSelected = state.selected.filter(id => !shownIds.has(id)).length;
  const canSelectVisible = filtered.some(row => !selected.has(row.id));
  const deletions = state.differences.filter(row => selected.has(row.id) && row.kind === 'deleted');
  return `<section class="csc-comparison" aria-labelledby="csc-comparison-title">
    <div class="csc-comparison-head"><div><span class="csc-overline">СРАВНЕНИЕ · ТОЛЬКО ПРИМЕР</span><h4 id="csc-comparison-title">Что отличается на диске?</h4><p>Сравнение показывает вымышленные данные. Отметьте, что хотите обновить на этом ПК.</p></div><span class="csc-compare-example">${esc(DEMO_PROVIDERS[state.provider])}</span></div>
    ${reviewTimesHtml(state.reviewTimes)}
    ${
      state.differences.length
        ? `
      <div class="csc-filters" role="group" aria-label="Фильтр различий в примере">
        ${FILTERS.map(([key, label]) => `<button type="button" data-cs-filter="${key}" aria-pressed="${key === filter}">${esc(label)} <span>${visibleFor(state.differences, key).length}</span></button>`).join('')}
      </div>
      <div class="csc-selection"><div class="csc-selection-actions" role="group" aria-label="Массовый выбор различий">
        <button type="button" class="btn small" data-cs-select-all ${canSelectVisible ? '' : 'disabled'}>Выбрать все</button>
        <button type="button" class="btn small ghost" data-cs-clear-all ${selected.size ? '' : 'disabled'}>Снять все</button>
      </div><span>Выбрано: <strong>${selected.size} из ${state.differences.length}</strong>${hiddenSelected ? ` · скрыто фильтром: <strong>${hiddenSelected}</strong>` : ''}</span></div>
      <p class="csc-selection-note">«Выбрать все» отмечает показанные различия; «Снять все» снимает и скрытые фильтром отметки.</p>
      ${
        filtered.length
          ? `<ul class="csc-diff-list">${filtered
              .map(
                row => `<li class="csc-diff-row" data-cs-diff="${esc(row.kind)}">
        <div class="csc-diff-top"><span class="csc-diff-badge is-${esc(row.kind)}">${esc(KIND_LABELS[row.kind])}</span><span class="csc-diff-section">${esc(row.section)}</span></div>
        <strong>${esc(row.title)}</strong><span class="csc-diff-field">${esc(row.field)}</span>
        <div class="csc-diff-versions"><div><small>НА ЭТОМ ПК</small><span>${esc(row.local)}</span></div><span class="csc-diff-arrow" aria-hidden="true">→</span><div><small>НА ДИСКЕ</small><span>${esc(row.cloud)}</span></div></div>
        <label class="csc-diff-select"><input type="checkbox" data-cs-select="${esc(row.id)}" ${selected.has(row.id) ? 'checked' : ''}><span>Обновить на этом ПК<span class="csc-sr-only">: ${esc(row.title)}</span></span></label>
      </li>`
              )
              .join('')}</ul>`
          : '<p class="csc-empty">В этом фильтре различий нет.</p>'
      }
      <p class="csc-compare-note">Неотмеченные данные не обновляются. Отсутствие записи само по себе не означает удаление; удаление в примере подтверждено отдельной отметкой.</p>
      ${state.confirmingDeletion ? `<div class="csc-confirm" role="alert"><strong>В выборе есть удаление: ${deletions.length}.</strong><p>Будут применены все выбранные изменения, включая эти удаления:</p><ul>${deletions.map(row => `<li>${esc(row.title)}</li>`).join('')}</ul><p>В настоящем приложении потребуется резервная копия. Здесь изменится только пример.</p><div><button type="button" class="btn small danger" data-cs-confirm-delete>Подтвердить удаление в примере</button><button type="button" class="btn small ghost" data-cs-cancel-delete>Вернуться к выбору</button></div></div>` : ''}
      <div class="csc-compare-footer"><span>Перед реальным обновлением нужна резервная копия.</span><button type="button" class="btn primary small" data-cs-update ${selected.size && !state.confirmingDeletion ? '' : 'disabled'}>Обновить выбранное · ${selected.size}</button></div>
    `
        : '<p class="csc-empty">В этом вымышленном примере различий больше нет.</p>'
    }
  </section>`;
}

function logHtml(logs, canOpenLog) {
  const items = logs.slice(0, 3);
  return `<section class="csc-history" aria-labelledby="csc-history-title">
    <div class="csc-history-head"><div><span class="csc-overline">ИСТОРИЯ · ПРИМЕР</span><h4 id="csc-history-title">Журнал синхронизации</h4></div><button type="button" class="csc-link" data-cs-open-log ${canOpenLog ? '' : 'disabled'}>Открыть общий журнал</button></div>
    ${items.length ? `<ul>${items.map(item => `<li><span class="csc-history-dot"></span><div><strong>${item.action === 'upload' ? 'Пример отправки' : 'Пример обновления'}</strong><small>${esc(DEMO_PROVIDERS[item.provider])} · ${item.action === 'upload' ? 'условная версия' : `выбрано: ${item.changes.length}`}</small></div><time datetime="${esc(item.at)}">${esc(new Date(item.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time></li>`).join('')}</ul>` : '<p>После действий в примере здесь появятся записи. Настоящие данные не меняются.</p>'}
  </section>`;
}

/** Демонстрация внутри копии приложения. Обратные вызовы подключают только демо-журнал. */
export function mountCloudSyncDemo(root, { onLog, onReset, openLog, getLogs, subscribeLogs, exampleWorkflow } = {}) {
  let workflow = exampleWorkflow || new DemoDiskWorkflow();
  let panelOpen = false;
  let filter = 'all';
  let secretOptions = { email: false, recoveryEmail: false, phone: false, password: false };
  // Только демонстрация будущих вариантов; реальные секреты в макет не вводятся.
  let keyOptions = { primary: 'password', backup: 'generated' };
  let keyLossOpen = false;
  let checkHelpOpen = false;
  let automatic = { check: true, upload: true };
  let notice = 'Действия ниже только показывают сценарий. Реальный диск не подключён.';
  const confirmExample = createCloudAccountConfirmation({ example: true });
  let exampleRun = null;

  function cancelExample() {
    const run = exampleRun;
    exampleRun = null;
    run?.controller.abort();
  }

  function render() {
    // Если фоновое обновление перерисует макет, старое подтверждение больше не актуально.
    cancelExample();
    const active = document.activeElement;
    let focusSelector = null;
    if (active && root.contains(active)) {
      const attributes = [
        'data-cs-toggle',
        'data-cs-upload',
        'data-cs-check',
        'data-cs-update',
        'data-cs-select',
        'data-cs-filter',
        'data-cs-select-all',
        'data-cs-clear-all',
        'data-cs-confirm-delete',
        'data-cs-cancel-delete',
        'data-cs-provider',
        'data-cs-account-example',
        'data-cs-key-primary',
        'data-cs-key-backup',
        'data-cs-key-loss-toggle',
        'data-cs-secrets',
        'data-cs-auto',
        'data-cs-open-log',
        'data-cs-reset'
      ];
      const attribute = attributes.find(name => active.hasAttribute(name));
      focusSelector = attribute ? `[${attribute}=${JSON.stringify(active.getAttribute(attribute))}]` : '.csc-feedback';
    }
    const state = workflow.snapshot();
    const logs = typeof getLogs === 'function' ? getLogs() : state.logs;
    root.innerHTML = `<details class="csc-shell" data-cs-panel ${panelOpen ? 'open' : ''}>
      <summary class="csc-summary" data-cs-toggle>
        <span class="csc-hero-icon">${icons.cloud}</span><span class="csc-title"><span><strong>Синхронизация между ПК</strong><em>МАКЕТ</em></span><small>Личный диск · ${esc(DEMO_PROVIDERS[state.provider])}</small></span>
        <span class="csc-connection"><i></i>Не подключён</span><span class="csc-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="csc-content">
        <div class="csc-disclaimer"><span>i</span><p><strong>Только демонстрация.</strong> Диск и данные вымышлены. Ничего не отправляется, не сохраняется после перезагрузки и не меняет данные приложения. Не вводите настоящие пароли.</p></div>
        <fieldset class="csc-provider-choice"><legend>Личный диск <span>· выбор в примере</span></legend><div class="csc-provider-options">
          <label><input type="radio" name="csc-provider" value="google" data-cs-provider="google" ${state.provider === 'google' ? 'checked' : ''}><span><strong>Google Диск</strong><small>Не подключён</small></span></label>
          <label><input type="radio" name="csc-provider" value="yandex" data-cs-provider="yandex" ${state.provider === 'yandex' ? 'checked' : ''}><span><strong>Яндекс Диск</strong><small>Не подключён</small></span></label>
        </div><p>В рабочей версии потребуется подключить личную учётную запись выбранного диска. Вход планируется в системном браузере: пароль от диска не вводится в Твиноферму.</p><p>Если доступ истечёт или будет отозван, программа должна предупредить и при необходимости предложить войти снова. Локальные данные при этом не удаляются.</p>
          <div class="csc-account-example"><div><strong>Как будет проверяться аккаунт</strong><p>Окно ниже показывает вымышленные данные и никого не подключает.</p></div><button type="button" class="btn small" data-cs-account-example>Посмотреть пример подтверждения</button></div>
        </fieldset>
        <section class="csc-actions" aria-label="Действия с диском в примере"><span class="csc-overline">ДЕЙСТВИЯ · ПРИМЕР</span><div class="csc-action-grid">
          <div><button type="button" class="btn primary" data-cs-upload>${icons.upload} Сохранить и отправить на диск</button><p>Создать отдельную версию данных этого ПК на выбранном диске.</p></div>
          <div><button type="button" class="btn" data-cs-check>${icons.refresh} Проверить обновления</button><p>Сравнить с диском и выбрать, что обновить на этом ПК.</p></div>
        </div><div class="csc-auto" role="group" aria-label="Автоматические действия в примере">
          <label><input type="checkbox" data-cs-auto="check" ${automatic.check ? 'checked' : ''}> Проверять диск при запуске</label>
          <label><input type="checkbox" data-cs-auto="upload" ${automatic.upload ? 'checked' : ''}> Отправлять сохранённые изменения автоматически</label>
        </div><p class="csc-auto-note">Входящие изменения не применяются без вашего выбора. При конфликтах автоматическая отправка должна ждать решения.</p>
          <details class="csc-check-help" data-cs-check-help ${checkHelpOpen ? 'open' : ''}>
            <summary data-cs-check-help-toggle>Как будет работать проверка?</summary>
            <p>В рабочей версии планируется:</p>
            <ul>
              <li>При ошибке или отсутствии доступа показывать причину и время последней успешной проверки, не применяя старый результат.</li>
              <li>Если файл не найден, не удалять данные на ПК и не перезаписывать диск автоматически.</li>
              <li>Если обе стороны изменились, показать конфликт и предложить выбор, а не решать по дате файла.</li>
              <li>Перед применением заново проверить, не изменились ли данные, и сохранить резервную копию. Удаление подтвердить отдельно.</li>
            </ul>
          </details>
        </section>
        <p class="csc-feedback" role="status" aria-live="polite" tabindex="-1">${esc(notice)}</p>
        ${comparisonHtml(state, filter)}
        ${logHtml(logs, typeof openLog === 'function')}
        <section class="csc-scope" aria-label="Что планируется синхронизировать"><span class="csc-overline">СОСТАВ ДАННЫХ · ПЛАН</span><div><span>Марафоны и прогресс сайта</span><span>Персонажи и история</span><span>Пати и финансы</span><span>События, задачи и отметки</span><span>Выбранные настройки и журналы</span></div><p>Повторы, напоминания и отметки по датам тоже учитываются. Ответы на клановом сайте не отправляются автоматически.</p></section>
        <fieldset class="csc-key-choice"><legend>Доступ к облачной копии <span>· план</span></legend>
          <p>Это отдельная защита: не пароль Диска и не пароли персонажей.</p>
          <div class="csc-key-group" role="group" aria-label="Основной способ доступа в примере"><strong>Основной доступ</strong><div class="csc-key-options">
            <label><input type="radio" name="csc-key-primary" value="password" data-cs-key-primary="password" ${keyOptions.primary === 'password' ? 'checked' : ''}><span><strong>Пароль шифрования</strong><small>Вы придумываете свой пароль или фразу.</small></span></label>
            <label><input type="radio" name="csc-key-primary" value="custom" data-cs-key-primary="custom" ${keyOptions.primary === 'custom' ? 'checked' : ''}><span><strong>Свой основной ключ</strong><small>Вы задаёте свой секретный код или фразу.</small></span></label>
          </div></div>
          <div class="csc-key-group" role="group" aria-label="Запасной способ доступа в примере"><strong>Запасной ключ</strong><div class="csc-key-options">
            <label><input type="radio" name="csc-key-backup" value="generated" data-cs-key-backup="generated" ${keyOptions.backup === 'generated' ? 'checked' : ''}><span><strong>Создать случайный</strong><small>Создаст приложение; его нужно сохранить.</small></span></label>
            <label><input type="radio" name="csc-key-backup" value="custom" data-cs-key-backup="custom" ${keyOptions.backup === 'custom' ? 'checked' : ''}><span><strong>Задать свой запасной ключ</strong><small>Вместо случайного ключа вы задаёте свой.</small></span></label>
          </div></div>
          <div class="csc-key-preview" aria-label="Поля будущей настройки">
            <label>${keyOptions.primary === 'password' ? 'Пароль шифрования' : 'Ваш основной ключ'}<input type="password" data-cs-key-preview="primary" autocomplete="off" placeholder="Ввод будет доступен в рабочей версии" disabled></label>
            ${keyOptions.backup === 'custom' ? '<label>Ваш запасной ключ<input type="password" data-cs-key-preview="backup" autocomplete="off" placeholder="Ввод будет доступен в рабочей версии" disabled></label>' : ''}
          </div>
          <p class="csc-key-warning">Основной и запасной секреты должны быть разными и надёжными. Предсказуемые слова или короткие коды могут подобрать. Храните запасной ключ отдельно от облачной копии.</p>
          <p class="csc-key-demo">Только вид настройки: ввод, создание, проверка и восстановление ключей в макете отключены.</p>
          <details class="csc-key-loss" data-cs-key-loss ${keyLossOpen ? 'open' : ''}>
            <summary data-cs-key-loss-toggle>Если потеряны оба ключа</summary>
            <div><p>Сначала проверьте, сохранился ли доступ к внутреннему ключу на другом доверенном ПК. Если да, можно будет настроить новые способы доступа к той же копии.</p>
              <p>Если ключей нигде нет, но данные остались на ПК, понадобится резервная копия и новая синхронизация с новыми ключами. Старый файл на диске удалять не требуется; на остальных ПК сначала нужно сохранить данные и сравнить их.</p>
              <p><strong>Без ключей старую облачную копию расшифровать не получится. Если локальных данных и резервной копии тоже нет, данные восстановить нельзя.</strong></p>
              <button type="button" class="btn small" data-cs-key-loss-restart disabled>Начать заново · пока недоступно</button>
              <small>Это описание будущего сценария. Макет не создаёт ключи, не делает резервную копию и ничего не удаляет.</small>
            </div>
          </details>
        </fieldset>
        <section class="csc-security"><span class="csc-security-icon">${icons.lock}</span><div><strong>Контакты и пароли — только по отдельному выбору</strong><p>Все пункты выключены по умолчанию. В рабочей версии данные должны шифроваться до отправки. В макете ввод и перенос паролей не реализованы.</p><div class="csc-secret-options" role="group" aria-label="Дополнительные данные в примере">
          <label><input type="checkbox" data-cs-secrets="email" ${secretOptions.email ? 'checked' : ''}> Email</label>
          <label><input type="checkbox" data-cs-secrets="recoveryEmail" ${secretOptions.recoveryEmail ? 'checked' : ''}> Почта восстановления</label>
          <label><input type="checkbox" data-cs-secrets="phone" ${secretOptions.phone ? 'checked' : ''}> Телефон</label>
          <label class="csc-password-option"><input type="checkbox" data-cs-secrets="password" ${secretOptions.password ? 'checked' : ''}> Пароли <small>повышенный риск</small></label>
        </div>${secretOptions.password ? '<p class="csc-risk" role="note">Пароли особенно чувствительны. В рабочей функции потребуется отдельное подтверждение риска; ключ восстановления хранится отдельно от диска.</p>' : ''}</div></section>
        <p class="csc-footnote">При первом подключении существующих данных нужны сравнение и резервная копия. Сессии сайта, статусы входа и пути к игре остаются на каждом ПК отдельно.</p>
        <button type="button" class="csc-link csc-reset" data-cs-reset>Сбросить пример</button>
      </div>
    </details>`;
    if (focusSelector) {
      const target = root.querySelector(focusSelector);
      let alternative = null;
      if (target?.disabled && target.hasAttribute('data-cs-select-all'))
        alternative = root.querySelector('[data-cs-clear-all]');
      if (target?.disabled && target.hasAttribute('data-cs-clear-all'))
        alternative = root.querySelector('[data-cs-select-all]');
      if (target?.disabled && target.hasAttribute('data-cs-update'))
        alternative = root.querySelector('[data-cs-confirm-delete]');
      const fallback = alternative && !alternative.disabled ? alternative : root.querySelector('.csc-feedback');
      (target && !target.disabled ? target : fallback)?.focus({ preventScroll: true });
    }
  }

  function showAccountExample() {
    if (exampleRun) return;
    const provider = workflow.snapshot().provider;
    const account = DEMO_ACCOUNTS[provider];
    if (!account) return;
    const run = { controller: new AbortController() };
    exampleRun = run;
    void confirmExample({ provider, ...account, signal: run.controller.signal })
      .then(confirmed => {
        if (exampleRun !== run) return;
        exampleRun = null;
        notice = confirmed
          ? 'Пример подтверждён; это не подключение, никаких запросов и изменений данных не было.'
          : 'Пример подтверждения закрыт; диск не подключён и данные не изменены.';
        render();
      })
      .catch(() => {
        if (exampleRun !== run) return;
        exampleRun = null;
        notice = 'Не удалось показать пример подтверждения. Диск не подключён, данные не изменены.';
        render();
      });
  }

  function emitLog(event) {
    try {
      onLog?.(event);
    } catch {
      notice = 'Действие осталось в примере, но его не удалось добавить в общий демо-журнал.';
    }
  }

  function finishUpdate(result) {
    if (result.status === 'confirm-deletion') {
      notice = 'Выбрано удаление. Подтвердите его отдельно или вернитесь к выбору.';
    } else if (result.status === 'updated') {
      emitLog(result.event);
      if (!notice.includes('не удалось добавить'))
        notice = `В примере обновлено: ${result.event.changes.length}. Неотмеченные различия остались без изменений.`;
    } else notice = 'Сначала выберите данные для обновления.';
  }

  const onClick = event => {
    const checkHelpToggle = event.target.closest('[data-cs-check-help-toggle]');
    if (checkHelpToggle && root.contains(checkHelpToggle)) {
      event.preventDefault();
      checkHelpOpen = !checkHelpOpen;
      render();
      return;
    }
    const keyLossToggle = event.target.closest('[data-cs-key-loss-toggle]');
    if (keyLossToggle && root.contains(keyLossToggle)) {
      event.preventDefault();
      keyLossOpen = !keyLossOpen;
      render();
      return;
    }
    const toggle = event.target.closest('[data-cs-toggle]');
    if (toggle && root.contains(toggle)) {
      event.preventDefault();
      panelOpen = !panelOpen;
      render();
      return;
    }
    const button = event.target.closest('button');
    if (!button || !root.contains(button) || button.disabled) return;
    if (button.hasAttribute('data-cs-account-example')) {
      showAccountExample();
      return;
    }
    if (button.hasAttribute('data-cs-upload')) {
      notice = 'Пример: создана условная версия. Другие версии не перезаписывались; проверьте различия заново.';
      emitLog(workflow.upload());
    } else if (button.hasAttribute('data-cs-check')) {
      workflow.check();
      filter = 'all';
      notice = 'Пример сравнения готов. Выберите, что обновить; пока ничего не изменено.';
    } else if (button.dataset.csFilter && FILTERS.some(([key]) => key === button.dataset.csFilter)) {
      filter = button.dataset.csFilter;
    } else if (button.hasAttribute('data-cs-select-all')) {
      const rows = visibleFor(workflow.snapshot().differences, filter);
      workflow.selectVisible(rows.map(row => row.id));
      notice = `Отмечены показанные различия: ${rows.length}. Скрытые ранее отметки сохранены.`;
    } else if (button.hasAttribute('data-cs-clear-all')) {
      workflow.clearSelection();
      notice = 'Все отметки сняты, включая скрытые фильтром; данные примера не изменены.';
    } else if (button.hasAttribute('data-cs-update')) {
      notice = '';
      finishUpdate(workflow.requestUpdate());
    } else if (button.hasAttribute('data-cs-confirm-delete')) {
      notice = '';
      finishUpdate(workflow.confirmDeletion());
    } else if (button.hasAttribute('data-cs-cancel-delete')) {
      workflow.cancelDeletion();
      notice = 'Удаление не применено. Можно изменить выбор.';
    } else if (button.hasAttribute('data-cs-open-log')) {
      openLog?.();
      return;
    } else if (button.hasAttribute('data-cs-reset')) {
      workflow = new DemoDiskWorkflow();
      filter = 'all';
      secretOptions = { email: false, recoveryEmail: false, phone: false, password: false };
      keyOptions = { primary: 'password', backup: 'generated' };
      keyLossOpen = false;
      checkHelpOpen = false;
      automatic = { check: true, upload: true };
      try {
        onReset?.();
      } catch {
        /* журнал демо не должен мешать сбросу */
      }
      notice = 'Пример сброшен. Реальные данные не затронуты.';
    } else return;
    render();
  };

  const onChange = event => {
    const target = event.target;
    if (target.matches('[data-cs-provider]') && Object.hasOwn(DEMO_PROVIDERS, target.dataset.csProvider)) {
      if (workflow.chooseProvider(target.dataset.csProvider)) {
        filter = 'all';
        notice = 'Для другого диска загружен отдельный вымышленный пример; старый выбор сброшен.';
      }
    } else if (target.matches('[data-cs-select]')) {
      workflow.select(target.dataset.csSelect, target.checked);
    } else if (
      target.matches('[data-cs-key-primary]') &&
      target.checked &&
      ['password', 'custom'].includes(target.dataset.csKeyPrimary)
    ) {
      keyOptions.primary = target.dataset.csKeyPrimary;
      notice = 'Способ доступа выбран только в примере. Ввод настоящих ключей отключён.';
    } else if (
      target.matches('[data-cs-key-backup]') &&
      target.checked &&
      ['generated', 'custom'].includes(target.dataset.csKeyBackup)
    ) {
      keyOptions.backup = target.dataset.csKeyBackup;
      notice = 'Способ восстановления выбран только в примере. Ввод настоящих ключей отключён.';
    } else if (target.matches('[data-cs-secrets]') && Object.hasOwn(secretOptions, target.dataset.csSecrets)) {
      secretOptions[target.dataset.csSecrets] = target.checked;
      notice = 'Это только вид переключателя: контакты и пароли не вводятся и не передаются.';
    } else if (target.matches('[data-cs-auto]') && Object.hasOwn(automatic, target.dataset.csAuto)) {
      automatic[target.dataset.csAuto] = target.checked;
      notice = 'Автоматические действия в макете не выполняются.';
    } else return;
    render();
  };

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  const unsubscribeLogs =
    typeof subscribeLogs === 'function'
      ? subscribeLogs(() => {
          if (typeof getLogs === 'function') workflow.logs = getLogs();
          render();
        })
      : null;
  render();
  return {
    snapshot: () => workflow.snapshot(),
    destroy() {
      cancelExample();
      unsubscribeLogs?.();
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.innerHTML = '';
    }
  };
}
