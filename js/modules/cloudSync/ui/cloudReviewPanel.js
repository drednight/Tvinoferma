// @ts-check
// Экспериментальный просмотр только УЖЕ закреплённого набора. Не создаёт набор
// или ключи; выборочное применение и ограниченное объединение — разные действия.
// Значения сравнения могут быть личными: выводить только текстом, не журналировать.
import { checkConnectedCloud } from '../checkConnectedCloud.js';
import { stageReviewedCloudApply } from '../commitReviewedCloud.js';
import { stageSyncIdentities } from '../commitSyncIdentities.js';
import { reconcileExactCloudBase } from '../reconcileExactCloudBase.js';
import { reconcileConservativeMerge, cancelPendingConservativeMerge } from '../reconcileConservativeMerge.js';
import { readPendingConservativeMerge } from '../pendingConservativeMerge.js';
import { state } from '../../../core/state.js';
import { pendingSelectiveApplyEvents } from '../pendingSelectiveApply.js';
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
  deletion_not_accepted:
    'Удаление не выбрано: местная запись сохранена, согласование остановлено. Для продолжения нужно явно принять показанное удаление; старый ID не воскрешается.',
  deleted_identity_resurrection: 'Ранее удалённый ID появился снова или изменил источник. Согласование остановлено.',
  not_exact:
    'Данные не совпадают полностью с выбранной версией. Сначала разрешите все различия; отправка не разрешена.',
  not_unique_head: 'Наблюдается другая версия или несколько ветвей. Согласование остановлено.',
  unresolved_sources:
    'Не удалось согласовать ранее применённые данные с очередью. Проверьте источники и дополнительные местные правки; не удаляйте служебные отметки.',
  deletions_unsupported:
    'История содержит удаления или исчезнувшие записи, которые это согласование не поддерживает. Для ручного календаря используйте отдельный выбор подтверждённых v3-меток и согласование полного совпадения.',
  queue_not_empty:
    'Исходящая очередь содержит начатую или несколько неподтверждённых попыток. Они не удалены; сначала проверьте результат отправки.',
  queue_snapshot_mismatch:
    'Неотправленная очередь содержит более старое сохранение. Сначала обновите очередь текущими данными; старое намерение не удалено.',
  retained_intent_limit:
    'Достигнут предел сохранённых неотправленных намерений. Подтвердите отправку объединённой версии или сохраните резервную копию и проверьте очередь.',
  local_lineage_not_ancestor:
    'Ранее подтверждённые версии этого ПК не входят в выбранную облачную ветвь. Согласование остановлено.',
  queue_changed: 'Очередь изменилась во время согласования. Отметка state не снята; повторите проверку.',
  history_limit: 'История достигла безопасного предела. Автоматическое согласование остановлено.',
  cloud_changed_after_queue: 'Облако изменилось во время согласования. Отметка state не снята; повтор не гарантирован.',
  state_changed_after_queue: 'Локальные данные изменились во время согласования. Отметка state не снята.',
  accepted_base_mismatch: 'Принятая основа не совпадает с локальной отметкой. Отправка остановлена.',
  journal_uncertain: 'Запись локальной очереди не подтверждена. Проверьте данные и очередь после перезапуска.',
  conflicts: 'Есть конфликтующие правки одного поля. Выберите вариант для каждой записи; данные пока не изменены.',
  conflicts_changed: 'Локальные данные, очередь или конфликт изменились после просмотра. Проверьте и выберите заново.',
  structure_or_deletion_unsupported:
    'Неподдерживаемое изменение состава или порядка, замена элемента без идентификатора либо исчезновение данных (в том числе обрезание истории). Объединение остановлено.',
  transition_unsupported:
    'В истории есть неподдерживаемое изменение состава или порядка либо исчезновение данных. Объединение остановлено.',
  dependencies_unresolved: 'Не удалось безопасно согласовать ссылки между записями.',
  settings_mismatch: 'Выберите те же группы настроек, что закреплены в очереди этого ПК.',
  base_not_ancestor: 'Подтверждённая основа этого ПК не является предком выбранной версии.',
  already_on_base: 'Выбранная версия уже является местной основой. Новых облачных изменений для объединения нет.',
  no_local_lineage: 'На этом ПК пока нет подтверждённой общей основы для объединения.',
  candidate_unrepresentable: 'Результат не прошёл проверку сохранения и перезапуска. Данные не перезаписаны.',
  merge_intent_mismatch: 'Сохранённые данные или план отличаются от незавершённого объединения. Отправка остановлена.',
  merge_base_mismatch: 'Очередь или прежняя основа не совпадает с незавершённым объединением. Отправка остановлена.',
  other_merge_pending: 'На этом ПК уже начато объединение другого диска или версии. Сначала завершите его.',
  merge_pending: 'Сначала завершите или безопасно отмените незавершённое объединение.',
  already_anchored: 'Очередь уже изменилась: отмена небезопасна. Продолжите начатое объединение.',
  cloud_changed_after_checkpoint:
    'Облако изменилось после сохранения отметки. Отправка остановлена; продолжите объединение после проверки.',
  state_changed_after_checkpoint:
    'Локальные данные изменились во время объединения. Отметка сохранена, отправка остановлена.',
  cancelled_with_merge_pending: 'Объединение прервано после сохранения отметки. Продолжите или безопасно отмените его.',
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
  if (entry.kind === 'marked_cloud_deletion') {
    const record = comparison.localRecord(entry.section, entry.id);
    return JSON.stringify(record?.fields ?? {}, null, 2);
  }
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
  if (entry.kind === 'marked_cloud_deletion')
    return `${section}${label} — в проверенной истории диска есть отметка удаления; ${entry.deletionSelectable ? 'при выборе запись будет удалена с этого ПК, включая местные правки' : 'на этом ПК запись сохранена, применение удаления пока недоступно'}`;
  if (entry.kind === 'changed') return `${section}${label} — отличается; при выборе облачные поля заменят местные`;
  if (entry.kind === 'identity_review') return `${section}${label} — требуется сопоставить записи`;
  if (entry.kind === 'order_changed')
    return `${section} — отличается порядок; отдельный перенос порядка пока недоступен`;
  if (entry.kind === 'settings_changed')
    return entry.section === 'finance'
      ? 'Финансы — отличаются настройки и остатки'
      : `Настройки · ${GROUPS[entry.group] || entry.group} — отличаются`;
  return `${section} — требуется проверка`;
}

/**
 * @param {{doc?:Document,desktop:boolean,loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>}>,
 * check?:typeof checkConnectedCloud,stage?:typeof stageReviewedCloudApply,prepareIdentities?:typeof stageSyncIdentities,
 * reconcile?:typeof reconcileExactCloudBase,merge?:typeof reconcileConservativeMerge,
 * cancelMerge?:typeof cancelPendingConservativeMerge,confirm?:(message:string)=>boolean|Promise<boolean>}} options
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
  const mergeButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-merge'));
  const conflictBox = /** @type {HTMLElement|null} */ (doc.getElementById('cloud-review-conflicts'));
  const conflictList = doc.getElementById('cloud-review-conflict-list');
  const resolveButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-resolve'));
  const pendingBox = /** @type {HTMLElement|null} */ (doc.getElementById('cloud-review-merge-pending'));
  const pendingMessage = doc.getElementById('cloud-review-merge-pending-message');
  const resumeButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-merge-resume'));
  const cancelMergeButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-review-merge-cancel'));
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
    !accept ||
    !mergeButton ||
    !conflictBox ||
    !conflictList ||
    !resolveButton ||
    !pendingBox ||
    !pendingMessage ||
    !resumeButton ||
    !cancelMergeButton
  )
    return;
  if (panel.getAttribute('data-cloud-review-bound') === 'true') return;
  panel.setAttribute('data-cloud-review-bound', 'true');
  const check = options.check || checkConnectedCloud;
  const stage = options.stage || stageReviewedCloudApply;
  const prepareIdentities = options.prepareIdentities || stageSyncIdentities;
  const reconcile = options.reconcile || reconcileExactCloudBase;
  const merge = options.merge || reconcileConservativeMerge;
  const cancelMerge = options.cancelMerge || cancelPendingConservativeMerge;
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
  let conflictReview = null;
  let pendingMerge = null;
  let malformedMerge = false;
  function refreshPending() {
    try {
      pendingMerge = readPendingConservativeMerge(state.settings);
      malformedMerge = false;
    } catch {
      pendingMerge = null;
      malformedMerge = true;
    }
    pendingBox.hidden = !pendingMerge && !malformedMerge;
    if (malformedMerge) {
      pendingMessage.textContent =
        'Отметка незавершённого объединения повреждена. Отправка остановлена; проверьте данные и резервные копии.';
    } else if (pendingMerge) {
      pendingMessage.textContent = `Незавершённое объединение · ${providerName(pendingMerge.provider)}. Отправка заблокирована до безопасного завершения. ${provider.value === pendingMerge.provider ? 'Продолжите его с той же версией или отмените, пока очередь не менялась.' : 'Выберите этот диск, чтобы продолжить.'}`;
    }
    resumeButton.disabled = !options.desktop || active || !pendingMerge || pendingMerge.provider !== provider.value;
    cancelMergeButton.disabled =
      !options.desktop || active || !pendingMerge || pendingMerge.provider !== provider.value;
  }
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
    apply.disabled = value || previewOnly || !!pendingMerge || malformedMerge;
    accept.disabled = value || previewOnly || !!pendingMerge || malformedMerge;
    mergeButton.disabled = value || previewOnly || !!pendingMerge || malformedMerge;
    resolveButton.disabled = value || previewOnly || !!pendingMerge || malformedMerge || !conflictReview;
    resumeButton.disabled = !options.desktop || value || !pendingMerge || pendingMerge.provider !== provider.value;
    cancelMergeButton.disabled = !options.desktop || value || !pendingMerge || pendingMerge.provider !== provider.value;
    for (const box of settingBoxes) box.disabled = value;
    for (const box of choiceBoxes()) box.disabled = value || box.dataset.locked === 'true';
  }
  function clearConflictReview() {
    conflictReview = null;
    conflictBox.hidden = true;
    conflictList.replaceChildren();
  }
  function clearView() {
    clearConflictReview();
    review = null;
    previewOnly = false;
    selected = null;
    choices = [];
    result.hidden = true;
    differences.hidden = true;
    accept.hidden = true;
    mergeButton.hidden = true;
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
    clearConflictReview();
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
      let detailTooLong = false;
      for (const entry of comparison.differences.entries.slice(0, MAX_SHOWN_ENTRIES)) {
        const row = doc.createElement('div');
        row.className = 'cloud-review-entry';
        const label = doc.createElement('label');
        let choice = null;
        if (['changed', 'only_cloud'].includes(entry.kind))
          choice = { kind: 'record', section: entry.section, id: entry.id };
        else if (entry.kind === 'marked_cloud_deletion' && entry.deletionSelectable)
          choice = { kind: 'deletion', section: 'planner', id: entry.id };
        else if (entry.kind === 'settings_changed')
          choice = entry.section === 'finance' ? { kind: 'finance' } : { kind: 'settings', group: entry.group };
        let detail = detailFor(entry, comparison);
        const tooLong = detail.length > MAX_DETAIL_CHARS;
        detailTooLong ||= tooLong;
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
            entry.kind === 'only_cloud'
              ? 'Показать данные записи на диске'
              : entry.kind === 'marked_cloud_deletion'
                ? 'Показать запись, сохранённую на этом ПК'
                : 'Показать различия полей';
          const pre = doc.createElement('pre');
          if (tooLong) detail = detail.slice(0, MAX_DETAIL_CHARS) + '\n… остальное не показано';
          pre.textContent = detail;
          details.append(title, pre);
          row.append(details);
        }
        list.append(row);
      }
      mergeButton.hidden =
        previewOnly ||
        heads.length !== 1 ||
        !review.versions[index].observedHead ||
        (comparison.differences.entries.length === 0 && !pendingSelectiveApplyEvents(state.settings).length) ||
        comparison.differences.entries.length > MAX_SHOWN_ENTRIES ||
        comparison.differences.uncomparedSettings.length !== 0 ||
        detailTooLong;
      differences.hidden = false;
    } catch {
      differences.hidden = true;
      note('Версия или её сравнение недоступны. Выполните проверку заново.');
    }
  }
  function checkedChoices() {
    return choiceBoxes()
      .filter(box => box.checked && box.dataset.locked !== 'true')
      .map(box => choices[Number(box.dataset.selectionIndex)])
      .filter(Boolean);
  }
  function choiceMatchesConflict(choice, conflict) {
    if (conflict.reason === 'concurrent-order') return false;
    if (conflict.section === 'preferences') return choice.kind === 'settings' && choice.group === conflict.id;
    if (conflict.section === 'finance' && !conflict.id) return choice.kind === 'finance';
    return (
      (choice.kind === 'record' || (choice.kind === 'deletion' && conflict.reason === 'cloud-planner-deletion')) &&
      choice.section === conflict.section &&
      choice.id === conflict.id
    );
  }
  function showConflictReview(outcome) {
    clearConflictReview();
    if (
      !selected ||
      typeof outcome.reviewHash !== 'string' ||
      !/^[0-9a-f]{64}(?![\s\S])/.test(outcome.reviewHash) ||
      !Array.isArray(outcome.conflicts) ||
      !outcome.conflicts.length ||
      outcome.conflicts.length > MAX_SHOWN_ENTRIES ||
      outcome.conflicts.some(
        row =>
          !row ||
          !Array.isArray(row.path) ||
          row.path.some(part => typeof part !== 'string') ||
          !choices.some(choice => choiceMatchesConflict(choice, row))
      )
    )
      return false;
    conflictReview = { reviewHash: outcome.reviewHash, conflicts: structuredClone(outcome.conflicts) };
    for (const conflict of conflictReview.conflicts) {
      const entry = selected.differences.entries.find(row =>
        conflict.section === 'preferences'
          ? row.section === 'preferences' && row.group === conflict.id
          : conflict.section === 'finance' && !conflict.id
            ? row.section === 'finance' && row.kind === 'settings_changed'
            : row.section === conflict.section && row.id === conflict.id
      );
      if (!entry) {
        clearConflictReview();
        return false;
      }
      const li = doc.createElement('li');
      const name = entry.label || (entry.group && GROUPS[entry.group]) || '';
      li.textContent = `${LABELS[conflict.section] || 'Данные'}${name ? ` · ${name}` : ''}: ${conflict.reason === 'cloud-planner-deletion' ? 'подтверждённое удаление против местной записи; отметьте её для удаления вместе с местными правками' : conflict.path.join(' › ') || 'запись целиком'}`;
      conflictList.append(li);
    }
    conflictBox.hidden = false;
    return true;
  }
  function conflictResolution(reviewed) {
    const selectedChoices = checkedChoices();
    const relevant = selectedChoices.filter(choice =>
      reviewed.conflicts.some(row => choiceMatchesConflict(choice, row))
    );
    return {
      reviewHash: reviewed.reviewHash,
      cloudRecords: relevant
        .filter(choice => choice.kind === 'record' || choice.kind === 'deletion')
        .map(({ section, id }) => ({ section, id })),
      cloudSettings: settingBoxes
        .filter(box => relevant.some(choice => choice.kind === 'settings' && choice.group === box.value))
        .map(box => box.value),
      cloudFinanceSettings: relevant.some(choice => choice.kind === 'finance')
    };
  }
  async function applySelection() {
    if (previewOnly) {
      note('Это предварительный просмотр. Сначала подтвердите подключение восстановленного набора.');
      return;
    }
    if (active || pendingMerge || malformedMerge || !review || !selected) return;
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
        includeFinanceSettings: chosen.some(item => item.kind === 'finance'),
        ...(chosen.some(item => item.kind === 'deletion')
          ? { selectedPlannerDeletions: chosen.filter(item => item.kind === 'deletion').map(item => item.id) }
          : {})
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
        `Применить выбранные записи и настройки (${chosen.length})? ${chosen.some(item => item.kind === 'deletion') ? `ВНИМАНИЕ: выбранные удаления календаря (${chosen.filter(item => item.kind === 'deletion').length}) удалят записи с этого ПК вместе с местными правками. Чтобы сохранить местную запись, снимите с её удаления галочку. ` : ''}Их облачные поля заменят местные значения целиком, в том числе неотправленные локальные правки. Это действие не объединяет изменения и не разрешает конфликты; для объединения есть отдельная кнопка. Будет создана копия локального файла. Контакты и пароли не переносятся. Отправка блокируется до согласования; полное совпадение с одной облачной версией можно подтвердить отдельно.`
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
  async function runMerge(resume, resolveConflicts = false) {
    refreshPending();
    if (!options.desktop || active || malformedMerge) return;
    if (
      resume
        ? !pendingMerge || pendingMerge.provider !== provider.value
        : previewOnly || !!pendingMerge || mergeButton.hidden || !review || !selected
    )
      return;
    const originalReview = review;
    const originalSelection = selected;
    const conflictSnapshot = resolveConflicts ? conflictReview : null;
    if (resolveConflicts && !conflictSnapshot) return;
    const resolution = conflictSnapshot ? conflictResolution(conflictSnapshot) : null;
    const originalProvider = provider.value;
    const intent = resume ? pendingMerge : null;
    const pin = resume ? intent.targetPin : originalSelection.pin;
    const settingsSelections = resume
      ? [...intent.settingsSelections]
      : settingBoxes.filter(box => box.checked).map(box => box.value);
    if (!resume && !resolveConflicts) clearConflictReview();
    setBusy(true);
    let approved;
    try {
      approved = await askConfirmation(
        resume
          ? 'Продолжить ранее подтверждённое объединение той же облачной версии? История, исходные данные и очередь будут проверены повторно; перед записью создаётся резервная копия.'
          : resolveConflicts
            ? 'Разрешить показанные конфликты по текущим галочкам? В отмеченных записях конфликтующие поля берутся с диска, в неотмеченных остаются местные. Для подтверждённых удалений календаря галочка означает удаление записи вместе с местными правками; без галочки местная запись сохраняется, но согласование останавливается. Остальные поддерживаемые изменения объединяются независимо от галочек. Для всех конфликтов внутри одной записи действует один выбор; конфликтующие списки без ID (включая задания и бонусы шаблонов, теги и навигацию) заменяются целиком, изменения внутри них с другой стороны могут быть потеряны. Изменение шаблона не меняет уже созданные марафоны. Будут созданы резервные копии; автоотправка может начаться после сохранения.'
            : 'Объединить все поддерживаемые изменения выбранной версии, независимо от галочек ниже? Поддерживаются существующие записи, некоторые добавления в конец (включая новые шаблоны) и выбранные настройки. Задания и бонусы шаблонов, теги и списки навигации без общих ID согласуются целыми списками, а не по названиям или позициям. Конфликтующие списки требуют выбора стороны. Изменение порядка sync-сущностей и неподдерживаемые удаления останавливают операцию. Для подтверждённых удалений ручного календаря сначала будет показан отдельный выбор; без него местная запись не удаляется. Независимые местные правки сохраняются. Будут созданы резервные копии. Само объединение не отправляет снимок, но включённая автоотправка может начаться после сохранения. Обновите приложение на всех ПК.'
      );
    } catch {
      approved = false;
    }
    refreshPending();
    if (
      !approved ||
      provider.value !== originalProvider ||
      (resolveConflicts &&
        (conflictReview !== conflictSnapshot ||
          JSON.stringify(conflictResolution(conflictSnapshot)) !== JSON.stringify(resolution))) ||
      (resume
        ? !pendingMerge || pendingMerge.operationId !== intent.operationId
        : review !== originalReview || selected !== originalSelection || !!pendingMerge || malformedMerge)
    ) {
      note('Объединение отменено или данные сравнения изменились.');
      setBusy(false);
      return;
    }
    const current = new AbortController();
    controller = current;
    note('Проверяем общую основу, изменения и резервные копии…');
    try {
      const native = await loadNative();
      if (current.signal.aborted) return;
      const outcome = /** @type {any} */ (
        await merge({
          provider: /** @type {'google'|'yandex'} */ (originalProvider),
          invoke: native.invoke,
          pin,
          confirmed: true,
          settingsSelections,
          ...(resolution ? { resolution } : {}),
          signal: current.signal
        })
      );
      record(
        originalProvider,
        'merge',
        outcome.status === 'merged'
          ? 'success'
          : ['journal_uncertain', 'write_unconfirmed_restart'].includes(outcome.status)
            ? 'uncertain'
            : 'blocked'
      );
      if (outcome.status === 'merged') {
        clearView();
        refreshPending();
        if (!current.signal.aborted && provider.value === originalProvider) {
          note(
            `Поддерживаемые изменения объединены. Копия: ${outcome.backup}. Само объединение не отправляло снимок; включённая автоотправка может начаться после сохранения.${outcome.newerHeadObserved ? ' Обнаружена более поздняя версия: проверьте её перед отправкой.' : ' Можно подготовить отправку.'}`
          );
        }
        doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-applied'));
        doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-reconciled'));
      } else if (!current.signal.aborted && provider.value === originalProvider) {
        const conflictCount =
          outcome.status === 'conflicts' && Number.isSafeInteger(outcome.conflictCount)
            ? ` Конфликтов: ${outcome.conflictCount}.`
            : '';
        if (outcome.status === 'conflicts') {
          if (!showConflictReview(outcome))
            note('Конфликт нельзя безопасно разрешить этим выбором. Данные не изменены.' + conflictCount);
          else note(MESSAGES.conflicts + conflictCount);
        } else {
          if (outcome.status === 'conflicts_changed') clearConflictReview();
          note(
            (MESSAGES[outcome.status] || 'Объединение не подтверждено. Проверьте данные и резервные копии.') +
              conflictCount
          );
        }
      }
    } catch {
      record(originalProvider, 'merge', 'uncertain');
      if (!current.signal.aborted) note('Объединение не подтверждено. Проверьте данные и копии перед повтором.');
    } finally {
      if (controller === current) controller = null;
      refreshPending();
      setBusy(false);
    }
  }
  mergeButton.addEventListener('click', () => {
    void runMerge(false);
  });
  resolveButton.addEventListener('click', () => {
    void runMerge(false, true);
  });
  resumeButton.addEventListener('click', () => {
    void runMerge(true);
  });
  cancelMergeButton.addEventListener('click', async () => {
    refreshPending();
    if (!options.desktop || active || !pendingMerge || pendingMerge.provider !== provider.value) return;
    const originalProvider = provider.value;
    const operationId = pendingMerge.operationId;
    setBusy(true);
    let approved;
    try {
      approved = await askConfirmation(
        'Отменить незавершённое объединение? Это возможно только если исходящая очередь и прежняя основа не менялись. Локальные данные сохранятся; перед снятием отметки создаётся резервная копия.'
      );
    } catch {
      approved = false;
    }
    refreshPending();
    if (!approved || provider.value !== originalProvider || pendingMerge?.operationId !== operationId) {
      note('Отмена объединения не выполнена.');
      setBusy(false);
      return;
    }
    try {
      const native = await loadNative();
      const outcome = /** @type {any} */ (
        await cancelMerge({
          provider: /** @type {'google'|'yandex'} */ (originalProvider),
          invoke: native.invoke,
          confirmed: true
        })
      );
      record(
        originalProvider,
        'merge',
        outcome.status === 'merge_cancelled'
          ? 'cancelled'
          : outcome.status.endsWith('_restart')
            ? 'uncertain'
            : 'blocked'
      );
      if (outcome.status === 'merge_cancelled') {
        clearView();
        note(`Незавершённое объединение отменено. Данные и очередь сохранены; копия: ${outcome.backup}.`);
      } else note(MESSAGES[outcome.status] || 'Отмена не подтверждена. Проверьте данные и копии.');
    } catch {
      note('Отмена не подтверждена. Проверьте данные и копии перед повтором.');
    } finally {
      refreshPending();
      setBusy(false);
    }
  });
  accept.addEventListener('click', async () => {
    if (
      !options.desktop ||
      active ||
      previewOnly ||
      pendingMerge ||
      malformedMerge ||
      accept.hidden ||
      !review ||
      !selected
    )
      return;
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
    refreshPending();
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
  refreshPending();
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
