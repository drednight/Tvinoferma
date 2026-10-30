// @ts-check
// No values in the DOM, attributes, diagnostics or activity log. Per-batch only.
import { confirmModal } from '../../../core/ui.js';
import { currentCloudStateSnapshot } from '../guardedStateWrite.js';
import { checkConnectedCloud } from '../checkConnectedCloud.js';
import { stagePrivatePublication, stagePrivateCloudApply } from '../privateTransfer.js';
import { recordCloudActivity } from '../cloudEventLog.js';

const LABELS = { email: 'Email', recoveryEmail: 'Запасная почта', phone: 'Телефон', password: 'Пароль' };
const MESSAGES = {
  private_consent_required:
    'Выберите категории и подтвердите полноту локальных данных; для пароля отдельно подтвердите риск.',
  private_source_unavailable:
    'Локальное хранилище контактов недоступно. Передача остановлена, пустые поля не считаются очисткой.',
  private_transfer_pending:
    'В очереди есть отдельное намерение передачи контактов. Оно не удалено; сначала завершите его отправку.',
  private_transfer_review_required:
    'Секретная часть облачной версии изменилась. Автоматическое объединение разных секретных намерений пока остановлено.',
  queued:
    'Выбранные контакты зашифрованы и подготовлены в общей очереди. Используйте «Отправить сохранённые изменения». Включённая автоотправка также может отправить эту явно подготовленную партию.',
  coalesced: 'Выбранные контакты обновлены в зашифрованной очереди. Используйте «Отправить сохранённые изменения».',
  unchanged: 'Подтверждённые выбранные контакты уже совпадают с содержимым очереди.',
  retained_intent_pending: 'Сначала завершите публикацию сохранённых намерений объединения.',
  state_changed_or_unsaved: 'Локальные данные изменились или не сохранены. Повторите подготовку после сохранения.',
  journal_uncertain: 'Запись очереди не подтверждена. Не повторяйте подготовку до проверки и перезапуска.',
  binding_or_queue_blocked: 'Сначала настройте выбранный диск, ключ и первый снимок.',
  busy: 'Другая операция синхронизации выполняется.',
  unavailable_or_busy: 'Подготовка не выполнена. Проверьте подключение, очередь и локальные данные.'
};
function date(value) {
  if (value === null || value === undefined) return 'неизвестно';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('ru-RU', { timeZoneName: 'short' }) : 'неизвестно';
}
/** @param {{desktop:boolean,doc?:Document,loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>}>,
 * check?:typeof checkConnectedCloud,stagePublication?:typeof stagePrivatePublication,stageApply?:typeof stagePrivateCloudApply,
 * confirm?:(message:string)=>boolean|Promise<boolean>}} options */
export function bindPrivateTransferPanel(options) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-private-panel');
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  const provider = /** @type {HTMLSelectElement} */ (doc.getElementById('cloud-registration-provider'));
  const publish = /** @type {HTMLButtonElement} */ (doc.getElementById('cloud-private-prepare'));
  const check = /** @type {HTMLButtonElement} */ (doc.getElementById('cloud-private-check'));
  const apply = /** @type {HTMLButtonElement} */ (doc.getElementById('cloud-private-apply'));
  const version = /** @type {HTMLSelectElement} */ (doc.getElementById('cloud-private-version'));
  const source = /** @type {HTMLInputElement} */ (doc.getElementById('cloud-private-source'));
  const risk = /** @type {HTMLInputElement} */ (doc.getElementById('cloud-private-risk'));
  const backup = /** @type {HTMLInputElement} */ (doc.getElementById('cloud-private-backup'));
  const status = doc.getElementById('cloud-private-status');
  const times = doc.getElementById('cloud-private-times');
  const list = doc.getElementById('cloud-private-list');
  const incoming = doc.getElementById('cloud-private-incoming');
  const boxes = [...panel.querySelectorAll('input[data-private-field]')].map(
    box => /** @type {HTMLInputElement} */ (box)
  );
  const askConfirmation =
    options.confirm ||
    (text => confirmModal({ title: 'Передача контактов · риск раскрытия', text, okText: 'Подтвердить', danger: true }));
  const native = options.loadNative || (() => import('@tauri-apps/api/core'));
  const read = options.check || checkConnectedCloud;
  const prepare = options.stagePublication || stagePrivatePublication;
  const stage = options.stageApply || stagePrivateCloudApply;
  let busy = false;
  let generation = 0;
  let review = null;
  let rows = [];
  let witness = '';
  const fields = () => boxes.filter(box => box.checked).map(box => box.dataset.privateField);
  const disk = () => /** @type {'google'|'yandex'} */ (provider.value === 'google' ? 'google' : 'yandex');
  const note = text => {
    status.textContent = text;
  };
  function log(disk, action, outcome) {
    try {
      recordCloudActivity(disk, action, outcome);
    } catch {
      /* not a storage guarantee */
    }
  }
  function render() {
    publish.disabled = check.disabled = !options.desktop || busy;
    apply.disabled =
      !options.desktop ||
      busy ||
      !review ||
      version.value === '' ||
      !rows.some(row => row.selectable) ||
      review.versions.filter(row => row.observedHead).length !== 1 ||
      !review.versions[Number(version.value)]?.observedHead;
    version.disabled = busy;
    boxes.forEach(box => (box.disabled = busy || !options.desktop));
    source.disabled = risk.disabled = backup.disabled = busy || !options.desktop;
  }
  function clear() {
    review = null;
    rows = [];
    witness = '';
    list.replaceChildren();
    version.replaceChildren();
    times.textContent = '';
    incoming.hidden = true;
    render();
  }
  function resetConsent() {
    boxes.forEach(box => (box.checked = false));
    source.checked = risk.checked = backup.checked = false;
  }
  function consent() {
    const selected = fields();
    if (!selected.length || !source.checked || (selected.includes('password') && !risk.checked)) {
      note(MESSAGES.private_consent_required);
      return false;
    }
    return true;
  }
  function selection() {
    return [...list.querySelectorAll('input[data-private-index]')]
      .filter(box => /** @type {HTMLInputElement} */ (box).checked)
      .map(box => rows[Number(/** @type {HTMLElement} */ (box).dataset.privateIndex)])
      .filter(row => row?.selectable)
      .map(({ characterId, field }) => ({ characterId, field }));
  }
  function show() {
    rows = [];
    list.replaceChildren();
    witness = '';
    apply.disabled = true;
    if (!review || version.value === '') return;
    try {
      const item = review.versions[Number(version.value)];
      const local = currentCloudStateSnapshot();
      const differences = review.comparePrivate(item.pin, local, fields());
      rows = differences.slice(0, 1000);
      witness = JSON.stringify(local);
      for (const [index, row] of rows.entries()) {
        const label = doc.createElement('label');
        label.className = 'cloud-connection-ack';
        const box = doc.createElement('input');
        box.type = 'checkbox';
        box.dataset.privateIndex = String(index);
        box.disabled = !row.selectable;
        const text = doc.createElement('span');
        text.textContent = `${row.label} · ${LABELS[row.field]}: ${row.cloudPresent ? 'на диске заполнено' : 'на диске пусто — выбор ОЧИСТИТ местное поле'}; ${row.localPresent ? 'местное заполнено' : 'местное пусто'}${row.selectable ? '' : ' — сначала примените публичную запись персонажа'}`;
        label.append(box, text);
        list.append(label);
      }
      apply.disabled =
        busy ||
        !item.observedHead ||
        review.versions.filter(row => row.observedHead).length !== 1 ||
        !rows.some(row => row.selectable);
      note(
        rows.length
          ? `Показаны только факты различий, без значений. Отметьте конкретные поля для замены.${differences.length > 1000 ? ' Показаны первые 1000 полей; остальные сейчас недоступны для выбора.' : ''}`
          : 'Различий в выбранных категориях нет или в этой версии они не передавались. Отсутствующая категория ничего не очищает.'
      );
    } catch {
      note('Не удалось сравнить контакты. Данные не применены.');
    }
  }
  provider.addEventListener('change', () => {
    generation++;
    clear();
    resetConsent();
    note('Выбран другой диск. Разрешения передачи сброшены.');
  });
  for (const box of [...boxes, source, risk])
    box.addEventListener('change', () => {
      generation++;
      clear();
    });
  backup.addEventListener('change', () => {
    generation++;
  });
  version.addEventListener('change', show);
  publish.addEventListener('click', async () => {
    if (!options.desktop || busy || !consent()) return;
    const gen = generation;
    const selected = disk();
    busy = true;
    clear();
    render();
    let operation;
    try {
      const transport = await native();
      operation = await prepare({
        provider: selected,
        invoke: transport.invoke,
        fields: fields(),
        contactsSourceConfirmed: source.checked,
        acknowledgePasswordRisk: risk.checked
      });
      if (gen !== generation) {
        operation.cancel?.();
        return;
      }
      if (operation.status !== 'private_publication_review') {
        note(
          MESSAGES[operation.status] ||
            'Подготовка контактов остановлена. Проверьте сохранение, очередь и связанные данные.'
        );
        return;
      }
      const approved = await askConfirmation(
        `Подготовить ручную передачу ${operation.characterCount} персонажей, включая архив, на ${selected === 'google' ? 'Google Диск' : 'Яндекс Диск'}? Категории: ${operation.fields.map(field => LABELS[field]).join(', ')}. Пустые поля передаются как явная очистка. Все, кто имеет ключ набора, смогут расшифровать переданные данные. Не выбранные категории не добавляются и не удаляют ранее переданные данные. Эта партия останется в зашифрованной очереди до отправки, даже если разрешения будут сняты. Дальнейшие местные изменения контактов автоматически в неё НЕ добавляются. Обновите все ПК. Значения на экран не выводятся.`
      );
      if (!approved || gen !== generation || disk() !== selected) {
        operation.cancel();
        note('Передача отменена.');
        return;
      }
      const result = await operation.commit({ confirmed: true });
      note(MESSAGES[result.status] || 'Подготовка не подтверждена; проверьте очередь перед повтором.');
      log(
        selected,
        'private_prepare',
        ['queued', 'coalesced', 'unchanged'].includes(result.status)
          ? 'success'
          : result.status === 'journal_uncertain'
            ? 'uncertain'
            : 'blocked'
      );
    } catch {
      note('Передача контактов не подготовлена. Значения не выводились.');
    } finally {
      operation?.cancel?.();
      busy = false;
      resetConsent();
      render();
    }
  });
  check.addEventListener('click', async () => {
    if (!options.desktop || busy || !consent()) return;
    const gen = generation;
    const selected = disk();
    busy = true;
    clear();
    render();
    try {
      const transport = await native();
      const value = /** @type {any} */ (await read({ provider: selected, invoke: transport.invoke }));
      if (gen !== generation) return;
      if (value.status !== 'ready_for_review') {
        note('Проверка контактов не выполнена. Проверьте выбранный диск и ключ.');
        return;
      }
      review = value;
      const blank = doc.createElement('option');
      blank.value = '';
      blank.textContent = 'Выберите версию — дата не определяет победителя';
      version.append(blank);
      value.versions.forEach((row, index) => {
        const option = doc.createElement('option');
        option.value = String(index);
        option.textContent = `Версия ${index + 1} · файл: ${date(row.modifiedAt)}${row.observedHead ? ' · наблюдаемая вершина' : ''}`;
        version.append(option);
      });
      times.textContent = `Источник: ${selected === 'google' ? 'Google Диск' : 'Яндекс Диск'}. Проверено: ${date(value.checkedAt)}. Локальное сохранение: ${date(value.localSavedAt)}. Часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'местный часовой пояс'}.`;
      incoming.hidden = false;
      note('Выберите версию для закрытого сравнения. Значения контактов и паролей не показываются.');
      log(selected, 'private_check', 'success');
    } catch {
      note('Проверка контактов не выполнена; данные не применены.');
    } finally {
      busy = false;
      render();
      if (review && version.value !== '') show();
    }
  });
  apply.addEventListener('click', async () => {
    if (!options.desktop || busy || !review || !consent()) return;
    if (!backup.checked) {
      note(
        'Перед заменой требуется отдельная копия прежних контактов: копия state может не содержать данные OS-хранилища.'
      );
      return;
    }
    const chosen = selection();
    if (!chosen.length) {
      note('Отметьте конкретные поля для применения.');
      return;
    }
    const original = review;
    const target = review.versions[Number(version.value)]?.pin;
    const gen = generation;
    const selected = disk();
    const choices = JSON.stringify(chosen);
    const savedWitness = witness;
    busy = true;
    render();
    let operation;
    try {
      const approved = await askConfirmation(
        `Заменить ${chosen.length} выбранных полей контактов данными указанной версии? Выбор пустого поля на диске удалит местное значение. Местные пароли и контакты могут быть потеряны. Копия state.json при OS-хранилище содержит только ссылки, НЕ старые значения vault; требуется уже сохранённая отдельная защищённая копия прежних контактов. Доступность OS-хранилища и сохранённое состояние проверяются перед записью. Передача местных секретов обратно в облако автоматически не включается.`
      );
      if (
        !approved ||
        gen !== generation ||
        review !== original ||
        JSON.stringify(selection()) !== choices ||
        JSON.stringify(currentCloudStateSnapshot()) !== savedWitness ||
        JSON.stringify(review.versions[Number(version.value)]?.pin) !== JSON.stringify(target)
      ) {
        note('Применение отменено или данные изменились.');
        return;
      }
      const transport = await native();
      const fresh = /** @type {any} */ (await read({ provider: selected, invoke: transport.invoke }));
      if (
        gen !== generation ||
        fresh.status !== 'ready_for_review' ||
        fresh.versions.filter(row => row.observedHead).length !== 1 ||
        !fresh.versions.some(
          row => row.observedHead && row.pin.versionId === target.versionId && row.pin.sha256 === target.sha256
        ) ||
        JSON.stringify(currentCloudStateSnapshot()) !== savedWitness
      ) {
        note('Источники изменились. Повторите проверку контактов.');
        return;
      }
      operation = stage({
        review: fresh,
        pin: target,
        selections: chosen,
        contactsSourceConfirmed: source.checked,
        acknowledgePasswordRisk: risk.checked,
        independentBackupConfirmed: backup.checked
      });
      const result = await operation.commit({ confirmed: true });
      if (result.status === 'applied') {
        clear();
        note(
          `Выбранные контакты применены. Копия файла состояния: ${result.backup} (не замена отдельной копии vault). Остальные поля не менялись. Автоматическая выгрузка местных секретов не включена.`
        );
        log(selected, 'private_apply', 'success');
      } else {
        note('Применение не подтверждено. Проверьте данные и резервные копии перед повтором.');
        log(selected, 'private_apply', result.status?.endsWith('_restart') ? 'uncertain' : 'blocked');
      }
    } catch {
      note('Применение контактов остановлено. Источник, очередь или локальное хранилище могли измениться.');
    } finally {
      operation?.cancel?.();
      busy = false;
      resetConsent();
      render();
    }
  });
  resetConsent();
  clear();
  render();
}
