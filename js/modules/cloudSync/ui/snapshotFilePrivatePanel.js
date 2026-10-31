// @ts-check
// Manual per-batch opt-in. Never render contact values (including email) or remember consent.
import {
  checkSnapshotFile,
  prepareSnapshotFilePrivateExport,
  checkSnapshotFilePrivate,
  uploadSnapshotFile,
  applySnapshotFilePrivate
} from '../snapshotFileExchange.js';
import { saveNow } from '../../../core/storage.js';
import { stageSyncIdentities } from '../commitSyncIdentities.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';
const LABELS = { email: 'Email', recoveryEmail: 'Запасная почта', phone: 'Телефон', password: 'Пароль' };
const MESSAGES = {
  private_consent_required:
    'Выберите категории, подтвердите полноту местного источника и отдельно риск передачи пароля.',
  private_source_unavailable:
    'Хранилище контактов недоступно или изменилось. Пустые поля не считаются очисткой; операция остановлена.',
  private_backup_required:
    'Нужна отдельная копия прежних контактов. Копия state.json не является копией Windows vault.',
  multiple_files: 'На диске несколько версий. Сначала явно выберите итоговый полный файл в основном блоке выше.',
  private_review_changed: 'Выбор устарел. Повторите подготовку или проверку.',
  private_pruning_confirmation_required:
    'Удаление приватных записей отсутствующих персонажей требует отдельного согласия.',
  pending_upload: 'Сначала проверьте незавершённую отправку либо отмените подготовку в основном блоке.',
  state_changed_or_unsaved: 'Данные изменились или не сохранены. Повторите проверку после сохранения.',
  remote_changed: 'Файл на диске изменился. Повторите просмотр и выбор.',
  sent_verified: 'Полный файл с выбранными контактами отправлен и сверен чтением.',
  sent_with_conflicts: 'Файл сверен, но появилась конкурентная версия. Выберите итоговый файл в основном блоке.',
  sent_remote_advanced: 'Файл сверен; на диске уже появилась следующая версия. Повторите проверку.',
  verification_pending:
    'Результат загрузки пока неизвестен. Используйте проверку незавершённой отправки выше — без повтора.',
  upload_deferred: 'Загрузка не начиналась. Зашифрованная партия сохранена в подготовленном файле; проверьте её выше.',
  applied: 'Только выбранные контакты применены. Публичный файл и его принятая база не обновлялись.',
  write_unconfirmed_restart:
    'Запись не подтверждена. Не продолжайте: перезапустите приложение и проверьте резервные копии.'
};
/** @param {{desktop:boolean,doc?:Document,loadNative?:()=>Promise<any>,confirm?:(text:string)=>boolean|Promise<boolean>,save?:()=>Promise<any>,prepareIdentities?:typeof stageSyncIdentities,check?:typeof checkSnapshotFile,prepareExport?:typeof prepareSnapshotFilePrivateExport,checkPrivate?:typeof checkSnapshotFilePrivate,upload?:typeof uploadSnapshotFile,apply?:typeof applySnapshotFilePrivate}} options */
export function bindSnapshotFilePrivatePanel(options) {
  const doc = options.doc || document,
    panel = doc.getElementById('cloud-file-private');
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  const el = id => doc.getElementById(`cloud-file-private-${id}`);
  const provider = /** @type {HTMLSelectElement} */ (doc.getElementById('cloud-registration-provider'));
  const source = /** @type {HTMLInputElement} */ (el('source')),
    risk = /** @type {HTMLInputElement} */ (el('risk')),
    backup = /** @type {HTMLInputElement} */ (el('backup'));
  const boxes = [...panel.querySelectorAll('input[data-file-private-field]')].map(
    box => /** @type {HTMLInputElement} */ (box)
  );
  const prepare = /** @type {HTMLButtonElement} */ (el('prepare')),
    checkButton = /** @type {HTMLButtonElement} */ (el('check')),
    send = /** @type {HTMLButtonElement} */ (el('send')),
    apply = /** @type {HTMLButtonElement} */ (el('apply'));
  const all = /** @type {HTMLButtonElement} */ (el('all')),
    none = /** @type {HTMLButtonElement} */ (el('none')),
    list = el('list'),
    result = el('result'),
    status = el('status');
  if (
    !provider ||
    !source ||
    !risk ||
    !backup ||
    !prepare ||
    !checkButton ||
    !send ||
    !apply ||
    !all ||
    !none ||
    !list ||
    !result ||
    !status
  )
    return;
  const ask =
    options.confirm ||
    (text =>
      confirmModal({ title: 'Пароли и контакты · отдельное согласие', text, okText: 'Подтвердить', danger: true }));
  const native = options.loadNative || (() => import('@tauri-apps/api/core'));
  let busy = false,
    generation = 0,
    publicReview = null,
    secretReview = null,
    mode = '',
    rows = [];
  const fields = () => boxes.filter(box => box.checked).map(box => box.dataset.filePrivateField);
  const disk = () => (provider.value === 'google' ? 'google' : 'yandex');
  const note = text => {
    status.textContent = options.desktop
      ? text
      : 'Пароли и контакты передаются только настольным приложением. Веб-предпросмотр ничего не отправляет.';
  };
  const selections = () =>
    [...list.querySelectorAll('input[data-private-pair]')]
      .filter(box => /** @type {HTMLInputElement} */ (box).checked)
      .map(box => rows[Number(/** @type {HTMLElement} */ (box).dataset.privatePair)])
      .filter(row => row?.selectable)
      .map(({ characterId, field }) => ({ characterId, field }));
  function controls() {
    for (const button of [prepare, checkButton]) button.disabled = busy || !options.desktop;
    for (const box of [...boxes, source, risk, backup]) box.disabled = busy || !options.desktop;
    for (const box of list.querySelectorAll('input'))
      box.disabled = busy || !options.desktop || !rows[Number(box.dataset.privatePair)]?.selectable;
    all.disabled = none.disabled = busy || !options.desktop || !secretReview;
    send.hidden = mode !== 'export';
    apply.hidden = mode !== 'import';
    send.disabled = busy || !options.desktop || mode !== 'export' || !selections().length;
    apply.disabled = busy || !options.desktop || mode !== 'import' || !selections().length || !backup.checked;
  }
  function clear() {
    secretReview?.cancel?.();
    secretReview = null;
    publicReview = null;
    rows = [];
    mode = '';
    list.replaceChildren();
    result.hidden = true;
    controls();
  }
  function reset() {
    for (const box of [...boxes, source, risk, backup]) box.checked = false;
  }
  function consent() {
    if (!fields().length || !source.checked || (fields().includes('password') && !risk.checked)) {
      note(MESSAGES.private_consent_required);
      return false;
    }
    return true;
  }
  function report(provider, action, value) {
    note(
      MESSAGES[value.status] ||
        'Операция не подтверждена. Проверьте сохранение, источник и резервные копии; значения не выводились.'
    );
    try {
      recordCloudActivity(
        provider,
        action,
        ['applied', 'sent_verified', 'sent_remote_advanced'].includes(value.status)
          ? 'success'
          : ['verification_pending', 'sent_with_conflicts'].includes(value.status)
            ? 'uncertain'
            : 'blocked'
      );
    } catch {
      /* no sensitive details */
    }
  }
  function show(value, kind) {
    secretReview = value;
    rows = value.rows.slice(0, 1000);
    mode = kind;
    result.hidden = false;
    if (backup.parentElement) backup.parentElement.hidden = kind !== 'import';
    list.replaceChildren();
    for (const [index, row] of rows.entries()) {
      const label = doc.createElement('label');
      label.className = 'cloud-connection-ack';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.dataset.privatePair = String(index);
      const text = doc.createElement('span');
      text.textContent = `${row.label} · ${LABELS[row.field]}: ${kind === 'export' ? (row.clears ? 'местное пусто — выбор ОЧИСТИТ поле в облачной партии' : 'местное заполнено — будет передано') : `${row.cloudPresent ? 'на диске заполнено' : 'на диске пусто — выбор ОЧИСТИТ местное поле'}; ${row.localPresent ? 'местное заполнено' : 'местное пусто'}`}${row.selectable ? '' : ' — сначала примените публичную запись персонажа'}`;
      label.append(box, text);
      list.append(label);
      box.addEventListener('change', () => {
        generation++;
        controls();
      });
    }
    note(
      `${kind === 'export' ? 'Подготовка только в памяти, файл ещё не отправлен.' : 'Показаны только различия, ничего не применено.'} Отметьте конкретные поля; значения скрыты.${value.rows.length > 1000 ? ' Показаны первые 1000 полей, остальные сейчас не выбираются.' : ''}`
    );
    if (!rows.length) note('В выбранных категориях нет отличающихся контактов для переноса. Ничего не применено.');
    controls();
  }
  for (const box of [...boxes, source, risk])
    box.addEventListener('change', () => {
      generation++;
      clear();
    });
  backup.addEventListener('change', () => {
    generation++;
    controls();
  });
  provider.addEventListener('change', () => {
    generation++;
    clear();
    reset();
    note('Диск изменён. Выбор и разрешения сброшены.');
  });
  for (const button of [all, none])
    button.addEventListener('click', () => {
      generation++;
      for (const box of list.querySelectorAll('input'))
        if (rows[Number(box.dataset.privatePair)]?.selectable) box.checked = button === all;
      controls();
    });
  async function run(action) {
    if (!options.desktop || busy || !consent()) return;
    const token = generation,
      provider = disk(),
      chosenFields = fields();
    busy = true;
    controls();
    try {
      const transport = await native();
      if (token !== generation) return;
      const opts = { provider, invoke: transport.invoke };
      if (['prepare', 'check'].includes(action)) {
        clear();
        if (action === 'prepare') {
          await (options.save || saveNow)();
          if (token !== generation) return;
          const staged = (options.prepareIdentities || stageSyncIdentities)();
          if (staged.status === 'prepared') {
            if ((await staged.operation.commit({ confirmed: true })).status !== 'applied') {
              note('Подготовка ID не подтверждена. Ничего не отправлено.');
              return;
            }
          } else if (staged.status !== 'already_assigned') {
            note('Не удалось подготовить ID.');
            return;
          }
        }
        if (token !== generation) return;
        const checked = await (options.check || checkSnapshotFile)(opts);
        if (token !== generation) return;
        if (checked.status !== 'ready') {
          report(provider, 'private_check', checked);
          return;
        }
        publicReview = checked;
        const value = await (
          action === 'prepare'
            ? options.prepareExport || prepareSnapshotFilePrivateExport
            : options.checkPrivate || checkSnapshotFilePrivate
        )({
          ...opts,
          review: checked,
          fields: chosenFields,
          contactsSourceConfirmed: source.checked,
          acknowledgePasswordRisk: risk.checked
        });
        if (token !== generation) {
          if ('cancel' in value && typeof value.cancel === 'function') value.cancel();
          return;
        }
        if (!['private_export_review', 'private_ready'].includes(value.status)) {
          report(provider, 'private_check', value);
          return;
        }
        show(value, action === 'prepare' ? 'export' : 'import');
        return;
      }
      if (!secretReview || !publicReview) return;
      const pairs = selections();
      if (!pairs.length) return;
      if (action === 'apply' && !backup.checked) {
        note(MESSAGES.private_backup_required);
        return;
      }
      const current = secretReview,
        view = publicReview,
        clears = rows.filter(
          row => row.clears && pairs.some(pair => pair.characterId === row.characterId && pair.field === row.field)
        ).length;
      const message =
        action === 'send'
          ? `Отправить полный местный файл и выбранные поля контактов: ${pairs.length}? Пустых полей: ${clears}; они явно очистят ранее переданные значения. Все, кто имеет ключ набора, смогут расшифровать эти данные. Публичные данные, удаления и порядок тоже станут местными. Не выбранные приватные категории сохраняются из облака, а новые местные значения в них не выгружаются. Партия останется в зашифрованном pending до завершения даже после снятия галочек. Дальнейшие изменения контактов в неё автоматически не добавляются.${view.remoteChanged ? ' ВНИМАНИЕ: облачная версия ещё не принята этим ПК; она будет заменена без объединения.' : ''}`
          : `Заменить только выбранные местные контакты: ${pairs.length}? Очисток пустыми значениями: ${clears}. Подтверждаете отдельную копию прежних контактов? Автоматический backup state.json не копирует Windows vault. Публичные данные и принятая облачная база не обновятся. Значения не выводятся.`;
      if (!(await ask(message)) || token !== generation || secretReview !== current) return;
      let pruning = false,
        carry = false;
      if (action === 'send' && view.privateOrphans) {
        pruning = await ask(
          `В местном файле отсутствуют персонажи с ранее переданными контактами: ${view.privateOrphans}. Разрешить не включать их приватные записи в новую актуальную версию? Прежние облачные файлы всё ещё содержат их; это не безвозвратное удаление секретов с диска.`
        );
        if (!pruning || token !== generation) return;
      }
      if (action === 'send' && view.privateCarry) {
        carry = await ask(
          'Разрешить сохранить ранее переданную совместимую приватную часть остальных полей в новом зашифрованном файле? Выбранные поля заменятся подтверждёнными местными значениями, остальные местные контакты не выгружаются.'
        );
        if (!carry || token !== generation) return;
      }
      const value =
        action === 'send'
          ? await (options.upload || uploadSnapshotFile)({
              ...opts,
              review: view,
              confirmed: true,
              overwriteConfirmed: view.remoteChanged,
              privateCarryConfirmed: carry,
              privatePruningConfirmed: pruning,
              privateExport: current,
              privateSelections: pairs
            })
          : await (options.apply || applySnapshotFilePrivate)({
              ...opts,
              review: current,
              selections: pairs,
              confirmed: true,
              contactsSourceConfirmed: source.checked,
              acknowledgePasswordRisk: risk.checked,
              independentBackupConfirmed: backup.checked
            });
      if (token !== generation) return;
      clear();
      reset();
      report(provider, action === 'send' ? 'private_send' : 'private_apply', value);
      if (value.status === 'applied') doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-applied'));
    } catch {
      note('Операция не подтверждена. Значения не выводились; проверьте источник и резервные копии.');
    } finally {
      busy = false;
      if (['send', 'apply'].includes(action)) {
        clear();
        reset();
      }
      controls();
    }
  }
  prepare.addEventListener('click', () => void run('prepare'));
  checkButton.addEventListener('click', () => void run('check'));
  send.addEventListener('click', () => void run('send'));
  apply.addEventListener('click', () => void run('apply'));
  for (const event of ['tf-persisted', 'tf-cloud-applied'])
    doc.defaultView?.addEventListener(event, () => {
      if (busy || !options.desktop) return;
      generation++;
      clear();
      reset();
      note('Данные сохранены или применены. Разрешения и прежний просмотр сброшены.');
    });
  if (!options.desktop) note('');
  controls();
}
