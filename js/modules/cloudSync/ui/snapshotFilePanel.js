// @ts-check
import {
  checkSnapshotFile,
  replaceFromSnapshotFile,
  uploadSnapshotFile,
  resumeSnapshotFileUpload,
  inspectSnapshotFileUpload,
  releaseSnapshotFileUpload
} from '../snapshotFileExchange.js';
import { saveNow } from '../../../core/storage.js';
import { stageSyncIdentities } from '../commitSyncIdentities.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';

const LABELS = {
  characters: 'Персонажи',
  parties: 'Пати',
  marathons: 'Марафоны',
  planner: 'Календарь',
  finance: 'Финансы',
  preferences: 'Настройки'
};
const STATUS = {
  ready: 'Файл скачан и проверен. Местные данные не заменялись.',
  prepared_cancelled:
    'Подготовка отменена с резервной копией. Облако не изменялось. Теперь можно отправить текущие данные.',
  pending_released_uncertain:
    'Ожидание снято с резервной копией, но результат прежней загрузки неизвестен. Она не отменена на диске и ещё может появиться. Новая отправка требует новой проверки.',
  unknown_acknowledgement_required:
    'Подтвердите, что прежняя попытка могла уже записать файл и не отменяется этим действием.',
  unsettled_limit: 'Слишком много попыток с неизвестным результатом. Сначала проверьте и примите облачные файлы.',
  resolution_confirmation_required: 'Выбор итогового полного файла требует отдельного подтверждения.',
  selection_required: 'Сначала выберите облачный файл и проверьте различия.',
  sent_with_conflicts:
    'Отправленный файл сверен, но есть конкурентные версии. Выберите итоговый файл; они не объединяются автоматически.',
  sent_remote_advanced: 'Отправленный файл сверен. На диске уже появилась следующая версия; повторите проверку.',
  sent_verified: 'Полный снимок отправлен и сверен чтением с диска.',
  applied: 'Данные из файла применены. Предыдущее местное состояние сохранено в резервной копии.',
  confirmation_required: 'Нужно подтверждение операции.',
  private_confirmation_required: 'Сохранение ранее переданной секретной части требует отдельного согласия.',
  overwrite_confirmation_required: 'На диске есть непринятая версия. Её замена требует отдельного согласия.',
  upload_deferred: 'Загрузка не начиналась. Подготовленный зашифрованный файл сохранён; можно продолжить отправку.',
  pending_upload: 'Есть незавершённая отправка. Сначала проверьте её результат.',
  verification_pending:
    'Отправка могла выполниться. Нажмите «Проверить незавершённую отправку»; повторной загрузки не будет.',
  content_mismatch: 'Файл не совпал с отправленным. Ничего не считайте подтверждённым.',
  prepared_local_changed:
    'После подготовки файла местные данные изменились. Можно отменить подготовку с резервной копией и отправить текущие данные.',
  remote_changed_pending:
    'Облачный файл изменился после подготовки. Отправка остановлена. Можно отменить подготовку и заново сравнить текущие данные.',
  remote_changed: 'Облачная версия изменилась. Повторите сравнение.',
  state_changed_or_unsaved:
    'Местные данные изменились или ещё не сохранены. Дождитесь сохранения и повторите проверку.',
  legacy_queue_pending:
    'В прежнем режиме есть ожидающая или неподтверждённая очередь. Завершите её до перехода на обмен файлами.',
  binding_blocked: 'Сначала подключите диск и подготовьте либо восстановите существующий набор.',
  binding_missing: 'Для этого диска ещё нет подключённого набора.',
  multiple_files:
    'На диске есть несколько расходящихся версий. Они сохранены; Выберите файл ниже, чтобы посмотреть различия; дата не выбирает победителя.',
  history_limit: 'Достигнут предел числа резервных версий. Нужна безопасная архивация истории.',
  idle: 'Незавершённых отправок нет.',
  unavailable_or_changed:
    'Не удалось проверить файл или данные изменились. Ничего не заменено автоматически. Проверьте подключение и подготовку ID.',
  pending_invalid: 'Ожидающий файл не прошёл проверку. Отправка остановлена.',
  pending_changed: 'Незавершённая отправка изменилась. Старое подтверждение не используется; повторите проверку.',
  storage_blocked:
    'Не удалось подтвердить резервную копию или сохранение. Операция остановлена; не считайте подготовку очищенной.',
  disk_changed_or_unsaved:
    'Файл местного состояния изменился или не совпал с сохранением. Повторите проверку после сохранения.',
  state_changed: 'Местные данные изменились. Старое подтверждение не применяется.',
  write_unconfirmed_restart:
    'Местная запись не подтверждена. Не продолжайте отправку: перезапустите приложение и проверьте резервную копию.',
  state_changed_during_write_restart:
    'Данные изменились во время записи. Перезапустите приложение и проверьте резервную копию перед продолжением.',
  state_changed_after_backup_restart:
    'Состояние изменилось после создания копии. Перезапустите приложение перед продолжением.'
};
const diskName = disk => (disk === 'google' ? 'Google Диск' : 'Яндекс Диск');
function time(value) {
  if (value === null || value === undefined || !Number.isFinite(new Date(value).getTime())) return 'неизвестно';
  return new Date(value).toLocaleString('ru-RU');
}
/** @param {{doc?:Document,desktop:boolean,loadNative?:()=>Promise<any>,confirm?:(text:string)=>boolean|Promise<boolean>,check?:typeof checkSnapshotFile,replace?:typeof replaceFromSnapshotFile,upload?:typeof uploadSnapshotFile,resume?:typeof resumeSnapshotFileUpload,prepareIdentities?:typeof stageSyncIdentities,save?:()=>Promise<any>,inspect?:typeof inspectSnapshotFileUpload,release?:typeof releaseSnapshotFileUpload}} options */
export function bindSnapshotFilePanel(options) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-file-panel');
  const provider = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-registration-provider'));
  if (!panel || !provider || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  const el = id => doc.getElementById(`cloud-file-${id}`);
  const status = el('status'),
    list = el('list'),
    dates = el('times'),
    result = el('result');
  const checkButton = /** @type {HTMLButtonElement} */ (el('check'));
  const uploadButton = /** @type {HTMLButtonElement} */ (el('upload'));
  const applyButton = /** @type {HTMLButtonElement} */ (el('apply'));
  const resumeButton = /** @type {HTMLButtonElement} */ (el('resume'));
  const releaseButton = /** @type {HTMLButtonElement} */ (el('release'));
  const resolveButton = /** @type {HTMLButtonElement} */ (el('resolve'));
  const variants = el('choices');
  const prepareButton = /** @type {HTMLButtonElement} */ (el('prepare'));
  if (
    !status ||
    !list ||
    !dates ||
    !result ||
    !checkButton ||
    !uploadButton ||
    !applyButton ||
    !resumeButton ||
    !prepareButton ||
    !releaseButton ||
    !resolveButton ||
    !variants
  )
    return;
  const loadNative = options.loadNative || (async () => ({ invoke: (await import('@tauri-apps/api/core')).invoke }));
  const ask =
    options.confirm ||
    (text => confirmModal({ title: 'Обмен файлом Твинофермы', text, okText: 'Подтвердить', danger: true }));
  const check = options.check || checkSnapshotFile,
    upload = options.upload || uploadSnapshotFile;
  const replace = options.replace || replaceFromSnapshotFile,
    resume = options.resume || resumeSnapshotFileUpload;
  const inspect = options.inspect || inspectSnapshotFileUpload,
    release = options.release || releaseSnapshotFileUpload;
  let busy = false,
    generation = 0,
    view = null,
    chosenChoice = null;
  const selected = () => (provider.value === 'google' ? 'google' : 'yandex');
  const note = text => {
    status.textContent = options.desktop
      ? text
      : 'Обмен с настоящим диском доступен в настольном приложении. Веб-предпросмотр ничего не отправляет.';
  };
  function controls() {
    for (const button of [checkButton, uploadButton, resumeButton, prepareButton, releaseButton])
      button.disabled = !options.desktop || busy;
    for (const button of variants.querySelectorAll('button')) {
      button.disabled = !options.desktop || busy;
      const pressed = !!view && button.dataset.versionId === view.pin.versionId;
      button.setAttribute('aria-pressed', String(pressed));
      button.textContent = `${pressed ? '✓ ' : ''}${button.dataset.label}`;
    }
    resolveButton.hidden = !view?.requiresResolution;
    resolveButton.disabled = !options.desktop || busy || !view || !!view.pending;
    applyButton.disabled = !options.desktop || busy || !view || !!view.pending;
  }
  function report(disk, action, value) {
    note(
      `${diskName(disk)}: ${STATUS[value.status] || 'Операция не подтверждена. Проверьте состояние и резервные копии.'}`
    );
    try {
      recordCloudActivity(
        disk,
        action,
        ['ready', 'applied', 'sent_verified', 'prepared_cancelled', 'sent_remote_advanced'].includes(value.status)
          ? 'success'
          : ['verification_pending', 'pending_released_uncertain', 'sent_with_conflicts'].includes(value.status)
            ? 'uncertain'
            : 'blocked'
      );
    } catch {
      /* no sensitive diagnostic */
    }
  }
  function show(value) {
    view = value.status === 'ready' ? value : null;
    result.hidden = !view;
    list.replaceChildren();
    if (value.status === 'multiple_files') {
      chosenChoice = null;
      variants.replaceChildren();
      variants.hidden = false;
      const explanation = doc.createElement('p');
      explanation.textContent =
        'Ни один файл не выбран автоматически. Посмотрите различия, затем явно выберите полный облачный файл либо отправьте свой местный снимок. Прежние версии останутся резервными.';
      variants.append(explanation);
      for (const choice of value.choices || []) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn ghost';
        button.textContent = `Просмотреть файл ${choice.pin.versionId} · ${time(choice.modifiedAt)}`;
        button.dataset.label = button.textContent;
        button.dataset.versionId = choice.pin.versionId;
        button.addEventListener('click', () => void run('choose', choice));
        variants.append(button);
      }
    } else if (!view) {
      chosenChoice = null;
      variants.replaceChildren();
      variants.hidden = true;
    }
    controls();
    if (!view) return;
    dates.textContent = `Файл на диске: ${time(view.modifiedAt)} · Проверено: ${time(view.checkedAt)} · Местное сохранение: ${time(view.localSavedAt)} · Часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    el('summary').textContent = view.matches
      ? 'Переносимые данные совпадают с файлом.'
      : `${view.localChanged ? 'Есть местные изменения. ' : ''}${view.remoteChanged ? 'На диске есть версия, не принятая этим ПК. ' : ''}Ниже — различия. Автоматического объединения нет.`;
    if (view.requiresResolution)
      el('summary').textContent +=
        ' На диске несколько версий. Этот файл пока только выбран для просмотра; актуальным он ещё не назначен.';
    if (view.unsettled)
      el('summary').textContent +=
        ` Есть ранее снятые ожидания: ${view.unsettled}. Их результат ещё может проявиться на диске.`;
    for (const entry of view.differences.entries.slice(0, 1000)) {
      const row = doc.createElement('li');
      const kind =
        entry.kind === 'only_local'
          ? 'отсутствует в файле — будет удалено при полной замене'
          : entry.kind === 'only_cloud'
            ? 'будет добавлено из файла'
            : 'будет заменено данными из файла';
      row.textContent = `${LABELS[entry.section] || 'Данные'}${entry.label ? ` · ${entry.label}` : ''}: ${kind}`;
      if (entry.changes?.length) {
        const details = doc.createElement('details'),
          summary = doc.createElement('summary'),
          fields = doc.createElement('ul');
        summary.textContent = `Изменённые поля: ${entry.changes.length}`;
        details.append(summary, fields);
        const names = {
          fields: 'Данные',
          notes: 'Заметка',
          level: 'Уровень',
          nick: 'Ник',
          archived: 'Архив',
          partyIds: 'Пати',
          mainPartyId: 'Основная пати',
          partyOrder: 'Порядок в пати',
          order: 'Порядок',
          title: 'Название',
          name: 'Название',
          status: 'Статус'
        };
        const value = part =>
          !part?.present
            ? 'отсутствует'
            : (typeof part.value === 'string' ? part.value : JSON.stringify(part.value)).slice(0, 400);
        for (const change of entry.changes.slice(0, 30)) {
          const field = doc.createElement('li');
          field.textContent = `${change.path.map(key => names[key] || key).join(' › ')}: ${value(change.local)} → ${value(change.cloud)}`;
          fields.append(field);
        }
        if (entry.changes.length > 30) {
          const field = doc.createElement('li');
          field.textContent = 'Показаны первые 30 полей; полная замена учитывает остальные поля тоже.';
          fields.append(field);
        }
        row.append(details);
      }
      list.append(row);
    }
    if (view.differences.entries.length > 1000) {
      const row = doc.createElement('li');
      row.textContent = 'Показаны первые 1000 различий. Полная замена применит весь файл, включая остальные записи.';
      list.append(row);
    }
    controls();
  }
  async function run(action, choice = null) {
    if (!options.desktop || busy) return;
    busy = true;
    controls();
    const disk = selected(),
      token = generation;
    try {
      const native = await loadNative();
      if (token !== generation) return;
      const opts = { provider: disk, invoke: native.invoke };
      if (action === 'release') {
        await (options.save || saveNow)();
        if (token !== generation) return;
        const pending = await inspect(opts);
        if (token !== generation) return;
        if (pending.status !== 'pending' || !('phase' in pending)) {
          report(disk, 'file_release', pending);
          return;
        }
        const unknown = pending.phase === 'attempting';
        const message = unknown
          ? 'Снять местное ожидание загрузки? Это НЕ отменяет запрос на диске и НЕ подтверждает его успех или отсутствие. Файл ещё может появиться и создать конкурентную версию. Сохранится резервная копия с прежним зашифрованным файлом; новая отправка будет отдельным действием.'
          : 'Отменить подготовленный, но не начатый файл? Текущие местные данные сохранятся; перед очисткой подготовки будет резервная копия. Ничего не удалится и не отправится на диск. Затем можно отправить актуальные данные.';
        if (!(await ask(message)) || token !== generation) return;
        if (
          unknown &&
          (!(await ask(
            'Я понимаю: результат прежней загрузки остаётся неизвестным. Снятие ожидания не отменяет облачный файл, не удаляет его и не повторяет загрузку. Продолжить?'
          )) ||
            token !== generation)
        )
          return;
        const value = await release({
          ...opts,
          review: pending,
          confirmed: true,
          ...(unknown ? { unknownOutcomeAcknowledged: true } : {})
        });
        if (token === generation) {
          show({ status: 'empty' });
          report(disk, 'file_release', value);
        }
        return;
      }

      if (action === 'prepare') {
        if (
          !(await ask('Подготовить недостающие sync-ID с резервной копией? Облачный файл не изменится.')) ||
          token !== generation
        )
          return;
        const staged = (options.prepareIdentities || stageSyncIdentities)();
        const value = staged.status === 'prepared' ? await staged.operation.commit({ confirmed: true }) : staged;
        if (token === generation) {
          show({ status: 'empty' });
          note(
            value.status === 'already_assigned' || value.status === 'applied'
              ? 'Данные подготовлены. Теперь можно проверить диск.'
              : 'Подготовка не подтверждена. Проверьте сохранение и копии.'
          );
        }
        return;
      }
      if (action === 'resume') {
        if (
          !(await ask(
            'Проверить незавершённую отправку? Для уже начатой загрузки выполняется только чтение. Подготовленный, но ещё не отправлявшийся файл может быть отправлен после повторной проверки.'
          )) ||
          token !== generation
        )
          return;
        const value = await resume({ ...opts, confirmed: true });
        if (token === generation) {
          show({ status: 'empty' });
          report(disk, 'publish', value);
        }
        return;
      }
      if (action === 'upload') {
        await (options.save || saveNow)();
        if (token !== generation) return;
        const identities = (options.prepareIdentities || stageSyncIdentities)();
        if (identities.status === 'prepared') {
          const assigned = await identities.operation.commit({ confirmed: true });
          if (assigned.status !== 'applied') {
            note('Не удалось сохранить ID перед отправкой. Облачный файл не изменён.');
            return;
          }
        } else if (identities.status !== 'already_assigned') {
          note('Не удалось подготовить данные для отправки.');
          return;
        }
        if (token !== generation) return;
      }
      if (!['apply', 'resolve'].includes(action)) {
        if (action === 'check') chosenChoice = null;
        const selectedChoice = action === 'choose' ? choice : chosenChoice;
        const value = await check({ ...opts, ...(selectedChoice ? { choice: selectedChoice } : {}) });
        if (token !== generation) return;
        if (value.status === 'ready') chosenChoice = selectedChoice;
        show(value);
        report(disk, 'check', value);
        if (action !== 'upload' || value.status !== 'ready') return;
      }
      if (!view) return;
      const current = view;
      const message =
        action === 'apply'
          ? `Заменить переносимые данные этой Твинофермы полным файлом с ${diskName(disk)}? Местные записи, отсутствующие в файле, будут удалены; порядок и поля будут взяты из файла. Даже не показанные в списке записи входят в замену. Перед записью сохранится резервная копия. Контакты и пароли не импортируются; местные пути и входы не переносятся. Копия state.json не является отдельной копией хранилища паролей Windows.`
          : action === 'resolve'
            ? `Сделать выбранный полный файл ${current.pin.versionId} актуальным на ${diskName(disk)}? Местные данные этим действием не заменяются. Другие версии и их данные не объединяются; они останутся резервными файлами. Приватная часть невыбранных файлов не переносится в итоговый файл.`
            : `${current.remoteChanged ? 'ВНИМАНИЕ: на диске есть версия, которую этот ПК не принимал. Вы замените её местным снимком, без объединения правок. ' : ''}Отправить полный снимок сохранённых местных данных на ${diskName(disk)}? Он станет актуальным файлом, включая удаления и порядок. Предыдущие облачные файлы останутся резервными версиями. Новые местные контакты и пароли не выгружаются.`;
      if (!(await ask(message)) || token !== generation || view !== current) return;
      if (
        action !== 'apply' &&
        current.requiresResolution &&
        (!(await ask(
          'Подтверждаете выбор одного итогового полного файла вместо всех показанных конкурирующих версий? Их данные не объединяются. Не выбранные файлы останутся резервными; перед новым изменением списка потребуется новое подтверждение.'
        )) ||
          token !== generation ||
          view !== current)
      )
        return;
      let privateCarryConfirmed = false;
      if (action !== 'apply' && current.privateCarry) {
        privateCarryConfirmed = await ask(
          'В облачном файле есть ранее переданная секретная часть. Разрешить сохранить её в следующем зашифрованном файле? Местные контакты не заменятся, новые местные значения не выгрузятся.'
        );
        if (!privateCarryConfirmed || token !== generation || view !== current) return;
      }
      const value =
        action === 'apply'
          ? await replace({ ...opts, review: current, confirmed: true })
          : await upload({
              ...opts,
              review: current,
              confirmed: true,
              overwriteConfirmed: current.remoteChanged,
              privateCarryConfirmed,
              resolutionConfirmed: current.requiresResolution === true,
              ...(action === 'resolve' ? { useCloudFile: true } : {})
            });
      if (token !== generation) return;
      show({ status: 'empty' });
      report(disk, action === 'apply' ? 'file_replace' : current.requiresResolution ? 'file_choice' : 'publish', value);
      if (value.status === 'applied') {
        if (current.requiresResolution)
          note(
            `${STATUS.applied} На диске по-прежнему несколько версий. Местная замена не назначала облачный файл актуальным; для этого проверьте диск и подтвердите выбор отдельно.`
          );
        doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-applied'));
      }
    } catch {
      if (token === generation) note(STATUS.unavailable_or_changed);
    } finally {
      busy = false;
      controls();
    }
  }
  checkButton.addEventListener('click', () => void run('check'));
  uploadButton.addEventListener('click', () => void run('upload'));
  applyButton.addEventListener('click', () => void run('apply'));
  resumeButton.addEventListener('click', () => void run('resume'));
  prepareButton.addEventListener('click', () => void run('prepare'));
  releaseButton.addEventListener('click', () => void run('release'));
  resolveButton.addEventListener('click', () => void run('resolve'));
  provider.addEventListener('change', () => {
    generation++;
    show({ status: 'empty' });
    controls();
    note('Диск изменён. Повторите проверку файла.');
  });
  doc.defaultView?.addEventListener('tf-persisted', () => {
    if (busy || !options.desktop) return;
    generation++;
    show({ status: 'empty' });
    controls();
    note(
      'Есть новое местное сохранение. Облачный файл автоматически не менялся; проверьте различия или отправьте местный снимок.'
    );
  });
  let started = false;
  doc.defaultView?.addEventListener('tf-cloud-startup-check', () => {
    if (!options.desktop || started || busy) return;
    started = true;
    void (async () => {
      await run('check');
      if (busy) return;
      // Check the other provider without replacing the selected disk's comparison.
      const disk = selected() === 'google' ? 'yandex' : 'google';
      try {
        const native = await loadNative();
        const value = await check({ provider: disk, invoke: native.invoke });
        const other = el('other');
        if (other) other.textContent = `${diskName(disk)}: ${STATUS[value.status] || 'проверка не завершена'}`;
      } catch {
        /* optional other disk unavailable */
      }
    })();
  });
  if (!options.desktop)
    note('Обмен с настоящим диском доступен в настольном приложении. Веб-предпросмотр ничего не отправляет.');
  controls();
}
