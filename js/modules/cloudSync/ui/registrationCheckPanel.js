// @ts-check
import { googleClientImportProblem, GOOGLE_IMPORT_MESSAGES } from '../providers/googleClientImport.js';
// Разовая диагностика и экспериментальное сохранение OAuth-доступа, без передачи
// файлов и без работающей синхронизации. В форму вводится только публичный Client ID.
// Токены, исходные ошибки, метки и идентификаторы аккаунта не журналируются.
import { describeOAuthFailure } from '../providers/oauthDiagnostics.js';
import { validOAuthClientId } from '../providers/oauthCommon.js';
import { checkCloudOAuthRegistration } from '../providers/oauthRegistrationCheck.js';
import { enrollNativeCloudAccount } from '../providers/nativeOAuthEnrollment.js';
import { forgetUnboundNativeCredential, readNativeCredentialBinding } from '../providers/nativeCredentialStore.js';
import { createNativeDatasetBindingStore } from '../providers/nativeDatasetBindingStore.js';
import { createCloudAccountConfirmation } from './confirmCloudAccount.js';
import { beginCloudCredentialOperation } from '../credentialResetCoordination.js';

const LOCAL_MESSAGES = Object.freeze({
  empty: 'Локальная запись доступа не найдена. Это не доказывает, что старого подключения или облачных данных не было.',
  ready: 'Доступ сохранён на этом ПК. Его действительность и права, облачные файлы и синхронизация не проверялись.',
  ready_bound:
    'Доступ сохранён, но есть существующая или неполная привязка набора. Локальное удаление заблокировано; облачные файлы и действительность доступа не проверялись.',
  dataset_incomplete:
    'Есть неполная привязка набора. Локальное удаление заблокировано; требуется восстановление, а не создание нового набора.',
  dataset_blocked:
    'Есть существующая или неполная привязка набора без доступной учётной записи. Новый вход заблокирован до восстановления; не удаляйте привязку.',
  pending:
    'Предыдущая операция с доступом не подтверждена. Не удаляйте запись и не повторяйте вход до проверки и восстановления.',
  blocked:
    'Локальная запись доступа неполная или не совпадает с привязкой. Не удаляйте её и не повторяйте вход до восстановления.'
});
const ENROLL_MESSAGES = Object.freeze({
  installed:
    'Доступ сохранён на этом ПК после сверки аккаунта. Облачные файлы не изменялись. Теперь можно сохранить полный файл или проверить файлы другого ПК.',
  installed_access_expired:
    'Доступ сохранён, но срок токена уже истёк. Синхронизация не работает; требуется восстановить авторизацию. Ключи и облачные файлы не удаляйте.',
  installed_refresh_expired:
    'Доступ сохранён, но срок refresh-токена уже истёк. Синхронизация не работает; требуется восстановить авторизацию. Ключи и облачные файлы не удаляйте.',
  already_configured:
    'На этом ПК уже есть запись доступа. Она не заменялась; действительность и облачные файлы не проверялись.',
  local_blocked: 'Локальная запись недоступна или неполная. Ничего не заменялось; требуется восстановление.',
  denied: 'Вход отклонён в браузере. Доступ в приложении не сохранён; сервис мог сохранить разрешение.',
  expired: 'Время ожидания входа истекло. Доступ в приложении не сохранён; сервис мог сохранить разрешение.',
  cancelled: 'Ожидание входа отменено. Сервис мог сохранить разрешение.',
  declined: 'Аккаунт не подтверждён. Доступ в приложении не сохранён; сервис мог сохранить разрешение.',
  scope_unverified: 'Выданные права не удалось подтвердить. Доступ в приложении не сохранён.',
  refresh_missing: 'Google не выдал refresh-токен. Доступ в приложении не сохранён.',
  token_unavailable: 'Не удалось безопасно использовать ответ сервиса. Доступ в приложении не сохранён.',
  identity_unverified: 'Не удалось проверить аккаунт у сервиса. Доступ в приложении не сохранён.',
  account_label_unavailable: 'Сервис не сообщил метку аккаунта для сверки. Доступ в приложении не сохранён.',
  account_changed: 'Аккаунт не совпадает с сохранённым или изменился во время сверки. Доступ не заменён.',
  confirmation_unverified: 'Подтверждение аккаунта не получено. Доступ в приложении не сохранён.',
  failed: 'Не удалось выполнить вход. Проверьте регистрацию, разрешения и Redirect URI; файлы не изменялись.'
});

/**
 * @param {{doc?:Document, desktop:boolean,
 * loadNative?:()=>Promise<{invoke:(command:string,args:any)=>Promise<any>,openBrowser:(url:string)=>Promise<any>}>,
 * check?:typeof checkCloudOAuthRegistration, enroll?:typeof enrollNativeCloudAccount,
 * readBinding?:typeof readNativeCredentialBinding, readDataset?:(args:{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>})=>Promise<string>,
 * forget?:typeof forgetUnboundNativeCredential,
 * confirmAccount?:ReturnType<typeof createCloudAccountConfirmation>}} options
 */
export function bindCloudRegistrationCheck(options) {
  const doc = options.doc || document;
  const panel = /** @type {HTMLDetailsElement|null} */ (doc.getElementById('cloud-registration-panel'));
  const form = /** @type {HTMLFormElement|null} */ (doc.getElementById('cloud-registration-form'));
  const provider = /** @type {HTMLSelectElement|null} */ (doc.getElementById('cloud-login-provider'));
  const client = /** @type {HTMLInputElement|null} */ (doc.getElementById('cloud-registration-client'));
  const start = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-registration-start'));
  const cancelButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-registration-cancel'));
  const status = doc.getElementById('cloud-registration-status');
  const simple = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-connection-simple'));
  const simpleCancel = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-connection-simple-cancel'));
  const configFile = /** @type {HTMLInputElement|null} */ (doc.getElementById('cloud-google-import'));
  const configStatus = doc.getElementById('cloud-google-config-status');
  const advanced = /** @type {HTMLDetailsElement|null} */ (doc.getElementById('cloud-registration-advanced'));
  const account = doc.getElementById('cloud-registration-account');
  const accountLabel = doc.getElementById('cloud-registration-account-label');
  const accountValue = doc.getElementById('cloud-registration-account-value');
  const yandexHint = doc.getElementById('cloud-registration-yandex-hint');
  const googleHint = doc.getElementById('cloud-registration-google-hint');
  const localStatus = doc.getElementById('cloud-connection-local');
  const progress = doc.getElementById('cloud-connection-progress');
  const inspectButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-connection-inspect'));
  const approve = /** @type {HTMLInputElement|null} */ (doc.getElementById('cloud-connection-approve'));
  const enrollButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-connection-start'));
  const enrollCancel = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-connection-cancel'));
  const forgetApprove = /** @type {HTMLInputElement|null} */ (doc.getElementById('cloud-connection-forget-approve'));
  const forgetButton = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-connection-forget'));
  if (
    !yandexHint ||
    !googleHint ||
    !panel ||
    !form ||
    !provider ||
    !client ||
    !start ||
    !cancelButton ||
    !status ||
    !account ||
    !accountLabel ||
    !accountValue ||
    !localStatus ||
    !progress
  )
    return;
  if (form.dataset.cloudCheckBound === 'true') return;
  form.dataset.cloudCheckBound = 'true';
  const check = options.check || checkCloudOAuthRegistration;
  const enroll = options.enroll || enrollNativeCloudAccount;
  const readBinding = options.readBinding || readNativeCredentialBinding;
  const readDataset =
    options.readDataset || (async args => (await createNativeDatasetBindingStore(args).read()).status);
  const forget = options.forget || forgetUnboundNativeCredential;
  const confirmAccount = options.confirmAccount || createCloudAccountConfirmation();
  const loadNative =
    options.loadNative ||
    (async () => {
      const [{ invoke }, { open }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-shell')
      ]);
      return { invoke, openBrowser: open };
    });
  /** @type {null | {controller:AbortController, mode:'check'|'inspect'|'enroll'|'forget'|'config', selected:'google'|'yandex', installing:boolean}} */
  let active = null;
  /** @type {null | {provider:'google'|'yandex', status:string, slotId?:string}} */
  let observed = null;
  // Только в этом JS-контексте: timeout не отменяет уже начатый native IPC.
  // После неопределённости не разрешаем повтор, даже если позднее показалось пусто.
  const uncertain = new Set();
  let resetStarted = false;

  function selectedProvider() {
    return /** @type {'google'|'yandex'} */ (provider.value);
  }
  function clearAccount() {
    account.hidden = true;
    accountLabel.textContent = '';
    accountValue.textContent = '';
  }
  function setBusy() {
    const busy = !!active || resetStarted;
    const selected = selectedProvider();
    const known = observed?.provider === selected ? observed : null;
    const stopped = uncertain.has(selected);
    if (simple) {
      simple.disabled = busy || !options.desktop || stopped;
      const canReconnect =
        selected === 'google' &&
        ['ready', 'ready_bound', 'pending', 'dataset_incomplete'].includes(known?.status || '');
      simple.hidden = !canReconnect && ['ready', 'ready_bound'].includes(known?.status || '');
      simple.textContent = canReconnect ? 'Повторить вход Google' : 'Войти';
    }
    if (simpleCancel) {
      simpleCancel.hidden = !['enroll', 'inspect'].includes(active?.mode || '');
      simpleCancel.disabled = !active || active.controller.signal.aborted;
    }
    if (configFile) configFile.disabled = busy || !options.desktop;
    provider.disabled = busy;
    client.disabled = busy;
    start.disabled = busy || !options.desktop;
    cancelButton.hidden = active?.mode !== 'check';
    cancelButton.disabled = active?.mode !== 'check' || active.controller.signal.aborted;
    if (inspectButton) inspectButton.disabled = busy || !options.desktop;
    if (approve) approve.disabled = busy || !options.desktop || stopped || known?.status !== 'empty';
    if (enrollButton)
      enrollButton.disabled = busy || !options.desktop || stopped || known?.status !== 'empty' || !approve?.checked;
    if (enrollCancel) enrollCancel.hidden = active?.mode !== 'enroll';
    if (enrollCancel) enrollCancel.disabled = active?.mode !== 'enroll' || active.controller.signal.aborted;
    if (forgetApprove) forgetApprove.disabled = busy || !options.desktop || stopped || known?.status !== 'ready';
    if (forgetButton)
      forgetButton.disabled =
        busy || !options.desktop || stopped || known?.status !== 'ready' || !forgetApprove?.checked;
  }
  function stop() {
    if (!active || active.controller.signal.aborted) return;
    if (active.mode === 'forget') {
      progress.textContent = 'Удаление уже началось и не отменяется закрытием панели. Дождитесь результата.';
      return;
    }
    active.controller.abort();
    clearAccount();
    if (active.mode === 'check') {
      status.textContent =
        'Ожидание отменено. Если запрос уже отправлен, сервис мог сохранить разрешение. Его отзыв в настройках аккаунта может отключить другие устройства этой регистрации.';
    } else if (active.mode === 'enroll') {
      progress.textContent = active.installing
        ? 'Запись доступа уже началась и может завершиться после отмены. Дождитесь результата и не повторяйте вход.'
        : 'Ожидание входа отменено. Если запрос уже отправлен, сервис мог сохранить разрешение.';
    } else {
      localStatus.textContent = 'Локальная запись не проверена.';
    }
    setBusy();
  }
  function initialStatus() {
    return options.desktop
      ? 'Регистрация ещё не проверялась.'
      : 'Проверка доступна только в настольном приложении. В браузерном примере подключения и передачи данных нет.';
  }
  function updateProviderHint() {
    yandexHint.hidden = provider.value !== 'yandex';
    googleHint.hidden = provider.value !== 'google';
    const label = doc.getElementById('cloud-google-import-label');
    if (label) label.hidden = provider.value !== 'google';
    if (configStatus) configStatus.hidden = provider.value !== 'google';
  }
  function uncertainOutcome(selected) {
    uncertain.add(selected);
    observed = null;
    if (approve) approve.checked = false;
    if (forgetApprove) forgetApprove.checked = false;
    localStatus.textContent =
      'Результат операции с локальной записью неизвестен. Не повторяйте вход или удаление; сначала проверьте состояние и завершение операции.';
    progress.textContent =
      'Результат записи или удаления не подтверждён. Операция могла завершиться после таймаута; автоматического повтора нет.';
  }
  async function inspect() {
    if (!options.desktop || active || resetStarted) return;
    const selected = selectedProvider();
    const session = {
      controller: new AbortController(),
      mode: /** @type {'inspect'} */ ('inspect'),
      selected,
      installing: false
    };
    active = session;
    observed = null;
    if (approve) approve.checked = false;
    if (forgetApprove) forgetApprove.checked = false;
    localStatus.textContent = 'Проверяем только локальную запись…';
    setBusy();
    try {
      const native = await loadNative();
      if (session.controller.signal.aborted) return;
      const reply = await readBinding({ provider: selected, invoke: native.invoke });
      if (session.controller.signal.aborted) return;
      if (!['empty', 'ready', 'pending', 'blocked'].includes(reply.status)) throw new Error();
      if (reply.status === 'ready' && reply.binding?.clientId) client.value = reply.binding.clientId;
      if (reply.status === 'empty' || (selected === 'google' && ['pending', 'ready'].includes(reply.status))) {
        if (selected === 'google') {
          try {
            const config = await native.invoke('cloud_google_client_read', {});
            if (session.controller.signal.aborted) return;
            if (config?.status === 'ready' && validOAuthClientId('google', config.clientId)) {
              client.value = config.clientId;
              if (configStatus) configStatus.textContent = 'Google настроен. Можно входить.';
            } else {
              client.value = '';
              if (configStatus)
                configStatus.textContent =
                  'Для этой сборки один раз импортируйте Desktop JSON в разделе настройки приложения.';
            }
          } catch {
            client.value = '';
            if (configStatus)
              configStatus.textContent =
                'Не удалось прочитать настройки Google. Откройте разовую настройку и импортируйте Desktop JSON; не удаляйте записи Windows вручную.';
          }
        } else if (!client.value.trim())
          client.value =
            /** @type {ImportMeta & {env?:{VITE_YANDEX_CLIENT_ID?:string}}} */ (import.meta).env
              ?.VITE_YANDEX_CLIENT_ID || '';
      }
      let displayStatus = reply.status;
      if (reply.status === 'ready' || reply.status === 'empty') {
        const datasetStatus = await readDataset({ provider: selected, invoke: native.invoke });
        if (session.controller.signal.aborted) return;
        if (!['empty', 'ready', 'blocked'].includes(datasetStatus)) throw new Error();
        if (datasetStatus !== 'empty')
          displayStatus =
            reply.status !== 'ready'
              ? 'dataset_blocked'
              : datasetStatus === 'ready'
                ? 'ready_bound'
                : 'dataset_incomplete';
      }
      observed = {
        provider: selected,
        status: displayStatus,
        ...(displayStatus === 'ready' && reply.binding ? { slotId: reply.binding.slotId } : {})
      };
      if (displayStatus === 'ready' && !observed.slotId) throw new Error();
      if (['ready', 'ready_bound'].includes(displayStatus))
        doc.defaultView?.dispatchEvent(
          new CustomEvent('tf-cloud-credential-ready', { detail: { provider: selected } })
        );
      localStatus.textContent =
        selected === 'google' && displayStatus === 'pending'
          ? 'Обновление доступа Google не подтверждено. Нажмите «Повторить вход Google» и войдите в прежний аккаунт. Ключи и ожидающий файл сохраняются.'
          : LOCAL_MESSAGES[displayStatus];
      if (uncertain.has(selected))
        localStatus.textContent += ' Исход предыдущей операции всё ещё неизвестен; повтор в этом окне заблокирован.';
    } catch {
      if (!session.controller.signal.aborted) {
        observed = null;
        localStatus.textContent =
          'Не удалось проверить локальную запись. Это не означает, что она отсутствует. Доступное хранилище поддерживается только в Windows.';
      }
    } finally {
      if (active === session) {
        active = null;
        setBusy();
      }
    }
  }
  function clientForAction(target) {
    const selected = selectedProvider();
    const clientId = client.value.trim();
    if (!validOAuthClientId(selected, clientId)) {
      target.textContent =
        'Проверьте формат Client ID для выбранного диска. Пароль, секрет приложения и код сюда вводить нельзя.';
      if (advanced) advanced.open = true;
      if (selected === 'google') {
        target.textContent =
          'Google ещё не настроен: один раз выберите Desktop JSON ниже. Секрет вручную вводить не нужно.';
        configFile?.focus();
      } else client.focus();
      return null;
    }
    return { selected, clientId };
  }
  status.textContent = initialStatus();
  if (!options.desktop) {
    localStatus.textContent = 'Локальное хранилище доступа доступно только в настольном приложении Windows.';
    progress.textContent = 'В браузерном примере подключение не выполняется.';
  }
  updateProviderHint();
  setBusy();

  provider.addEventListener('change', () => {
    clearAccount();
    if (!validOAuthClientId(selectedProvider(), client.value.trim())) client.value = '';
    updateProviderHint();
    status.textContent = initialStatus();
    observed = null;
    if (approve) approve.checked = false;
    if (forgetApprove) forgetApprove.checked = false;
    localStatus.textContent = options.desktop ? 'Локальная запись не проверена.' : 'Доступно только в Windows.';
    progress.textContent = options.desktop ? 'Ожидание действия.' : 'В браузерном примере подключение не выполняется.';
    setBusy();
    if (panel.open) void inspect();
  });
  client.addEventListener('input', () => {
    clearAccount();
    if (!active) status.textContent = initialStatus();
  });
  panel.addEventListener('toggle', () => {
    if (!panel.open) {
      stop();
      clearAccount();
    } else if (!active) void inspect();
  });
  doc.defaultView?.addEventListener('tf-factory-reset-started', () => {
    resetStarted = true;
    stop();
    progress.textContent = 'Начался сброс локальных данных. Облачный доступ в этом окне недоступен до перезапуска.';
    setBusy();
  });
  cancelButton.addEventListener('click', stop);
  enrollCancel?.addEventListener('click', stop);
  inspectButton?.addEventListener('click', () => void inspect());
  approve?.addEventListener('change', setBusy);
  forgetApprove?.addEventListener('change', setBusy);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!options.desktop || active || resetStarted) return;
    clearAccount();
    const input = clientForAction(status);
    if (!input) return;
    const { selected, clientId } = input;
    const session = {
      controller: new AbortController(),
      mode: /** @type {'check'} */ ('check'),
      selected,
      installing: false
    };
    active = session;
    setBusy();
    status.textContent = 'Подготавливаем проверку…';
    try {
      const native = await loadNative();
      if (session.controller.signal.aborted) return;
      const result = await check({
        provider: selected,
        clientId,
        invoke: native.invoke,
        openBrowser: native.openBrowser,
        signal: session.controller.signal,
        onProgress(stage) {
          if (session.controller.signal.aborted) return;
          if (stage === 'browser')
            status.textContent = 'Откройте страницу в системном браузере и подтвердите или отмените запрос.';
          else if (stage === 'token') status.textContent = 'Проверяем ответ авторизации…';
          else if (stage === 'identity') status.textContent = 'Проверяем, какой аккаунт выбрал сервис…';
        }
      });
      if (session.controller.signal.aborted) return;
      if (result.status === 'checked') {
        status.textContent =
          result.scope === 'unverified'
            ? 'Сервис ответил, но запрошенные права не удалось подтвердить. Доступ к файлам не проверялся; эта проверка не сохраняет доступ.'
            : 'Сервис ответил на проверку. Доступ к файлам не проверялся; эта проверка не сохраняет и не изменяет доступ.';
        if (result.label) {
          accountLabel.textContent = selected === 'google' ? 'Адрес аккаунта Google' : 'Логин аккаунта Яндекса';
          accountValue.textContent = result.label.value;
          account.hidden = false;
        } else {
          status.textContent += ' Сервис не сообщил отображаемую метку аккаунта.';
        }
      } else if (result.status === 'denied') {
        status.textContent = 'Доступ отклонён в браузере. Эта проверка не сохраняет доступ.';
      } else if (result.status === 'expired') {
        status.textContent = 'Время ожидания авторизации истекло. Эта проверка не сохраняет доступ.';
      } else if (result.status === 'cancelled') {
        status.textContent = 'Проверка отменена. Сервис мог сохранить разрешение; эта проверка не сохраняет доступ.';
      } else {
        status.textContent =
          describeOAuthFailure(result.diagnostic) ||
          'Не удалось проверить регистрацию. Проверьте Client ID, разрешения приложения и Redirect URI; также возможно, что сервис требует дополнительные параметры.';
      }
    } catch {
      if (!session.controller.signal.aborted)
        status.textContent = 'Не удалось запустить проверку. Эта проверка не сохраняет доступ и не передаёт файлы.';
    } finally {
      if (active === session) {
        active = null;
        setBusy();
      }
    }
  });

  async function startEnrollment(quick = false, reconnect = false) {
    if (!options.desktop || active || resetStarted || uncertain.has(selectedProvider())) return;
    if (!quick && enrollButton?.disabled) return;
    const input = clientForAction(progress);
    if (
      !input ||
      observed?.provider !== input.selected ||
      (!reconnect && observed.status !== 'empty') ||
      (!quick && !approve?.checked)
    )
      return;
    const { selected, clientId } = input;
    let operation;
    try {
      operation = beginCloudCredentialOperation();
    } catch {
      progress.textContent = 'Подключение остановлено: выполняется сброс локальных данных.';
      return;
    }
    const session = {
      controller: new AbortController(),
      mode: /** @type {'enroll'} */ ('enroll'),
      selected,
      installing: false
    };
    active = session;
    if (approve) approve.checked = false;
    clearAccount();
    setBusy();
    progress.textContent = 'Подготавливаем вход и проверяем локальную запись…';
    let inspectAfter = false;
    try {
      const native = await loadNative();
      if (session.controller.signal.aborted) return;
      const result = await enroll({
        provider: selected,
        clientId,
        invoke: native.invoke,
        openBrowser: native.openBrowser,
        signal: session.controller.signal,
        firstConnectionConfirmed: true,
        ...(reconnect ? { reconnect: true } : {}),
        confirmAccount,
        onProgress(stage) {
          if (stage === 'installing') session.installing = true;
          if (session.controller.signal.aborted) return;
          if (stage === 'checking_local')
            progress.textContent = reconnect
              ? 'Проверяем сохранённую привязку аккаунта…'
              : 'Проверяем, что локальная запись не занята…';
          else if (stage === 'browser') progress.textContent = 'Войдите в выбранный аккаунт в системном браузере.';
          else if (stage === 'token') progress.textContent = 'Проверяем ответ авторизации…';
          else if (stage === 'identity') progress.textContent = 'Проверяем аккаунт у сервиса…';
          else if (stage === 'confirming') progress.textContent = 'Сверьте аккаунт в отдельном окне подтверждения.';
          else if (stage === 'installing') progress.textContent = 'Сохраняем доступ; начатую запись нельзя отменить.';
        }
      });
      if (
        result.status === 'installation_uncertain' ||
        (session.installing &&
          !['installed', 'installed_access_expired', 'installed_refresh_expired', 'already_configured'].includes(
            result.status
          ))
      ) {
        uncertainOutcome(selected);
        return;
      }
      // После начала записи показываем настоящий результат даже при отмене.
      if (session.controller.signal.aborted && !session.installing) return;
      progress.textContent =
        (result.status === 'failed' && describeOAuthFailure(result.diagnostic)) ||
        (Object.hasOwn(ENROLL_MESSAGES, result.status) ? ENROLL_MESSAGES[result.status] : ENROLL_MESSAGES.failed);
      if (
        [
          'installed',
          'installed_access_expired',
          'installed_refresh_expired',
          'already_configured',
          'local_blocked'
        ].includes(result.status)
      ) {
        observed = null;
        localStatus.textContent = 'Локальная запись требует повторной проверки.';
        inspectAfter = true;
      }
    } catch {
      if (session.installing) uncertainOutcome(selected);
      else if (!session.controller.signal.aborted)
        progress.textContent =
          'Не удалось начать вход. Доступ в приложении не сохранён; сервис мог сохранить разрешение.';
    } finally {
      operation.finish(uncertain.has(selected));
      if (active === session) {
        active = null;
        setBusy();
        if (inspectAfter && panel.open) await inspect();
      }
    }
  }
  enrollButton?.addEventListener('click', () => void startEnrollment());
  simpleCancel?.addEventListener('click', stop);
  simple?.addEventListener('click', async () => {
    if (!options.desktop || active || resetStarted || uncertain.has(selectedProvider())) return;
    await inspect();
    if (observed?.provider !== selectedProvider()) return;
    const reconnect =
      selectedProvider() === 'google' &&
      ['ready', 'ready_bound', 'pending', 'dataset_incomplete'].includes(observed.status);
    if (!reconnect && observed.status !== 'empty') return;
    await startEnrollment(true, reconnect);
  });
  configFile?.addEventListener('change', async () => {
    const file = configFile.files?.[0];
    configFile.value = '';
    if (!file || !options.desktop || active || resetStarted) return;
    if (file.size > 64 * 1024 || !file.size) {
      if (configStatus) configStatus.textContent = 'Выберите небольшой JSON-файл клиента Google Desktop (до 64 КБ).';
      return;
    }
    let operation;
    try {
      operation = beginCloudCredentialOperation();
    } catch {
      return;
    }
    const session = {
      controller: new AbortController(),
      mode: /** @type {'config'} */ ('config'),
      selected: selectedProvider(),
      installing: false
    };
    active = session;
    setBusy();
    try {
      const native = await loadNative();
      if (resetStarted) return;
      // File text exists only for this IPC call: never stored in app state or logs.
      const json = (await file.text()).replace(/^\uFEFF/, '');
      const problem = googleClientImportProblem(json);
      if (problem) {
        if (configStatus) configStatus.textContent = GOOGLE_IMPORT_MESSAGES[problem];
        return;
      }
      const reply = await native.invoke('cloud_google_client_import', { json });
      if (resetStarted) return;
      if (reply?.status !== 'ready' || !validOAuthClientId('google', reply.clientId)) throw new Error();
      client.value = reply.clientId;
      if (configStatus) configStatus.textContent = 'Google настроен. Теперь нажмите «Войти».';
    } catch (error) {
      const code = typeof error === 'string' ? error : error?.message;
      if (configStatus)
        configStatus.textContent =
          GOOGLE_IMPORT_MESSAGES[code] ||
          'Импорт не подтверждён. Нужен JSON клиента Desktop, не Web. При сохранённой привязке нельзя менять Client ID; старые данные не удаляйте. Повторно проверьте настройки перед входом.';
    } finally {
      operation.finish(false);
      if (active === session) active = null;
      setBusy();
    }
  });
  for (const event of ['tf-cloud-root-confirmed', 'tf-cloud-binding-changed'])
    doc.defaultView?.addEventListener(event, () => {
      if (panel.open) void inspect();
    });

  forgetButton?.addEventListener('click', async () => {
    if (!options.desktop || active || forgetButton.disabled || !forgetApprove?.checked) return;
    const selected = selectedProvider();
    const slotId = observed?.provider === selected && observed.status === 'ready' ? observed.slotId : null;
    if (!slotId) return;
    let operation;
    try {
      operation = beginCloudCredentialOperation();
    } catch {
      progress.textContent = 'Удаление доступа остановлено: выполняется сброс локальных данных.';
      return;
    }
    const session = {
      controller: new AbortController(),
      mode: /** @type {'forget'} */ ('forget'),
      selected,
      installing: false
    };
    active = session;
    if (forgetApprove) forgetApprove.checked = false;
    setBusy();
    progress.textContent = 'Проверяем привязку и удаляем локальный доступ…';
    let forgetStarted = false;
    try {
      const native = await loadNative();
      forgetStarted = true;
      const outcome = await forget({ provider: selected, slotId, invoke: native.invoke, confirmed: true });
      observed = null;
      if (outcome === 'forgotten') {
        localStatus.textContent =
          'Локальная запись удалена. Облачные файлы, ключи и разрешение у сервиса не изменялись.';
        progress.textContent = 'Локальный доступ забыт. Для нового входа снова проверьте локальную запись.';
      } else if (outcome === 'blocked') {
        localStatus.textContent =
          'Удаление заблокировано: привязка набора или запись доступа требует восстановления. Ничего не удалено.';
        progress.textContent = 'Сначала необходимо сохранить и восстановить привязку; не удаляйте её вручную.';
      } else if (outcome === 'mismatch') {
        localStatus.textContent = 'Локальная запись изменилась после проверки. Ничего не удалено.';
        progress.textContent = 'Снова проверьте локальную запись перед любым действием.';
      } else {
        throw new Error();
      }
    } catch {
      if (forgetStarted) uncertainOutcome(selected);
      else progress.textContent = 'Не удалось запустить удаление. Локальная запись не изменялась.';
    } finally {
      operation.finish(uncertain.has(selected));
      if (active === session) {
        active = null;
        setBusy();
      }
    }
  });
}
