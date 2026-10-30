// @ts-check
// Экспериментальный просмотр только УЖЕ закреплённого набора. Не создаёт набор,
// ключи или очередь, не отправляет и не считает выборочное применение слиянием.
// Значения сравнения могут быть личными: выводить только текстом, не журналировать.
import { checkConnectedCloud } from '../checkConnectedCloud.js';
import { stageReviewedCloudApply } from '../commitReviewedCloud.js';
import { stageSyncIdentities } from '../commitSyncIdentities.js';
import { reconcileExactCloudBase } from '../reconcileExactCloudBase.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';

const LABELS = Object.freeze({
  characters: 'Персонажи',
  parties: 'Пати',
  marathons: 'Марафоны',
  planner: 'Календарь и задачи',
  finance: 'Финансы',
  preferences: 'Настройки'
});
const GROUPS = Object.freeze({
  appearance: 'Тема',
  navigation: 'Меню разделов',
  planner: 'Вид календаря',
  eventReminders: 'Напоминания'
});
const MESSAGES = Object.freeze({
  binding_missing:
    'Набор синхронизации на этом ПК ещё не настроен. Отсутствие записи не доказывает, что старого облака нет.',
  binding_blocked: 'Привязка, ключ или аккаунт не подтверждены. Ничего не изменено; требуется восстановление.',
  binding_unavailable: 'Не удалось прочитать привязку и ключ. Ничего не изменено.',
  credential_missing: 'Сохранённый доступ к диску не найден.',
  credential_blocked: 'Сохранённый доступ требует восстановления.',
  credential_unavailable: 'Не удалось подтвердить доступ к диску.',
  account_mismatch: 'Аккаунт на диске не совпадает с закреплённым. Данные не применялись.',
  account_unavailable: 'Не удалось подтвердить аккаунт у сервиса. Данные не применялись.',
  queue_not_ready: 'Локальный журнал синхронизации не подтверждён. Создание нового журнала автоматически запрещено.',
  history_unverified: 'Не удалось проверить историю, ключ или ранее известные версии. Данные не применялись.',
  unavailable: 'Диск недоступен. Данные не применялись.',
  changed: 'Облачный список изменился во время проверки. Проверьте заново.',
  cancelled: 'Проверка отменена. Уже начатый запрос мог завершиться.',
  storage_blocked: 'Сохранение остановлено. Проверьте данные и резервные копии перед перезапуском.',
  state_changed: 'Локальные данные изменились после просмотра. Выполните проверку заново.',
  state_changed_or_unsaved: 'Локальные данные изменились или ещё не сохранены. Выполните проверку заново.',
  disk_changed_or_unsaved: 'Состояние на диске и в памяти не совпадает. Сначала сохраните данные и проверьте заново.',
  backup_unconfirmed_restart:
    'Копия не подтверждена. Применение и сохранение остановлены; проверьте данные и копии перед перезапуском.',
  state_changed_after_backup_restart:
    'Данные изменились во время копирования. Применение остановлено; проверьте несохранённые изменения и копию перед перезапуском.',
  write_unconfirmed_restart:
    'Результат записи не подтверждён. Не повторяйте применение; проверьте данные и копию перед перезапуском.',
  state_changed_during_write_restart:
    'Данные изменились во время записи. Новые сохранения остановлены; проверьте данные и копию перед перезапуском.',
  not_exact:
    'Данные не совпадают полностью с выбранной версией. Сначала разрешите все различия; отправка не разрешена.',
  not_unique_head: 'Наблюдается другая версия или несколько ветвей. Согласование остановлено.',
  unresolved_sources: 'Ранее применялись данные из другой ветви или набора. Требуется отдельное согласование.',
  deletions_unsupported: 'История содержит удаления или исчезнувшие записи. Их согласование ещё не реализовано.',
  queue_not_empty:
    'Существующую исходящую очередь не удалось согласовать. Неотправленные версии не удалены; требуется проверка.',
  local_lineage_not_ancestor:
    'Ранее подтверждённые версии этого ПК не входят в выбранную облачную ветвь. Согласование остановлено.',
  queue_changed: 'Очередь изменилась во время согласования. Отметка state не снята; повторите проверку.',
  history_limit: 'История достигла безопасного предела. Автоматическое согласование остановлено.',
  cloud_changed_after_queue: 'Облако изменилось во время согласования. Отметка state не снята; повтор не гарантирован.',
  state_changed_after_queue: 'Локальные данные изменились во время согласования. Отметка state не снята.',
  accepted_base_mismatch: 'Принятая основа не совпадает с локальной отметкой. Отправка остановлена.',
  journal_uncertain: 'Запись локальной очереди не подтверждена. Проверьте данные и очередь после перезапуска.',
  unavailable_or_busy: 'Другая операция выполняется или проверка недоступна. Основа не подтверждена.'
});
const MAX_DETAIL_CHARS = 25_000;
const MAX_SHOWN_ENTRIES = 1_000;
function providerName(provider) {
  return provider === 'google' ? 'Google Диск' : 'Яндекс Диск';
}
function record(provider, action, outcome) {
  try {
    recordCloudActivity(provider, action, outcome);
  } catch {
    /* журнал не влияет на действие */
  }
}
function dateText(value) {
  if (value === null || value === undefined) return 'неизвестно';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'неизвестно';
  return date.toLocaleString('ru-RU', { timeZoneName: 'short' });
}
function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'местный часовой пояс';
  } catch {
    return 'местный часовой пояс';
  }
}
function display(value) {
  if (!value.present) return 'нет в этой версии';
  if (value.value === null) return 'не задано';
  if (typeof value.value === 'string') return value.value || 'пусто';
  return JSON.stringify(value.value, null, 2);
}
function detailFor(entry, comparison) {
  if (entry.kind === 'only_cloud') {
    const record = comparison.cloudRecord(entry.section, entry.id);
    return JSON.stringify(record?.fields ?? {}, null, 2);
  }
  if (entry.kind === 'changed' || entry.kind === 'settings_changed') {
    return entry.changes
      .map(
        change =>
          `${change.path.join(' › ') || 'значение'}\nНа этом ПК: ${display(change.local)}\nНа диске: ${display(change.cloud)}`
      )
      .join('\n\n');
  }
  return '';
}
function description(entry) {
  const section = LABELS[entry.section] || 'Данные';
  const label = entry.label ? ` · ${entry.label}` : '';
  if (entry.kind === 'only_cloud') return `${section}${label} — только на диске`;
  if (entry.kind === 'only_local') return `${section}${label} — только на этом ПК, не удаляется`;
  if (entry.kind === 'changed') return `${section}${label} — отличается`;
  if (entry.kind === 'identity_review') return `${section}${label} — требуется сопоставить записи`;
  if (entry.kind === 'order_changed') return `${section} — отличается порядок; перенос порядка пока недоступен`;
  if (entry.kind === 'settings_changed')
    return entry.section === 'finance'
      ? 'Финансы — отличаются настройки и остатки'
      : `Настройки · ${GROUPS[entry.group] || entry.group} — отличаются`;
  return `${section} — требуется проверка`;
}

/**
 * @param {{doc?:Document,desktop:boolean,loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>}>,
 * check?:typeof checkConnectedCloud,stage?:typeof stageReviewedCloudApply,prepareIdentities?:typeof stageSyncIdentities,
 * reconcile?:typeof reconcileExactCloudBase,confirm?:(message:string)=>boolean|Promise<boolean>}} options
 */
export function bindCloudReviewPanel(options) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-review-title')?.closest('.cloud-review');
  const provider = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-registration-provider'));
  const checkButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-check'));
  const identitiesButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-identities'));
  const status = doc.getElementById('cloud-review-status');
  const result = /** @type {HTMLElement|null} */ (doc.getElementById('cloud-review-result'));
  const times = doc.getElementById('cloud-review-times');
  const versions = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-review-version'));
  const differences = /** @type {HTMLElement|null} */ (doc.getElementById('cloud-review-differences'));
  const summary = doc.getElementById('cloud-review-summary');
  const list = doc.getElementById('cloud-review-list');
  const all = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-select-all'));
  const none = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-select-none'));
  const apply = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-apply'));
  const accept = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-reconcile'));
  if (
    !panel ||
    !provider ||
    !checkButton ||
    !identitiesButton ||
    !status ||
    !result ||
    !times ||
    !versions ||
    !differences ||
    !summary ||
    !list ||
    !all ||
    !none ||
    !apply ||
    !accept
  )
    return;
  if (panel.getAttribute('data-cloud-review-bound') === 'true') return;
  panel.setAttribute('data-cloud-review-bound', 'true');
  const check = options.check || checkConnectedCloud;
  const stage = options.stage || stageReviewedCloudApply;
  const prepareIdentities = options.prepareIdentities || stageSyncIdentities;
  const reconcile = options.reconcile || reconcileExactCloudBase;
  const loadNative = options.loadNative || (async () => ({ invoke: (await import('@tauri-apps/api/core')).invoke }));
  const askConfirmation =
    options.confirm ||
    (message =>
      confirmModal({ title: 'Подтверждение синхронизации', text: message, okText: 'Продолжить', danger: true }));
  const settingBoxes = [...panel.querySelectorAll('[data-cloud-review-setting]')].map(
    item => /** @type {HTMLInputElement} */ (item)
  );
  let active = false;
  let controller = null;
  let review = null;
  let previewOnly = false;
  let selected = null;
  let choices = [];
  function choiceBoxes() {
    return [...list.querySelectorAll('input[data-selection-index]')].map(box => /** @type {HTMLInputElement} */ (box));
  }
  function setBusy(value) {
    active = value;
    checkButton.disabled = !options.desktop || value;
    identitiesButton.disabled = !options.desktop || value;
    versions.disabled = value;
    all.disabled = value;
    none.disabled = value;
    apply.disabled = value || previewOnly;
    accept.disabled = value || previewOnly;
    for (const box of settingBoxes) box.disabled = value;
    for (const box of choiceBoxes()) box.disabled = value || box.dataset.locked === 'true';
  }
  function clearView() {
    review = null;
    previewOnly = false;
    selected = null;
    choices = [];
    result.hidden = true;
    differences.hidden = true;
    accept.hidden = true;
    versions.replaceChildren();
    list.replaceChildren();
    times.textContent = '';
  }
  function note(text) {
    status.textContent = text;
  }
  function putReview(value, readOnly = false) {
    review = value;
    previewOnly = readOnly;
    selected = null;
    choices = [];
    list.replaceChildren();
    differences.hidden = true;
    versions.replaceChildren();
    const blank = doc.createElement('option');
    blank.value = '';
    blank.textContent = 'Выберите версию — по дате автоматически не выбираем';
    versions.append(blank);
    value.versions.forEach((version, index) => {
      const option = doc.createElement('option');
      option.value = String(index);
      option.textContent = `Версия ${index + 1} · файл: ${dateText(version.modifiedAt)}${version.observedHead ? ' · наблюдаемая вершина' : ''}`;
      versions.append(option);
    });
    times.textContent = `Источник: ${providerName(value.provider)}. Проверено: ${dateText(value.checkedAt)}. Локальное сохранение: ${dateText(value.localSavedAt)}. Часовой пояс: ${timezone()}.`;
    result.hidden = false;
    note(
      value.versions.length
        ? readOnly
          ? 'Предварительное сравнение: выберите версию и изучите различия. Применение доступно после подтверждения подключения.'
          : 'Проверка завершена. Выберите конкретную версию для сравнения.'
        : 'Подтверждённых версий не найдено. Отсутствие не доказывает удаление.'
    );
  }
  async function runCheck({ automatic = false, selectedProvider = provider.value } = {}) {
    if (!options.desktop || active) return;
    clearView();
    setBusy(true);
    const current = new AbortController();
    controller = current;
    if (!automatic) note(`Проверяем ${providerName(selectedProvider)}…`);
    try {
      const native = await loadNative();
      if (current.signal.aborted) return;
      const value = /** @type {any} */ (
        await check({
          provider: /** @type {'google'|'yandex'} */ (selectedProvider),
          invoke: native.invoke,
          settingsSelections: settingBoxes.filter(box => box.checked).map(box => box.value),
          signal: current.signal
        })
      );
      if (current.signal.aborted || provider.value !== selectedProvider) return;
      if (value.status === 'ready_for_review')
        record(selectedProvider, 'check', value.versions.length ? 'success' : 'empty');
      else if (value.status !== 'binding_missing' || !automatic) record(selectedProvider, 'check', 'blocked');
      if (value.status === 'ready_for_review') putReview(value);
      else if (!automatic || value.status !== 'binding_missing')
        note(MESSAGES[value.status] || 'Проверка не завершена. Данные не применялись.');
      else note('Автопроверка: выбранный диск ещё не настроен. Старые облачные данные могли сохраниться.');
    } catch {
      if (!current.signal.aborted) {
        record(selectedProvider, 'check', 'unavailable');
        note(
          `${automatic ? 'Автопроверка' : 'Проверка'} ${providerName(selectedProvider)} не выполнена. Данные не применялись.`
        );
      }
    } finally {
      if (controller === current) controller = null;
      setBusy(false);
    }
  }
  function showComparison() {
    list.replaceChildren();
    choices = [];
    selected = null;
    const index = Number(versions.value);
    if (!review || versions.value === '' || !Number.isSafeInteger(index) || !review.versions[index]) {
      differences.hidden = true;
      return;
    }
    try {
      const comparison = review.compare(review.versions[index].pin);
      selected = comparison;
      const heads = review.versions.filter(version => version.observedHead);
      accept.hidden =
        previewOnly ||
        heads.length !== 1 ||
        !review.versions[index].observedHead ||
        comparison.differences.entries.length !== 0 ||
        comparison.differences.uncomparedSettings.length !== 0;
      summary.textContent =
        `Дата файла на диске: ${dateText(comparison.cloudModifiedAt)}. Различий: ${comparison.differences.entries.length}.` +
        (comparison.differences.uncomparedSettings.length
          ? ' Некоторые настройки отсутствуют с одной из сторон и не сравнивались.'
          : '') +
        (comparison.differences.entries.length > MAX_SHOWN_ENTRIES
          ? ` Показаны первые ${MAX_SHOWN_ENTRIES}; остальные сейчас недоступны для выбора.`
          : '');
      all.textContent =
        comparison.differences.entries.length > MAX_SHOWN_ENTRIES ? 'Выбрать все показанные' : 'Выбрать все';
      for (const entry of comparison.differences.entries.slice(0, MAX_SHOWN_ENTRIES)) {
        const row = doc.createElement('div');
        row.className = 'cloud-review-entry';
        const label = doc.createElement('label');
        let choice = null;
        if (['changed', 'only_cloud'].includes(entry.kind))
          choice = { kind: 'record', section: entry.section, id: entry.id };
        else if (entry.kind === 'settings_changed')
          choice = entry.section === 'finance' ? { kind: 'finance' } : { kind: 'settings', group: entry.group };
        let detail = detailFor(entry, comparison);
        const tooLong = detail.length > MAX_DETAIL_CHARS;
        if (choice) {
          const box = doc.createElement('input');
          box.type = 'checkbox';
          box.dataset.selectionIndex = String(choices.length);
          choices.push(choice);
          if (tooLong) {
            box.disabled = true;
            box.dataset.locked = 'true';
          }
          label.append(box);
        }
        const text = doc.createElement('span');
        text.textContent =
          description(entry) + (tooLong ? ' — слишком много данных для полного просмотра; выбор заблокирован' : '');
        label.append(text);
        row.append(label);
        if (detail) {
          const details = doc.createElement('details');
          const title = doc.createElement('summary');
          title.textContent =
            entry.kind === 'only_cloud' ? 'Показать данные записи на диске' : 'Показать различия полей';
          const pre = doc.createElement('pre');
          if (tooLong) detail = detail.slice(0, MAX_DETAIL_CHARS) + '\n… остальное не показано';
          pre.textContent = detail;
          details.append(title, pre);
          row.append(details);
        }
        list.append(row);
      }
      differences.hidden = false;
    } catch {
      differences.hidden = true;
      note('Версия или её сравнение недоступны. Выполните проверку заново.');
    }
  }
  function checkedChoices() {
    return choiceBoxes()
      .filter(box => box.checked && !box.disabled)
      .map(box => choices[Number(box.dataset.selectionIndex)])
      .filter(Boolean);
  }
  async function applySelection() {
    if (previewOnly) {
      note('Это предварительный просмотр. Сначала подтвердите подключение восстановленного набора.');
      return;
    }
    if (active || !review || !selected) return;
    const chosen = checkedChoices();
    if (!chosen.length) {
      note('Выберите хотя бы одно доступное изменение.');
      return;
    }
    let operation;
    try {
      operation = stage({
        review,
        pin: selected.pin,
        selectedRecords: chosen
          .filter(item => item.kind === 'record')
          .map(item => ({ section: item.section, id: item.id })),
        selectedSettings: chosen.filter(item => item.kind === 'settings').map(item => item.group),
        includeFinanceSettings: chosen.some(item => item.kind === 'finance')
      });
    } catch {
      note(
        'Не удалось подготовить выбранные изменения. Проверьте зависимости, совпадения записей и выполните сравнение заново.'
      );
      return;
    }
    const originalReview = review;
    const originalSelection = selected;
    const originalProvider = provider.value;
    setBusy(true);
    let approved;
    try {
      approved = await askConfirmation(
        `Применить выбранные записи и настройки (${chosen.length})? Будет создана копия локального файла. Записи выбираются целиком; контакты и пароли не переносятся. Отправка блокируется до согласования. При полном совпадении с одной облачной версией его можно подтвердить отдельно.`
      );
    } catch {
      approved = false;
    }
    if (
      !approved ||
      review !== originalReview ||
      selected !== originalSelection ||
      provider.value !== originalProvider
    ) {
      operation.cancel();
      note('Применение отменено или сравнение изменилось; данные не изменены.');
      setBusy(false);
      return;
    }
    note('Создаём резервную копию и сохраняем выбранные изменения…');
    try {
      const outcome = await operation.commit({ confirmed: true });
      record(
        originalProvider,
        'apply',
        outcome.status === 'applied' ? 'success' : outcome.status.endsWith('_restart') ? 'uncertain' : 'blocked'
      );
      if (outcome.status === 'applied') {
        clearView();
        note(
          `Выбранные изменения сохранены. Копия: ${outcome.backup}. Отправка пока недоступна до согласования изменений.`
        );
        doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-applied'));
      } else note(MESSAGES[outcome.status] || 'Применение не подтверждено. Проверьте данные и резервные копии.');
    } catch {
      record(originalProvider, 'apply', 'uncertain');
      note('Применение не подтверждено. Не повторяйте его до проверки данных и копий.');
    } finally {
      setBusy(false);
    }
  }
  accept.addEventListener('click', async () => {
    if (!options.desktop || active || previewOnly || accept.hidden || !review || !selected) return;
    const originalReview = review;
    const originalSelection = selected;
    const originalProvider = provider.value;
    setBusy(true);
    let approved;
    try {
      approved = await askConfirmation(
        'Подтвердить полное совпадение с выбранной единственной облачной версией? История и сохранённые данные будут проверены повторно, затем создастся резервная копия. Различающиеся или удалённые данные этот шаг не объединяет.'
      );
    } catch {
      approved = false;
    }
    if (
      !approved ||
      review !== originalReview ||
      selected !== originalSelection ||
      provider.value !== originalProvider
    ) {
      note('Согласование отменено или сравнение изменилось.');
      setBusy(false);
      return;
    }
    const current = new AbortController();
    controller = current;
    note('Повторно проверяем историю, сохранённые данные и резервную копию…');
    try {
      const native = await loadNative();
      if (current.signal.aborted) return;
      const outcome = /** @type {any} */ (
        await reconcile({
          provider: /** @type {'google'|'yandex'} */ (originalProvider),
          invoke: native.invoke,
          pin: originalSelection.pin,
          confirmed: true,
          settingsSelections: settingBoxes.filter(box => box.checked).map(box => box.value),
          signal: current.signal
        })
      );
      if (current.signal.aborted || provider.value !== originalProvider) return;
      record(
        originalProvider,
        'reconcile',
        ['reconciled', 'already_reconciled'].includes(outcome.status)
          ? 'success'
          : ['journal_uncertain', 'write_unconfirmed_restart'].includes(outcome.status)
            ? 'uncertain'
            : 'blocked'
      );
      if (outcome.status === 'reconciled' || outcome.status === 'already_reconciled') {
        clearView();
        note(
          outcome.status === 'reconciled'
            ? `Полное совпадение подтверждено. Создана копия: ${outcome.backup}. Последующие изменения можно подготовить к отправке.`
            : 'Полное совпадение уже подтверждено. Последующие изменения можно подготовить к отправке.'
        );
        doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-reconciled'));
      } else note(MESSAGES[outcome.status] || 'Согласование не подтверждено. Проверьте состояние и копии.');
    } catch {
      if (!current.signal.aborted) note('Согласование не подтверждено. Проверьте состояние и копии.');
    } finally {
      if (controller === current) controller = null;
      setBusy(false);
    }
  });
  identitiesButton.addEventListener('click', async () => {
    if (active || !options.desktop) return;
    let prepared;
    try {
      prepared = prepareIdentities();
      if (prepared.status === 'already_assigned') {
        note('У всех локальных записей уже есть устойчивые идентификаторы. Диск не изменялся.');
        return;
      }
      if (prepared.status !== 'prepared') throw new Error();
    } catch {
      note('Не удалось подготовить локальные данные. Проверьте связи записей и сохранение. Диск не изменялся.');
      return;
    }
    const identityProvider = provider.value;
    setBusy(true);
    let approved;
    try {
      approved = await askConfirmation(
        `Подготовить ${prepared.operation.selectedCount} локальных записей для синхронизации? Будет создана резервная копия state; пароли в хранилище Windows в неё не входят. Существующие идентификаторы не меняются, на диск ничего не отправляется.`
      );
    } catch {
      approved = false;
    }
    if (!approved) {
      prepared.operation.cancel();
      note('Подготовка отменена. Данные не изменены.');
      setBusy(false);
      return;
    }
    note('Создаём копию и сохраняем локальные идентификаторы…');
    try {
      const outcome = await prepared.operation.commit({ confirmed: true });
      record(
        identityProvider,
        'identities',
        outcome.status === 'applied' ? 'success' : outcome.status.endsWith('_restart') ? 'uncertain' : 'blocked'
      );
      if (outcome.status === 'applied') {
        clearView();
        note(`Локальные данные подготовлены. Копия: ${outcome.backup}. Облачный диск не изменялся.`);
      } else note(MESSAGES[outcome.status] || 'Подготовка не подтверждена. Проверьте данные и резервные копии.');
    } catch {
      record(identityProvider, 'identities', 'uncertain');
      note('Подготовка не подтверждена. Не повторяйте её до проверки данных и копий.');
    } finally {
      setBusy(false);
    }
  });
  checkButton.addEventListener('click', () => {
    void runCheck();
  });
  versions.addEventListener('change', showComparison);
  all.addEventListener('click', () => {
    for (const box of choiceBoxes()) if (!box.disabled) box.checked = true;
  });
  none.addEventListener('click', () => {
    for (const box of choiceBoxes()) box.checked = false;
  });
  apply.addEventListener('click', () => {
    void applySelection();
  });
  provider.addEventListener('change', () => {
    controller?.abort();
    clearView();
    setBusy(active);
    note('Выбран другой диск. Проверьте его обновления отдельно.');
  });
  for (const box of settingBoxes)
    box.addEventListener('change', () => {
      controller?.abort();
      clearView();
      setBusy(active);
      note('Выбор настроек изменён. Повторите проверку.');
    });
  let startupStarted = false;
  doc.defaultView?.addEventListener('tf-cloud-startup-check', () => {
    if (!options.desktop || !panel.isConnected || startupStarted || active) return;
    startupStarted = true;
    const first = provider.value;
    const other = first === 'google' ? 'yandex' : 'google';
    void (async () => {
      await runCheck({ automatic: true, selectedProvider: first });
      if (active || provider.value !== first) return;
      setBusy(true);
      const current = new AbortController();
      controller = current;
      try {
        const native = await loadNative();
        if (current.signal.aborted) return;
        const value = /** @type {any} */ (
          await check({
            provider: other,
            invoke: native.invoke,
            settingsSelections: settingBoxes.filter(box => box.checked).map(box => box.value),
            signal: current.signal
          })
        );
        if (!current.signal.aborted && provider.value === first) {
          if (value.status === 'ready_for_review') record(other, 'check', value.versions.length ? 'success' : 'empty');
          else if (!['binding_missing', 'cancelled'].includes(value.status)) record(other, 'check', 'blocked');
          if (value.status === 'ready_for_review' && value.versions.length)
            note(
              `${status.textContent} На ${providerName(other)} тоже найдены проверенные версии; выберите этот диск для просмотра.`
            );
          else if (value.status === 'ready_for_review')
            note(
              `${status.textContent} На ${providerName(other)} подтверждённых версий не найдено; отсутствие не доказывает удаление.`
            );
          else if (!['binding_missing', 'cancelled'].includes(value.status))
            note(`${status.textContent} ${providerName(other)}: ${MESSAGES[value.status] || 'проверка не завершена.'}`);
        }
      } catch {
        if (!current.signal.aborted && provider.value === first) {
          record(other, 'check', 'unavailable');
          note(`${status.textContent} Второй диск автоматически проверить не удалось.`);
        }
      } finally {
        if (controller === current) controller = null;
        setBusy(false);
      }
    })();
  });
  setBusy(false);
  if (!options.desktop)
    note('Проверка доступна только в настольном приложении; в браузерном примере диск не подключается.');
  return Object.freeze({
    /** Показывает проверенный предварительный просмотр без передачи личных данных через DOM-события. */
    showExternalReview(value, readOnly = true) {
      if (
        !options.desktop ||
        active ||
        !value ||
        value.status !== 'ready_for_review' ||
        value.provider !== provider.value
      )
        return false;
      clearView();
      putReview(value, readOnly);
      setBusy(false);
      return true;
    },
    hasPreviewSelection() {
      return !active && previewOnly && !!review && !!selected;
    },
    clearExternalReview() {
      if (!active && previewOnly) {
        clearView();
        setBusy(false);
        note('Предварительное сравнение отменено. Данные не применены.');
      }
    }
  });
}
