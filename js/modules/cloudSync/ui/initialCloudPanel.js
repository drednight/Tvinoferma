// @ts-check
import { preparationDiagnosticCode } from '../preparationDiagnostics.js';
import { saveNow } from '../../../core/storage.js';
import { stageSyncIdentities } from '../commitSyncIdentities.js';
// Экспериментальный интерфейс первого снимка и восстановления. Не включает
// автоматическую синхронизацию и не выдаёт неподтверждённый результат за успех.
// Секреты не записываются в журнал и не выводятся в текст статуса.
import { createInitialCloudSetup, readLocalCloudPairingCode } from '../initialCloudSetup.js';
import { connectAdditionalCloud } from '../connectAdditionalCloud.js';
import { checkCloudAccess } from '../checkCloudAccess.js';
import { inspectInitialCloudSend } from '../inspectInitialCloudSend.js';
import { sendInitialCloudRoot } from '../sendInitialCloudRoot.js';
import { createCloudRecovery } from '../recoverCloudConnection.js';
import { confirmModal } from '../../../core/ui.js';
import { recordCloudActivity } from '../cloudEventLog.js';

const ACCESS_MESSAGES = Object.fromEntries(
  Object.entries({
    identity: 'Проверка аккаунта',
    disk: 'Чтение API диска',
    upload_link: 'Получение ссылки для загрузки',
    file_id: 'Получение ID файла Google'
  }).flatMap(([stage, title]) =>
    Object.entries({
      unauthorized: 'API отклонил токен (401). Нужен повторный вход без удаления набора.',
      forbidden: 'API отказал в доступе (403). Проверьте разрешения приложения и доступ к API.',
      rate_limited: 'API ограничил частоту запросов (429). Повторите проверку позднее.',
      service_unavailable: 'API временно недоступен (5xx). Повторите проверку позднее.',
      http_error: 'API вернул отказ. В этой операции запись файла не запускалась.',
      invalid_response: 'Ответ или ссылка не прошли строгую проверку. Защита не отключена.',
      transport_unavailable: 'Сетевой/native-запрос не завершён. Проверьте соединение и повторите проверку доступа.',
      timeout: 'Истекло время проверки. В этой операции запись файла не запускалась.',
      aborted: 'Проверка прервана. В этой операции запись файла не запускалась.'
    }).map(([reason, message]) => [
      `${stage}_${reason}`,
      `${title}: ${message} Подготовленный снимок сохранён. Код: setup/${stage}_${reason}.`
    ])
  )
);
const MESSAGES = Object.freeze({
  ...ACCESS_MESSAGES,
  additional_connected:
    'Этот же зашифрованный набор подключён ко второму диску. Первый диск и ключи сохранены. Отправляйте и проверяйте каждый диск отдельно.',
  source_binding_unavailable:
    'На другом диске нет проверенной местной привязки. Сначала создайте или восстановите набор на одном диске; затем подключите этот же набор ко второму.',
  source_root_unavailable:
    'Начальный зашифрованный файл отсутствует в местной очереди и не прочитан с первого диска. Сначала проверьте доступ и наличие первого файла; ключи и первый диск сохранены.',
  access_verified:
    'Аккаунт и чтение API диска подтверждены. Файлы не отправлялись и не удалялись. Право записи и содержимое подтверждаются только отправкой и чтением файла. Код: setup/access_verified.',
  credential_missing_or_blocked: 'Сначала сохраните и проверьте доступ к выбранному диску.',
  binding_missing_or_blocked:
    'Для выбранного диска нет подтверждённой местной привязки набора либо она заблокирована. Если набор уже есть на другом диске, нажмите «Подключить этот же набор ко второму диску». Не удаляйте существующую привязку и ключи. Код: setup/binding_missing_or_blocked.',
  binding_missing:
    'Для выбранного диска местная привязка набора не найдена. Переключение с другого диска её не переносит. Код: setup/binding_missing.',
  binding_blocked:
    'Местная привязка выбранного диска не прошла проверку ключа или аккаунта. Не удаляйте привязку и ключи. Код: setup/binding_blocked.',
  binding_unavailable:
    'Не удалось повторно проверить местную привязку выбранного диска. Не удаляйте её и не повторяйте отправку. Код: setup/binding_unavailable.',
  credential_missing:
    'Сохранённый доступ к выбранному диску не найден. Доступ к другому диску его не заменяет. Код: setup/credential_missing.',
  credential_blocked:
    'Сохранённый доступ к выбранному диску не прошёл проверку. Не удаляйте связанный набор или ключи. Код: setup/credential_blocked.',
  credential_unavailable:
    'Не удалось прочитать сохранённый доступ к выбранному диску. Это не подтверждает его отсутствие; не удаляйте запись. Код: setup/credential_unavailable.',
  login_required:
    'Срок доступа к выбранному диску истёк. Нужен повторный вход с сохранением существующего набора; не удаляйте привязку. Код: setup/login_required.',
  account_unavailable:
    'Аккаунт, доступ или привязка изменились во время операции. Результат отправки не подтверждён; не повторяйте её. Код: setup/account_unavailable.',
  dataset_binding_present:
    'Набор уже существует. Для второго диска используйте «Подключить этот же набор ко второму диску»: пароль и запасной ключ останутся прежними. Новый независимый набор не создан; введённые секреты не заменили существующие.',
  key_present:
    'Внутренний ключ уже существует. Не создаём новый; проверьте восстановление или продолжите прерванную настройку.',
  key_missing: 'Внутренний ключ на этом ПК не найден. Используйте основной пароль или запасной ключ.',
  existing_key_requires_confirmation:
    'Ключ уже сохранён на этом ПК. Выберите восстановление с уже сохранённым внутренним ключом.',
  key_mismatch: 'Сохранённый внутренний ключ не совпадает с независимым кодом. Ничего не изменено.',
  key_missing_or_blocked: 'Внутренний ключ не найден или требует проверки. Ничего не изменено.',
  queue_present: 'Локальная очередь уже существует. Не создаём новый набор поверх неё.',
  queue_blocked: 'Локальная очередь не подтверждена или относится к другому набору. Ничего не отправлено.',
  other_queue_present_or_blocked:
    'На другом диске уже есть очередь или незавершённая настройка. Автоматически второй набор не создаём.',
  queue_not_initialized: 'Очередь не создана или изменилась. Проверьте локальное состояние перед продолжением.',
  binding_not_installed: 'Привязка не подтверждена. Проверьте сохранённый ключ и очередь перед продолжением.',
  local_binding_changed: 'Доступ, ключ или очередь изменились. Повторите проверку после изучения локального состояния.',
  data_unprepared:
    'Сначала подготовьте локальные идентификаторы и сохраните данные. Если было выборочное применение, требуется согласование происхождения.',
  disk_changed_or_unsaved: 'Память и сохранённый файл не совпадают. Сначала сохраните данные и повторите проверку.',
  state_changed_or_unsaved: 'Данные изменились или не сохранены. Первый снимок не отправлен.',
  state_changed: 'Локальные данные изменились после просмотра. Действие остановлено; начните сравнение заново.',
  key_installed_state_changed:
    'Ключ сохранён, но данные изменились до подготовки снимка. Сохраните их и продолжите прерванную настройку.',
  backup_unconfirmed_restart:
    'Копия не подтверждена. Сохранение остановлено; проверьте данные и резервные копии перед перезапуском.',
  state_changed_after_backup_restart:
    'Данные изменились во время копирования. Проверьте несохранённые правки и копию перед перезапуском.',
  setup_uncertain:
    'Результат локальной операции не подтверждён. Не повторяйте её сейчас: проверьте данные, копии и состояние после перезапуска.',
  busy_or_restart_required: 'Другая операция выполняется или требуется проверка после перезапуска.',
  invalid_backup: 'Запасной ключ не совпал. Попробуйте ввести сохранённую копию ещё раз.',
  invalid_secret_or_file:
    'Не удалось открыть файл этим секретом. Проверьте код, выбранный диск и секрет; данные не изменены.',
  root_unavailable:
    'Корневая версия не найдена или диск недоступен. Старое облако могло находиться в другой папке или Client ID.',
  root_mismatch: 'Файл не совпадает с независимым кодом сверки. Ничего не изменено.',
  history_unverified: 'История не прошла проверку корня и известных версий. Данные не изменены.',
  cloud_changed: 'Облачный список изменился после просмотра или стал недоступен. Повторите сравнение.',
  prepared_snapshot_outdated:
    'Подготовленный первый снимок отличается от текущих данных. Его можно отправить только отдельно подтвердив, что это историческая основа.',
  provenance_review_required: 'После выборочного применения требуется согласование происхождения перед отправкой.',
  queue_changed: 'Очередь изменилась во время проверки. Отправка остановлена.',
  verification_pending:
    'Отправка могла выполниться, но чтение и сверка ещё не подтвердились. Повторный запрос создания не выполняется.',
  cloud_content_mismatch: 'Облачный файл не совпал с подготовленным. Не повторяйте отправку; требуется проверка.',
  already_confirmed: 'Первый снимок уже подтверждён. Последующие сохранения отправляются отдельным действием.',
  sent_verified: 'Первый зашифрованный снимок отправлен и сверен чтением. Новые сохранения отправляются отдельно.',
  sent_earlier_verified:
    'Более ранний первый снимок сверен чтением. Текущие изменения ещё не отправлены; подготовьте и отправьте их отдельно.',
  local_send_ready:
    'Местная привязка, очередь и сохранённый срок доступа проверены. API диска и права не проверялись; ничего не отправлено. Код: setup/local_send_ready.',
  probe_binding_unavailable:
    'Локальная проверка привязки не завершена. Ключи не изменены; ничего не отправлялось. Код: setup/probe_binding_unavailable.',
  probe_credential_read_unavailable:
    'Не удалось прочитать защищённую запись доступа. Ничего не отправлялось. Код: setup/probe_credential_read_unavailable.',
  probe_credential_record_invalid:
    'Защищённая запись доступа не прошла проверку формата. Не удаляйте её или привязку. Ничего не отправлялось. Код: setup/probe_credential_record_invalid.',
  probe_clock_unavailable:
    'Не удалось проверить срок доступа по системному времени. Ничего не отправлялось. Код: setup/probe_clock_unavailable.',
  deferred:
    'Транспорт не начал запись файла. Подготовленный снимок сохранён; перед повтором нужна проверка доступа. Код: setup/deferred.',
  account_mismatch:
    'Аккаунт диска не совпал с сохранённым. Не меняйте привязку и не повторяйте отправку. Код: setup/account_mismatch.',
  journal_blocked: 'Местная очередь не прошла проверку. Не удаляйте её. Код: setup/journal_blocked.',
  journal_uncertain: 'Запись местной очереди не подтверждена. Не повторяйте отправку. Код: setup/journal_uncertain.',
  busy: 'Другая операция с очередью ещё выполняется. Код: setup/busy.',
  changed: 'Очередь изменилась во время операции. Не повторяйте отправку. Код: setup/changed.',
  not_initialized:
    'Очередь выбранного диска не подготовлена. Не создавайте новую поверх прежней. Код: setup/not_initialized.',
  idle: 'В очереди нет ожидающего первого снимка. Это не подтверждает наличие файла на диске. Код: setup/idle.',
  unavailable:
    'Операция не завершена. Ничего не считайте отправленным или применённым; проверьте состояние и повторите проверку.'
});
function name(provider) {
  return provider === 'google' ? 'Google Диск' : 'Яндекс Диск';
}
function record(provider, action, status) {
  const outcome = [
    'prepared',
    'connected',
    'additional_connected',
    'access_verified',
    'sent_verified',
    'sent_earlier_verified',
    'already_confirmed'
  ].includes(status)
    ? 'success'
    : ['setup_uncertain', 'verification_pending', 'key_installed_state_changed'].includes(status)
      ? 'uncertain'
      : status === 'unavailable'
        ? 'unavailable'
        : 'blocked';
  try {
    recordCloudActivity(provider, action, outcome);
  } catch {
    /* журнал не влияет на действие */
  }
}

/**
 * @param {{doc?:Document,desktop:boolean,loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>}>,
 * prepareData?:()=>Promise<boolean>,makeSetup?:typeof createInitialCloudSetup,makeRecovery?:typeof createCloudRecovery,send?:typeof sendInitialCloudRoot,
 * readCode?:typeof readLocalCloudPairingCode,inspectSend?:typeof inspectInitialCloudSend,connectAdditional?:typeof connectAdditionalCloud,checkAccess?:typeof checkCloudAccess,confirm?:(message:string)=>boolean|Promise<boolean>,
 * reviewPanel?:{showExternalReview:(value:any,readOnly?:boolean)=>boolean,hasPreviewSelection:()=>boolean,clearExternalReview?:()=>void}}} options
 */
export function bindInitialCloudPanel(options) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-setup-title')?.closest('.cloud-setup');
  const provider = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-registration-provider'));
  const ids = [
    'main-kind',
    'main',
    'main-repeat',
    'backup-kind',
    'custom-label',
    'custom',
    'new-approve',
    'create',
    'resume',
    'confirm',
    'generated-label',
    'generated',
    'reveal',
    'backup-confirm',
    'saved',
    'confirm-button',
    'cancel',
    'show-code',
    'send-root',
    'inspect-send',
    'check-access',
    'connect-additional',
    'code-label',
    'code',
    'status'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, doc.getElementById(`cloud-setup-${id}`)]));
  const recoveryIds = [
    'code',
    'role',
    'secret-label',
    'secret',
    'approve',
    'reviewed-label',
    'reviewed',
    'check',
    'connect',
    'cancel'
  ];
  const recovery = Object.fromEntries(recoveryIds.map(id => [id, doc.getElementById(`cloud-recovery-${id}`)]));
  if (
    !panel ||
    !provider ||
    Object.values(elements).some(value => !value) ||
    Object.values(recovery).some(value => !value)
  )
    return;
  if (panel.getAttribute('data-cloud-setup-bound') === 'true') return;
  panel.setAttribute('data-cloud-setup-bound', 'true');
  const el = /** @type {Record<string,any>} */ (elements);
  const rec = /** @type {Record<string,any>} */ (recovery);
  const loadNative = options.loadNative || (async () => ({ invoke: (await import('@tauri-apps/api/core')).invoke }));
  const makeSetup = options.makeSetup || createInitialCloudSetup;
  const makeRecovery = options.makeRecovery || createCloudRecovery;
  const send = options.send || sendInitialCloudRoot;
  const readCode = options.readCode || readLocalCloudPairingCode;
  const askConfirmation =
    options.confirm ||
    (text => confirmModal({ title: 'Подтверждение синхронизации', text, okText: 'Продолжить', danger: true }));
  const settingBoxes = [...doc.querySelectorAll('[data-cloud-review-setting]')].map(
    box => /** @type {HTMLInputElement} */ (box)
  );
  const controls = [...panel.querySelectorAll('input,button,select,textarea')].map(
    control => /** @type {HTMLInputElement|HTMLButtonElement|HTMLSelectElement|HTMLTextAreaElement} */ (control)
  );
  let busy = false;
  let generation = 0;
  let attempt = null;
  let mode = null;
  let selected = null;
  let attemptGeneration = -1;
  const selections = () => settingBoxes.filter(box => box.checked).map(box => box.value);
  const selectedProvider = () => /** @type {'google'|'yandex'} */ (provider.value === 'google' ? 'google' : 'yandex');
  const note = value => {
    el.status.textContent = value;
  };
  function status(value) {
    return typeof value === 'string' && Object.hasOwn(MESSAGES, value) ? MESSAGES[value] : MESSAGES.unavailable;
  }
  function update() {
    for (const control of controls) control.disabled = !options.desktop || busy;
    if (!options.desktop || busy) return;
    const pending = !!attempt;
    for (const id of [
      'create',
      'resume',
      'show-code',
      'send-root',
      'inspect-send',
      'check-access',
      'connect-additional'
    ])
      el[id].disabled = pending;
    rec.check.disabled = pending;
    const dataCheck = doc.getElementById('cloud-setup-check-data');
    if (dataCheck) /** @type {HTMLButtonElement} */ (dataCheck).disabled = pending;
    el['confirm-button'].disabled = mode !== 'new';
    el.cancel.disabled = mode !== 'new';
    rec.connect.disabled = mode !== 'recovery';
    rec.cancel.disabled = mode !== 'recovery';
    el['custom-label'].hidden = el['backup-kind'].value !== 'custom';
    rec['secret-label'].hidden = rec.role.value === 'existing';
  }
  async function prepareLocalData(stage = _value => {}) {
    if (options.prepareData) return options.prepareData();
    stage('local_save');
    await saveNow();
    stage('identities');
    const staged = stageSyncIdentities();
    if (staged.status === 'already_assigned') return true;
    return staged.status === 'prepared' && (await staged.operation.commit({ confirmed: true })).status === 'applied';
  }
  function forgetSecrets() {
    for (const input of [el.main, el['main-repeat'], el.custom, el.generated, el['backup-confirm'], rec.secret])
      input.value = '';
    el.generated.type = 'password';
    el.reveal.textContent = 'Показать запасной ключ';
    el.saved.checked = false;
  }
  function clearAttempt(cancel = false) {
    if (cancel) attempt?.cancel?.();
    attempt = null;
    mode = null;
    selected = null;
    attemptGeneration = -1;
    el.confirm.hidden = true;
    el['generated-label'].hidden = true;
    el.reveal.hidden = true;
    rec.connect.hidden = true;
    rec.cancel.hidden = true;
    rec['reviewed-label'].hidden = true;
    rec.reviewed.checked = false;
    forgetSecrets();
  }
  function showCode(code) {
    el.code.value = code;
    el['code-label'].hidden = false;
  }
  async function withBusy(work) {
    if (busy || !options.desktop) return;
    busy = true;
    update();
    try {
      await work();
    } finally {
      busy = false;
      if (attempt && (generation !== attemptGeneration || selectedProvider() !== selected)) {
        clearAttempt(true);
        options.reviewPanel?.clearExternalReview?.();
        note('Выбор изменился. Незавершённое действие отменено; проверьте локальное состояние.');
      }
      update();
    }
  }
  function invalidate(event) {
    generation++;
    if (!busy && attempt) {
      clearAttempt(true);
      options.reviewPanel?.clearExternalReview?.();
      note('Выбор диска или настроек изменён. Предварительное действие отменено.');
    }
    el.code.value = '';
    el['code-label'].hidden = true;
    if (event.currentTarget === provider)
      note(
        `Выбран ${name(selectedProvider())}. У каждого диска своя привязка; переключение не подключает набор и не переносит его. Если действие уже началось на прежнем диске, его результат нужно проверить отдельно.`
      );
    update();
  }
  provider.addEventListener('change', invalidate);
  for (const box of settingBoxes) box.addEventListener('change', invalidate);
  el['backup-kind'].addEventListener('change', update);
  rec.role.addEventListener('change', update);
  el.reveal.addEventListener('click', () => {
    const visible = el.generated.type === 'text';
    el.generated.type = visible ? 'password' : 'text';
    el.reveal.textContent = visible ? 'Показать запасной ключ' : 'Скрыть запасной ключ';
  });
  el.cancel.addEventListener('click', () => {
    if (busy || mode !== 'new') return;
    clearAttempt(true);
    note('Подготовка отменена. Созданная локальная копия остаётся; ключ и облако не изменены.');
    update();
  });
  rec.cancel.addEventListener('click', () => {
    if (busy || mode !== 'recovery') return;
    clearAttempt(true);
    options.reviewPanel?.clearExternalReview?.();
    note('Восстановление отменено. Локальные данные и облако не изменены.');
    update();
  });
  for (const [currentId, otherId] of [
    ['cloud-setup-new', 'cloud-setup-existing'],
    ['cloud-setup-existing', 'cloud-setup-new']
  ]) {
    const current = /** @type {HTMLDetailsElement|null} */ (doc.getElementById(currentId));
    const other = /** @type {HTMLDetailsElement|null} */ (doc.getElementById(otherId));
    current?.addEventListener('toggle', () => {
      if (current.open && other) other.open = false;
    });
  }
  // Проверка не требует пароля/OAuth и не вызывает saveNow, commit или native.
  doc.getElementById('cloud-setup-check-data')?.addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        try {
          const checked = stageSyncIdentities();
          if (checked.status === 'prepared') checked.operation.cancel();
          note('Структура данных проверена. Ничего не сохранено и не отправлено; можно подготовить новый набор.');
        } catch (error) {
          note(
            `Проверка данных остановлена. Ничего не сохранено и не отправлено. Код: ${preparationDiagnosticCode(error)}.`
          );
        }
      })
  );
  el.create.addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt || !el['new-approve'].checked) {
          note('Подтвердите, что хотите создать именно новый независимый набор.');
          return;
        }
        if (!el.main.value || el.main.value !== el['main-repeat'].value) {
          note('Основной секрет и его повторение не совпадают.');
          return;
        }
        const thisGeneration = generation;
        const chosen = selectedProvider();
        const primary = { kind: el['main-kind'].value, secret: el.main.value };
        const backup =
          el['backup-kind'].value === 'custom' ? { kind: 'custom', secret: el.custom.value } : { kind: 'generated' };
        el.main.value = '';
        el['main-repeat'].value = '';
        el.custom.value = '';
        note('Создаём локальную копию и готовим ключи. Это может занять несколько секунд…');
        let preparationStage = 'data';
        try {
          const preparedData = await prepareLocalData(stage => {
            preparationStage = stage;
          });
          if (!preparedData || generation !== thisGeneration || selectedProvider() !== chosen) {
            note('Не удалось подтвердить сохранение данных и ID. Облако не изменялось; проверьте локальное состояние.');
            return;
          }
          preparationStage = 'native';
          const native = await loadNative();
          const setup = makeSetup({ provider: chosen, invoke: native.invoke, settingsSelections: selections() });
          preparationStage = 'keys';
          const prepared = await setup.begin({ primary, backup, newDatasetConfirmed: true });
          if (generation !== thisGeneration || selectedProvider() !== chosen) {
            prepared.cancel?.();
            note('Выбор изменился. Подготовка отменена; проверьте локальную копию.');
            return;
          }
          if (prepared.status !== 'prepared') {
            record(chosen, 'prepare', prepared.status);
            note(status(prepared.status));
            return;
          }
          attempt = prepared;
          mode = 'new';
          selected = chosen;
          attemptGeneration = thisGeneration;
          el.confirm.hidden = false;
          el.saved.checked = false;
          el['backup-confirm'].value = '';
          if (prepared.generatedBackupSecret) {
            el.generated.value = prepared.generatedBackupSecret;
            el['generated-label'].hidden = false;
            el.reveal.hidden = false;
          }
          note(
            'Ключи подготовлены в памяти. Сохраните и повторно введите запасной ключ; на диск ничего не отправлено.'
          );
        } catch (error) {
          // Только фиксированный этап. Исключения могут содержать пути и личные данные.
          const failure = {
            data: 'Не удалось подготовить местные данные. Облачная отправка не запускалась. Код: setup/data.',
            local_save:
              'Сохранение местных данных не подтверждено. Не удаляйте данные и не повторяйте операцию до проверки резервных копий. Код: setup/local_save.',
            identities: `Местные данные не прошли подготовку идентификаторов. Это не ошибка пароля или настроек Google. Не удаляйте записи; сообщите этот код. Код: ${preparationDiagnosticCode(error)}.`,
            native:
              'Не удалось открыть локальный механизм настройки. Проверьте, что запущена новая Windows-сборка. Код: setup/native.',
            keys: 'Подготовка ключей не завершилась. Проверьте локальное состояние; данные не считайте отправленными. Код: setup/keys.'
          };
          note(failure[preparationStage]);
        }
      })
  );
  el['confirm-button'].addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (!attempt || mode !== 'new' || !el.saved.checked) {
          note('Подтвердите, что отдельно сохранили запасной ключ.');
          return;
        }
        const current = attempt;
        const chosen = selected;
        const thisGeneration = generation;
        const secret = el['backup-confirm'].value;
        el['backup-confirm'].value = '';
        note('Проверяем запасной ключ и сохраняем локальную привязку…');
        try {
          const result = await current.confirmBackup({ secret, savedSeparately: true });
          record(chosen, 'prepare', result.status);
          if (result.status === 'invalid_backup' || result.status === 'confirmation_required') {
            note(status(result.status));
            return;
          }
          clearAttempt();
          if (result.status === 'prepared') doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-binding-changed'));
          if (result.status === 'prepared' && generation === thisGeneration && selectedProvider() === chosen) {
            showCode(result.pairingCode);
            note(
              `Локальный набор подготовлен для ${name(chosen)}. Копия: ${result.backup}. Ничего не отправлено; сохраните код сверки отдельно.`
            );
          } else if (result.status === 'prepared') {
            note('Набор подготовлен на прежнем диске. Выберите его снова, чтобы показать код сверки.');
          } else note(status(result.status));
        } catch {
          record(chosen, 'prepare', 'setup_uncertain');
          clearAttempt();
          note(status('setup_uncertain'));
        }
      })
  );
  el.resume.addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        const chosen = selectedProvider();
        const thisGeneration = generation;
        if (
          !(await askConfirmation(
            'Продолжить прерванную настройку выбранного диска? Подтвердите, что запасной ключ уже сохранён отдельно. Старое облако не ищется и не удаляется.'
          ))
        )
          return;
        if (generation !== thisGeneration || selectedProvider() !== chosen) return;
        note('Проверяем ключ, локальную копию и незавершённую очередь…');
        try {
          const native = await loadNative();
          const outcome = await makeSetup({
            provider: chosen,
            invoke: native.invoke,
            settingsSelections: selections()
          }).resume({ resumeConfirmed: true, backupKeySaved: true });
          record(chosen, 'prepare', outcome.status);
          if (outcome.status === 'prepared')
            doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-binding-changed'));
          if (outcome.status === 'prepared' && generation === thisGeneration && selectedProvider() === chosen) {
            showCode(outcome.pairingCode);
            note(`Локальная настройка продолжена. Копия: ${outcome.backup}. На диск ничего не отправлено.`);
          } else note(status(outcome.status));
        } catch {
          record(chosen, 'prepare', 'setup_uncertain');
          note(status('setup_uncertain'));
        }
      })
  );
  el['show-code'].addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        const chosen = selectedProvider();
        const thisGeneration = generation;
        el.code.value = '';
        el['code-label'].hidden = true;
        try {
          const native = await loadNative();
          const outcome = /** @type {any} */ (await readCode({ provider: chosen, invoke: native.invoke }));
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          if (outcome.status === 'ready' && generation === thisGeneration && selectedProvider() === chosen) {
            showCode(outcome.pairingCode);
            note(`Код сверки показан для ${name(chosen)}. Передавайте его независимо от облачного файла.`);
          } else note(`${name(chosen)}: ${status(outcome.status)}`);
        } catch {
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          note(`${name(chosen)}: ${status('unavailable')}`);
        }
      })
  );
  el['connect-additional'].addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        const chosen = selectedProvider(),
          thisGeneration = generation;
        if (
          !(await askConfirmation(
            `Подключить существующий набор с другого диска к ${name(chosen)}? Сохраним местные данные и резервную копию, используем прежний пароль, запасной ключ и тот же зашифрованный корень. Первый диск не отключается. Файлы сейчас не отправляются; оба диска проверяются и отправляются отдельно, разные версии автоматически не объединяются.`
          ))
        )
          return;
        if (generation !== thisGeneration || selectedProvider() !== chosen) return;
        note('Проверяем существующий ключ и подключаем тот же набор ко второму диску…');
        try {
          if (!(await prepareLocalData()) || generation !== thisGeneration || selectedProvider() !== chosen) {
            note(status('state_changed_or_unsaved'));
            return;
          }
          const native = await loadNative();
          const outcome = /** @type {any} */ (
            await (options.connectAdditional || connectAdditionalCloud)({
              provider: chosen,
              invoke: native.invoke,
              confirmed: true,
              settingsSelections: selections()
            })
          );
          record(chosen, 'additional', outcome.status);
          if (outcome.status === 'additional_connected')
            doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-binding-changed'));
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          if (outcome.pairingCode) showCode(outcome.pairingCode);
          note(`${name(chosen)}: ${status(outcome.status)}${outcome.backup ? ` Копия: ${outcome.backup}.` : ''}`);
        } catch {
          record(chosen, 'additional', 'setup_uncertain');
          if (generation === thisGeneration && selectedProvider() === chosen) note(status('setup_uncertain'));
        }
      })
  );
  el['check-access'].addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        const chosen = selectedProvider(),
          thisGeneration = generation;
        note(`${name(chosen)}: проверяем аккаунт и чтение API, без отправки файлов…`);
        try {
          const native = await loadNative();
          const outcome = await (options.checkAccess || checkCloudAccess)({ provider: chosen, invoke: native.invoke });
          record(chosen, 'access', outcome.status);
          if (generation === thisGeneration && selectedProvider() === chosen)
            note(`${name(chosen)}: ${status(outcome.status)}`);
        } catch {
          if (generation === thisGeneration && selectedProvider() === chosen) note(status('unavailable'));
        }
      })
  );
  el['inspect-send'].addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        const chosen = selectedProvider();
        const thisGeneration = generation;
        note(`${name(chosen)}: проверяем только местную готовность, без сети и отправки…`);
        try {
          const native = await loadNative();
          const outcome = await (options.inspectSend || inspectInitialCloudSend)({
            provider: chosen,
            invoke: native.invoke
          });
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          note(`${name(chosen)}: ${status(outcome.status)}`);
        } catch {
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          note(`${name(chosen)}: ${status('probe_binding_unavailable')}`);
        }
      })
  );
  el['send-root'].addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt) return;
        const chosen = selectedProvider();
        const thisGeneration = generation;
        if (
          !(await askConfirmation(
            `Отправить первый зашифрованный снимок на ${name(chosen)}? Это экспериментальная функция: последующие изменения отправляются отдельно, а после выборочного применения и при конфликтах отправка блокируется. Старое облако не удаляется.`
          ))
        )
          return;
        if (generation !== thisGeneration || selectedProvider() !== chosen) return;
        note('Отправляем подготовленный снимок и проверяем его чтением…');
        try {
          const native = await loadNative();
          let outcome = await send({
            provider: chosen,
            invoke: native.invoke,
            confirmed: true,
            settingsSelections: selections()
          });
          if (outcome.status === 'prepared_snapshot_outdated') {
            if (generation !== thisGeneration || selectedProvider() !== chosen) return;
            note(status(outcome.status));
            const approved = await askConfirmation(
              'Первый подготовленный снимок отличается от текущих сохранённых данных. Отправить его как более раннюю основу? Текущие изменения при этом не будут отправлены. Их потребуется отправить отдельно; при удалениях или конфликтах отправка остановится.'
            );
            if (!approved || generation !== thisGeneration || selectedProvider() !== chosen) return;
            outcome = await send({
              provider: chosen,
              invoke: native.invoke,
              confirmed: true,
              allowEarlierSnapshot: true,
              settingsSelections: selections()
            });
          }
          record(chosen, 'send', outcome.status);
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          note(`${name(chosen)}: ${status(outcome.status)}`);
          if (['sent_verified', 'sent_earlier_verified', 'already_confirmed'].includes(outcome.status))
            doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-root-confirmed'));
        } catch {
          record(chosen, 'send', 'verification_pending');
          if (generation !== thisGeneration || selectedProvider() !== chosen) return;
          note(`${name(chosen)}: ${status('verification_pending')}`);
        }
      })
  );
  rec.check.addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (attempt || !rec.approve.checked || !rec.code.value) {
          note('Введите код и подтвердите его независимый доверенный источник.');
          return;
        }
        const chosen = selectedProvider();
        const thisGeneration = generation;
        const secret = rec.secret.value;
        rec.secret.value = '';
        note('Проверяем независимый код, диск и создаём локальную копию…');
        try {
          const native = await loadNative();
          const recovery = makeRecovery({ provider: chosen, invoke: native.invoke, settingsSelections: selections() });
          const prepared = await recovery.begin({
            pairingCode: rec.code.value,
            independentPinConfirmed: true,
            role: rec.role.value,
            secret
          });
          if (generation !== thisGeneration || selectedProvider() !== chosen) {
            prepared.cancel?.();
            note('Выбор изменился. Восстановление отменено; данные не применялись.');
            return;
          }
          if (prepared.status !== 'ready_for_confirmation') {
            record(chosen, 'recover', prepared.status);
            note(status(prepared.status));
            return;
          }
          attempt = prepared;
          mode = 'recovery';
          selected = chosen;
          attemptGeneration = thisGeneration;
          rec.connect.hidden = false;
          rec.cancel.hidden = false;
          rec['reviewed-label'].hidden = false;
          rec.reviewed.checked = false;
          const shown = options.reviewPanel?.showExternalReview(prepared.review, true);
          note(
            shown
              ? `Предварительное сравнение готово ниже. Копия: ${prepared.backup}. Изучите версии и различия, затем подтвердите подключение.`
              : `История проверена. Копия: ${prepared.backup}. Подтвердите подключение, затем проверьте различия в блоке ниже.`
          );
        } catch {
          note(status('unavailable'));
        }
      })
  );
  rec.connect.addEventListener(
    'click',
    () =>
      void withBusy(async () => {
        if (!attempt || mode !== 'recovery') return;
        if (!rec.reviewed.checked || !options.reviewPanel?.hasPreviewSelection()) {
          note(
            'Сначала выберите версию в предварительном сравнении ниже и подтвердите, что изучили различия. Если сравнение закрыто, отмените восстановление и начните его заново.'
          );
          return;
        }
        const current = attempt;
        const chosen = selected;
        const thisGeneration = generation;
        if (
          !(await askConfirmation(
            'Подключить проверенный набор? Локальные данные не будут изменены. После подключения выберите версии и записи в сравнении; применение создаст отдельную копию.'
          ))
        )
          return;
        if (generation !== thisGeneration || selectedProvider() !== chosen) {
          clearAttempt(true);
          options.reviewPanel?.clearExternalReview?.();
          note('Выбор изменился. Подключение отменено.');
          return;
        }
        note('Повторно проверяем облако и закрепляем локальную привязку…');
        try {
          const outcome = await current.connect({ confirmed: true });
          record(chosen, 'recover', outcome.status);
          clearAttempt();
          if (outcome.status === 'connected')
            doc.defaultView?.dispatchEvent(new CustomEvent('tf-cloud-binding-changed'));
          if (outcome.status === 'connected' && generation === thisGeneration && selectedProvider() === chosen) {
            options.reviewPanel?.showExternalReview(outcome.review, false);
            note(
              `Подключение восстановлено. Копия: ${outcome.backup}. Выберите изменения в сравнении ниже; они ещё не применены.`
            );
          } else {
            options.reviewPanel?.clearExternalReview?.();
            note(status(outcome.status));
          }
        } catch {
          record(chosen, 'recover', 'setup_uncertain');
          clearAttempt();
          options.reviewPanel?.clearExternalReview?.();
          note(status('setup_uncertain'));
        }
      })
  );
  doc.defaultView?.addEventListener('pagehide', () => {
    if (!busy) clearAttempt(true);
    forgetSecrets();
  });
  update();
  if (!options.desktop)
    note('Первичная настройка доступна только в настольном приложении; в браузере диск не подключается.');
}
