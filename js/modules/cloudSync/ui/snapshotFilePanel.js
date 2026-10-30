// @ts-check
import {
  checkSnapshotFile,
  replaceFromSnapshotFile,
  uploadSnapshotFile,
  resumeSnapshotFileUpload
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
    'После подготовки файла местные данные изменились. Подготовленный файл сохранён; требуется разбор очереди.',
  remote_changed_pending:
    'Облачный файл изменился после подготовки. Подготовленный снимок сохранён, отправка остановлена.',
  remote_changed: 'Облачная версия изменилась. Повторите сравнение.',
  state_changed_or_unsaved:
    'Местные данные изменились или ещё не сохранены. Дождитесь сохранения и повторите проверку.',
  legacy_queue_pending:
    'В прежнем режиме есть ожидающая или неподтверждённая очередь. Завершите её до перехода на обмен файлами.',
  binding_blocked: 'Сначала подключите диск и подготовьте либо восстановите существующий набор.',
  binding_missing: 'Для этого диска ещё нет подключённого набора.',
  multiple_files:
    'На диске есть несколько расходящихся версий. Они сохранены; автоматический выбор и перезапись остановлены.',
  history_limit: 'Достигнут предел числа резервных версий. Нужна безопасная архивация истории.',
  idle: 'Незавершённых отправок нет.',
  unavailable_or_changed:
    'Не удалось проверить файл или данные изменились. Ничего не заменено автоматически. Проверьте подключение и подготовку ID.',
  pending_invalid: 'Ожидающий файл не прошёл проверку. Отправка остановлена.'
};
const diskName = disk => (disk === 'google' ? 'Google Диск' : 'Яндекс Диск');
function time(value) {
  if (value === null || value === undefined || !Number.isFinite(new Date(value).getTime())) return 'неизвестно';
  return new Date(value).toLocaleString('ru-RU');
}
/** @param {{doc?:Document,desktop:boolean,loadNative?:()=>Promise<any>,confirm?:(text:string)=>boolean|Promise<boolean>,check?:typeof checkSnapshotFile,replace?:typeof replaceFromSnapshotFile,upload?:typeof uploadSnapshotFile,resume?:typeof resumeSnapshotFileUpload,prepareIdentities?:typeof stageSyncIdentities,save?:()=>Promise<any>}} options */
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
    !prepareButton
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
  let busy = false,
    generation = 0,
    view = null;
  const selected = () => (provider.value === 'google' ? 'google' : 'yandex');
  const note = text => {
    status.textContent = text;
  };
  function controls() {
    for (const button of [checkButton, uploadButton, resumeButton, prepareButton])
      button.disabled = !options.desktop || busy;
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
        ['ready', 'applied', 'sent_verified'].includes(value.status)
          ? 'success'
          : value.status === 'verification_pending'
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
    if (!view) return;
    dates.textContent = `Файл на диске: ${time(view.modifiedAt)} · Проверено: ${time(view.checkedAt)} · Местное сохранение: ${time(view.localSavedAt)} · Часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    el('summary').textContent = view.matches
      ? 'Переносимые данные совпадают с файлом.'
      : `${view.localChanged ? 'Есть местные изменения. ' : ''}${view.remoteChanged ? 'На диске есть версия, не принятая этим ПК. ' : ''}Ниже — различия. Автоматического объединения нет.`;
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
  async function run(action) {
    if (!options.desktop || busy) return;
    busy = true;
    controls();
    const disk = selected(),
      token = generation;
    try {
      const native = await loadNative();
      if (token !== generation) return;
      const opts = { provider: disk, invoke: native.invoke };
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
      if (action !== 'apply') {
        const value = await check(opts);
        if (token !== generation) return;
        show(value);
        report(disk, 'check', value);
        if (action === 'check' || value.status !== 'ready') return;
      }
      if (!view) return;
      const current = view;
      const message =
        action === 'apply'
          ? `Заменить переносимые данные этой Твинофермы полным файлом с ${diskName(disk)}? Местные записи, отсутствующие в файле, будут удалены; порядок и поля будут взяты из файла. Даже не показанные в списке записи входят в замену. Перед записью сохранится резервная копия. Контакты и пароли не импортируются; местные пути и входы не переносятся. Копия state.json не является отдельной копией хранилища паролей Windows.`
          : `${current.remoteChanged ? 'ВНИМАНИЕ: на диске есть версия, которую этот ПК не принимал. Вы замените её местным снимком, без объединения правок. ' : ''}Отправить полный снимок сохранённых местных данных на ${diskName(disk)}? Он станет актуальным файлом, включая удаления и порядок. Предыдущие облачные файлы останутся резервными версиями. Новые местные контакты и пароли не выгружаются.`;
      if (!(await ask(message)) || token !== generation || view !== current) return;
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
              privateCarryConfirmed
            });
      if (token !== generation) return;
      show({ status: 'empty' });
      report(disk, action === 'apply' ? 'file_replace' : 'publish', value);
      if (value.status === 'applied') doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-applied'));
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
  provider.addEventListener('change', () => {
    generation++;
    show({ status: 'empty' });
    controls();
    note('Диск изменён. Повторите проверку файла.');
  });
  doc.defaultView?.addEventListener('tf-persisted', () => {
    if (busy) return;
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
